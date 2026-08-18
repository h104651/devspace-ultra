import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSwarmCoordinator } from "./chat-swarm.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), "devspace-chat-swarm-"));

try {
    const c = new ChatSwarmCoordinator({ stateDir: temp });
    const created = await c.create({ name: "test", workerSlots: 9, peer: { identitySource: "test" } });
    assert.equal(created.workerSlots, 9);

    const workers = [];
    for (let i = 0; i < 9; i++) {
        workers.push(await c.join({
            inviteCode: created.inviteCode,
            label: `w${i + 1}`,
            peer: { identitySource: "test", identityFingerprint: String(i + 1) },
        }));
    }
    assert.equal((await c.status(created.orchestratorToken)).activeWorkers, 9);

    // Wave 1: all nine workers park before the orchestrator fans out nine jobs.
    const waits1 = workers.map((worker) => c.next({ workerToken: worker.workerToken, waitMs: 1_000 }));
    await sleep(20);
    const wave1 = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: Array.from({ length: 9 }, (_, i) => ({ prompt: `wave1-${i + 1}`, taskKey: `w1-${i + 1}` })),
    });
    const claimed1 = await Promise.all(waits1);
    assert.equal(claimed1.filter((item) => item.state === "task").length, 9);
    assert.equal(new Set(claimed1.map((item) => item.workerId)).size, 9);
    await Promise.all(claimed1.map((item, i) => c.submit({
        workerToken: workers[i].workerToken,
        taskId: item.task.taskId,
        status: "completed",
        result: `result-${i + 1}`,
        waitForNextMs: 0,
    })));
    const collected1 = await c.collect({
        orchestratorToken: created.orchestratorToken,
        taskIds: wave1.tasks.map((task) => task.taskId),
        waitFor: "all",
        waitMs: 1_000,
    });
    assert.equal(collected1.complete, true);

    // Wave 2: same workers can park again without rejoining.
    const waits2 = workers.map((worker) => c.next({ workerToken: worker.workerToken, waitMs: 1_000 }));
    await sleep(20);
    await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: workers.map((worker, i) => ({
            prompt: `wave2-${i + 1}`,
            targetWorkerId: worker.workerId,
            taskKey: `w2-${i + 1}`,
        })),
    });
    const claimed2 = await Promise.all(waits2);
    assert.equal(claimed2.filter((item) => item.state === "task").length, 9);
    assert.deepEqual(claimed2.map((item) => item.workerId).sort(), workers.map((item) => item.workerId).sort());
    await Promise.all(claimed2.map((item) => {
        const worker = workers.find((candidate) => candidate.workerId === item.workerId);
        return c.submit({ workerToken: worker.workerToken, taskId: item.task.taskId, status: "completed", result: "ok", waitForNextMs: 0 });
    }));

    // Compatibility execution ACK: the already-existing worker status call marks
    // a claimed task as actually started, so stale-resume fallback never interrupts
    // a healthy complex task even when the client has a cached tool schema.
    const statusAckWorker = workers[2];
    const statusAckDispatch = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "status-ack", targetWorkerId: statusAckWorker.workerId, taskKey: "status-ack" }],
    });
    const statusAckClaim = await c.next({ workerToken: statusAckWorker.workerToken, waitMs: 0 });
    assert.equal(statusAckClaim.task.executionStartedAt, undefined);
    await c.status(statusAckWorker.workerToken);
    const statusAckSnapshot = await c.collect({
        orchestratorToken: created.orchestratorToken,
        taskIds: [statusAckDispatch.tasks[0].taskId],
        waitFor: "none",
        waitMs: 0,
    });
    assert.ok(statusAckSnapshot.tasks[0].executionStartedAt);
    await c.submit({
        workerToken: statusAckWorker.workerToken,
        taskId: statusAckDispatch.tasks[0].taskId,
        status: "completed",
        result: "status-ack-ok",
        waitForNextMs: 0,
    });

    // Worker Dock routing: two generic queued tasks reserve exactly two idle workers.
    const dockWave = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [
            { prompt: "dock-generic-a", taskKey: "dock-generic-a" },
            { prompt: "dock-generic-b", taskKey: "dock-generic-b" },
        ],
    });
    const dockWakes = await Promise.all(workers.map((worker) => c.reserveWorkerWake(worker.workerToken)));
    const dockReady = dockWakes.filter((item) => item.state === "task_available");
    assert.equal(dockReady.length, 2);
    assert.equal(new Set(dockReady.map((item) => item.taskId)).size, 2);
    assert.deepEqual(new Set(dockReady.map((item) => item.taskId)), new Set(dockWave.tasks.map((item) => item.taskId)));
    for (const wake of dockReady) {
        const worker = workers.find((candidate) => candidate.workerId === wake.workerId);
        const claim = await c.next({ workerToken: worker.workerToken, waitMs: 0 });
        assert.equal(claim.state, "task");
        assert.equal(claim.task.taskId, wake.taskId);
        await c.submit({ workerToken: worker.workerToken, taskId: claim.task.taskId, status: "completed", result: "dock-ok", waitForNextMs: 0 });
    }

    // Targeted Dock routing wakes only the designated worker.
    const dockTarget = workers[4];
    const dockTargetTask = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "dock-target", targetWorkerId: dockTarget.workerId, taskKey: "dock-target" }],
    });
    const targetWakes = await Promise.all(workers.map((worker) => c.reserveWorkerWake(worker.workerToken)));
    const targetReady = targetWakes.filter((item) => item.state === "task_available");
    assert.equal(targetReady.length, 1);
    assert.equal(targetReady[0].workerId, dockTarget.workerId);
    assert.equal(targetReady[0].taskId, dockTargetTask.tasks[0].taskId);
    const targetClaim = await c.next({ workerToken: dockTarget.workerToken, waitMs: 0 });
    assert.equal(targetClaim.task.taskId, dockTargetTask.tasks[0].taskId);
    await c.submit({ workerToken: dockTarget.workerToken, taskId: targetClaim.task.taskId, status: "completed", result: "dock-target-ok", waitForNextMs: 0 });

    // Browser wake bridge: a one-time bind code yields a browser wake token,
    // which can stay connected without holding a ChatGPT turn open.
    const browserWorker = workers[6];
    const browserBinding = await c.enableBrowserWake(browserWorker.workerToken);
    assert.ok(browserBinding.bindCode.length >= 16);
    const browserBound = await c.bindBrowser(browserBinding.bindCode);
    assert.equal(browserBound.workerId, browserWorker.workerId);
    assert.ok(browserBound.browserWakeToken.length >= 16);
    await c.setBrowserOnline(browserBound.browserWakeToken, true);
    const browserTask = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "browser-wake", targetWorkerId: browserWorker.workerId, taskKey: "browser-wake" }],
    });
    const browserWake = await c.reserveBrowserWake(browserBound.browserWakeToken);
    assert.equal(browserWake.state, "task_available");
    assert.equal(browserWake.taskId, browserTask.tasks[0].taskId);
    const browserClaim = await c.next({ workerToken: browserWorker.workerToken, waitMs: 0 });
    assert.equal(browserClaim.task.taskId, browserTask.tasks[0].taskId);
    await c.submit({ workerToken: browserWorker.workerToken, taskId: browserClaim.task.taskId, status: "completed", result: "browser-ok", waitForNextMs: 0 });
    const browserStatus = await c.status(created.orchestratorToken);
    assert.equal(browserStatus.workers.find((item) => item.workerId === browserWorker.workerId)?.browserOnline, true);
    await c.setBrowserOnline(browserBound.browserWakeToken, false);

    // Infinite wait has no timer: it stays parked until explicitly aborted,
    // work arrives, or the swarm closes. Aborting must cleanly release it.
    const abortController = new AbortController();
    let foreverSettled = false;
    const foreverWait = c.next({
        workerToken: workers[8].workerToken,
        waitMs: -1,
        signal: abortController.signal,
    }).finally(() => {
        foreverSettled = true;
    });
    await sleep(80);
    assert.equal(foreverSettled, false);
    abortController.abort();
    await assert.rejects(foreverWait, /aborted by client/i);

    // Submit/re-park lifecycle: submitting one result can keep the same worker
    // parked indefinitely and hand the next task back through the same worker turn.
    const reparkWorker = workers[0];
    const repark1 = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "repark-1", targetWorkerId: reparkWorker.workerId, taskKey: "repark-1" }],
    });
    const reparkClaim1 = await c.next({ workerToken: reparkWorker.workerToken, waitMs: 0 });
    assert.equal(reparkClaim1.state, "task");
    assert.equal(reparkClaim1.task.taskId, repark1.tasks[0].taskId);
    const reparkSubmit = c.submit({
        workerToken: reparkWorker.workerToken,
        taskId: reparkClaim1.task.taskId,
        status: "completed",
        result: "repark-ok-1",
        waitForNextMs: -1,
    });
    await sleep(20);
    const repark2 = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "repark-2", targetWorkerId: reparkWorker.workerId, taskKey: "repark-2" }],
    });
    const reparkResponse = await reparkSubmit;
    assert.equal(reparkResponse.next?.state, "task");
    assert.equal(reparkResponse.next?.task.taskId, repark2.tasks[0].taskId);
    await c.submit({
        workerToken: reparkWorker.workerToken,
        taskId: reparkResponse.next.task.taskId,
        status: "completed",
        result: "repark-ok-2",
        waitForNextMs: 0,
    });

    // Sparse wave: only two of nine parked workers should wake for two generic jobs.
    const sparseWaits = workers.map((worker) => c.next({ workerToken: worker.workerToken, waitMs: 180 }));
    await sleep(20);
    await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "sparse-a", taskKey: "sparse-a" }, { prompt: "sparse-b", taskKey: "sparse-b" }],
    });
    const sparse = await Promise.all(sparseWaits);
    assert.equal(sparse.filter((item) => item.state === "task").length, 2);
    assert.equal(sparse.filter((item) => item.state === "idle").length, 7);
    for (const item of sparse.filter((entry) => entry.state === "task")) {
        const worker = workers.find((candidate) => candidate.workerId === item.workerId);
        await c.submit({ workerToken: worker.workerToken, taskId: item.task.taskId, status: "completed", result: "sparse-ok", waitForNextMs: 0 });
    }

    // Live resize: shrink only idle workers, preserve the rest, then expand and
    // let the removed worker conversations rejoin the same slots.
    const shrink = await c.resize({ orchestratorToken: created.orchestratorToken, workerSlots: 7 });
    assert.equal(shrink.previousWorkerSlots, 9);
    assert.equal(shrink.workerSlots, 7);
    assert.equal(shrink.removedWorkers.length, 2);
    assert.deepEqual(shrink.removedWorkers.map((item) => item.workerId).sort(), ["worker-08", "worker-09"]);
    assert.equal((await c.status(created.orchestratorToken)).activeWorkers, 7);
    const expand = await c.resize({ orchestratorToken: created.orchestratorToken, workerSlots: 9 });
    assert.equal(expand.workerSlots, 9);
    const rejoined8 = await c.join({ inviteCode: created.inviteCode, label: "w8-rejoined", peer: { identitySource: "test" } });
    const rejoined9 = await c.join({ inviteCode: created.inviteCode, label: "w9-rejoined", peer: { identitySource: "test" } });
    assert.equal(rejoined8.workerId, "worker-08");
    assert.equal(rejoined9.workerId, "worker-09");
    workers[7] = rejoined8;
    workers[8] = rejoined9;
    assert.equal((await c.status(created.orchestratorToken)).activeWorkers, 9);

    // Busy tail safety: shrinking must fail rather than evict a lower idle slot
    // around a tail worker whose targeted task has started executing.
    const busyTail = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "busy-tail", targetWorkerId: workers[8].workerId, taskKey: "busy-tail" }],
    });
    const busyTailClaim = await c.next({ workerToken: workers[8].workerToken, waitMs: 0 });
    assert.equal(busyTailClaim.task.taskId, busyTail.tasks[0].taskId);
    await c.status(workers[8].workerToken);
    await assert.rejects(
        () => c.resize({ orchestratorToken: created.orchestratorToken, workerSlots: 8 }),
        /required tail workers are busy or targeted/,
    );
    assert.equal((await c.status(created.orchestratorToken)).activeWorkers, 9);
    await c.submit({
        workerToken: workers[8].workerToken,
        taskId: busyTail.tasks[0].taskId,
        status: "completed",
        result: "busy-tail-ok",
        waitForNextMs: 0,
    });

    // Idempotent retry by taskKey must return the same task, not duplicate it.
    const retry1 = await c.dispatch({ orchestratorToken: created.orchestratorToken, tasks: [{ prompt: "retry", taskKey: "retry-key" }] });
    const retry2 = await c.dispatch({ orchestratorToken: created.orchestratorToken, tasks: [{ prompt: "retry", taskKey: "retry-key" }] });
    assert.equal(retry1.tasks[0].taskId, retry2.tasks[0].taskId);
    await assert.rejects(
        () => c.dispatch({ orchestratorToken: created.orchestratorToken, tasks: [{ prompt: "different", taskKey: "retry-key" }] }),
        /different task content/,
    );
    await c.cancel({ orchestratorToken: created.orchestratorToken, taskIds: [retry1.tasks[0].taskId], reason: "test cleanup" });

    // Cancel and leave/replacement slot behavior.
    const cancellable = await c.dispatch({ orchestratorToken: created.orchestratorToken, tasks: [{ prompt: "cancel-me", targetWorkerId: workers[0].workerId }] });
    await c.cancel({ orchestratorToken: created.orchestratorToken, taskIds: [cancellable.tasks[0].taskId], reason: "test" });
    const cancelled = await c.collect({ orchestratorToken: created.orchestratorToken, taskIds: [cancellable.tasks[0].taskId], waitFor: "all", waitMs: 0 });
    assert.equal(cancelled.tasks[0].status, "cancelled");

    // Orchestrator recycle: an unstarted claimed task is safely requeued and the
    // replacement conversation reuses the same lowest free worker slot.
    const recycleWorker = workers[7];
    const recycleTask = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "recycle-me", targetWorkerId: recycleWorker.workerId, taskKey: "recycle-me" }],
    });
    const recycleClaim = await c.next({ workerToken: recycleWorker.workerToken, waitMs: 0 });
    assert.equal(recycleClaim.task.taskId, recycleTask.tasks[0].taskId);
    const recycled = await c.recycleWorker({
        orchestratorToken: created.orchestratorToken,
        workerId: recycleWorker.workerId,
        reason: "test dead runtime",
    });
    assert.equal(recycled.requeuedTask.taskId, recycleTask.tasks[0].taskId);
    await assert.rejects(() => c.next({ workerToken: recycleWorker.workerToken, waitMs: 0 }), /Invalid or inactive worker token/);
    const recycleReplacement = await c.join({ inviteCode: created.inviteCode, label: "recycle-replacement", peer: { identitySource: "test" } });
    assert.equal(recycleReplacement.workerId, recycleWorker.workerId);
    workers[7] = recycleReplacement;
    const recycleReclaim = await c.next({ workerToken: recycleReplacement.workerToken, waitMs: 0 });
    assert.equal(recycleReclaim.task.taskId, recycleTask.tasks[0].taskId);
    await c.submit({ workerToken: recycleReplacement.workerToken, taskId: recycleReclaim.task.taskId, status: "completed", result: "recycle-ok", waitForNextMs: 0 });

    // Once execution has been acknowledged, recycle is guarded unless the
    // orchestrator explicitly confirms that the runtime is gone with force=true.
    const guardedWorker = workers[6];
    const guardedTask = await c.dispatch({
        orchestratorToken: created.orchestratorToken,
        tasks: [{ prompt: "guarded-recycle", targetWorkerId: guardedWorker.workerId, taskKey: "guarded-recycle" }],
    });
    const guardedClaim = await c.next({ workerToken: guardedWorker.workerToken, waitMs: 0 });
    await c.status(guardedWorker.workerToken);
    await assert.rejects(
        () => c.recycleWorker({ orchestratorToken: created.orchestratorToken, workerId: guardedWorker.workerId }),
        /execution already started; refuse recycle without force/,
    );
    const forcedRecycle = await c.recycleWorker({
        orchestratorToken: created.orchestratorToken,
        workerId: guardedWorker.workerId,
        force: true,
        reason: "test confirmed dead runtime",
    });
    assert.equal(forcedRecycle.forced, true);
    assert.equal(forcedRecycle.requeuedTask.taskId, guardedTask.tasks[0].taskId);
    const forcedReplacement = await c.join({ inviteCode: created.inviteCode, label: "forced-replacement", peer: { identitySource: "test" } });
    assert.equal(forcedReplacement.workerId, guardedWorker.workerId);
    workers[6] = forcedReplacement;
    const forcedReclaim = await c.next({ workerToken: forcedReplacement.workerToken, waitMs: 0 });
    assert.equal(forcedReclaim.task.taskId, guardedClaim.task.taskId);
    await c.submit({ workerToken: forcedReplacement.workerToken, taskId: forcedReclaim.task.taskId, status: "completed", result: "forced-recycle-ok", waitForNextMs: 0 });

    const leftId = workers[8].workerId;
    await c.leave({ workerToken: workers[8].workerToken });
    const replacement = await c.join({ inviteCode: created.inviteCode, label: "replacement", peer: { identitySource: "test" } });
    assert.equal(replacement.workerId, leftId);
    workers[8] = replacement;

    // Persistence: tokens survive a coordinator restart and claimed work is requeued.
    const persistenceTask = await c.dispatch({ orchestratorToken: created.orchestratorToken, tasks: [{ prompt: "persist", targetWorkerId: workers[0].workerId, taskKey: "persist" }] });
    const claimPersist = await c.next({ workerToken: workers[0].workerToken, waitMs: 0 });
    assert.equal(claimPersist.task.taskId, persistenceTask.tasks[0].taskId);
    await c.close();

    const c2 = new ChatSwarmCoordinator({ stateDir: temp });
    const afterRestart = await c2.status(created.orchestratorToken);
    assert.equal(afterRestart.activeWorkers, 9);
    const reclaimed = await c2.next({ workerToken: workers[0].workerToken, waitMs: 0 });
    assert.equal(reclaimed.state, "task");
    assert.equal(reclaimed.task.taskId, persistenceTask.tasks[0].taskId);
    await c2.submit({ workerToken: workers[0].workerToken, taskId: reclaimed.task.taskId, status: "completed", result: "persist-ok", waitForNextMs: 0 });

    const closeWaits = [workers[1], workers[2], workers[3]].map((worker, index) => c2.next({ workerToken: worker.workerToken, waitMs: index === 0 ? -1 : 1_000 }));
    await sleep(20);
    await c2.closeSwarm({ orchestratorToken: created.orchestratorToken, cancelPending: true });
    const closedWorkers = await Promise.all(closeWaits);
    assert.equal(closedWorkers.filter((item) => item.state === "closed").length, 3);
    await assert.rejects(() => c2.join({ inviteCode: created.inviteCode, peer: {} }), /invalid or the swarm is closed/);
    await c2.close();

    console.log(JSON.stringify({
        ok: true,
        workers: 9,
        wave1Completed: 9,
        wave2Completed: 9,
        workerDockGenericReserved: 2,
        workerDockTargetedReserved: 1,
        infiniteWait: true,
        infiniteWaitAbortCleanup: true,
        submitRepark: true,
        sparseAwake: 2,
        sparseParked: 7,
        idempotentRetry: true,
        persistence: true,
        closeWokeWorkers: 3,
    }));
}
finally {
    await rm(temp, { recursive: true, force: true });
}
