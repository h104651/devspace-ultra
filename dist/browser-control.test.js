import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserControlCoordinator, registerBrowserControlTools } from "./browser-control.js";

async function nextCommand(coordinator, bridgeToken, expectedKind) {
    let command;
    const deadline = Date.now() + 2_000;
    do {
        const next = await coordinator.nextBridgeCommand({ bridgeToken, waitMs: 25 });
        command = next.command;
        if (!command)
            await new Promise((resolve) => setTimeout(resolve, 5));
    } while (!command && Date.now() < deadline);
    assert.ok(command, `expected browser bridge command ${expectedKind}`);
    assert.equal(command.kind, expectedKind);
    return command;
}

async function complete(coordinator, bridgeToken, command, result = {}) {
    const response = await coordinator.completeBridgeCommand({
        bridgeToken,
        commandId: command.commandId,
        ok: true,
        result,
    });
    assert.equal(response.ok, true);
}

async function fail(coordinator, bridgeToken, command, message) {
    const response = await coordinator.completeBridgeCommand({
        bridgeToken,
        commandId: command.commandId,
        ok: false,
        error: message,
    });
    assert.equal(response.ok, true);
}

async function coordinatorRestartContinuityGate() {
    const stateDir = await mkdtemp(join(tmpdir(), "devspace-browser-control-restart-"));
    let first = new BrowserControlCoordinator({ stateDir });
    let second;
    try {
        const pairRequest = await first.beginPair({ label: "Restart Chrome", ttlSeconds: 120 });
        const paired = await first.pairBridge({
            code: pairRequest.pairCode,
            instanceKey: "restart-profile-instance",
            label: "Restart Chrome",
            browserSessionId: "restart-browser-session-A",
            capabilities: { debugger: true, accessibility: true, screenshots: true, accessMode: "selected" },
        });
        const tab = {
            tabId: 901,
            windowId: 9,
            url: "https://restart.example.test/work",
            title: "Restart Work",
            active: true,
            shared: true,
            controllable: true,
            tabInstanceKey: "restart-tab-901-A",
        };
        await first.syncBridge({ bridgeToken: paired.bridgeToken, browserSessionId: "restart-browser-session-A", tabs: [tab] });
        const claimPromise = first.claim({ tabId: 901, activate: false, ownerLabel: "restart-agent", leaseSeconds: 600 });
        const attach = await nextCommand(first, paired.bridgeToken, "tab.attach");
        await complete(first, paired.bridgeToken, attach, { attached: true });
        const claim = await claimPromise;

        await first.close();
        first = undefined;
        second = new BrowserControlCoordinator({ stateDir });
        await second.ready;
        await second.syncBridge({ bridgeToken: paired.bridgeToken, browserSessionId: "restart-browser-session-A", tabs: [tab] });
        const touched = await second.touchClaim(claim.claimToken);
        assert.equal(touched.tab.tabId, 901);
        assert.equal(touched.claim.tabInstanceKey, "restart-tab-901-A");

        const releasePromise = second.release(claim.claimToken);
        const detach = await nextCommand(second, paired.bridgeToken, "tab.detach");
        assert.equal(detach.params.tabId, 901);
        await complete(second, paired.bridgeToken, detach, { detached: true });
        const released = await releasePromise;
        assert.equal(released.detached, true);
        return true;
    }
    finally {
        await first?.close().catch(() => {});
        await second?.close().catch(() => {});
        await rm(stateDir, { recursive: true, force: true });
    }
}

async function run() {
    const stateDir = await mkdtemp(join(tmpdir(), "devspace-browser-control-"));
    const coordinator = new BrowserControlCoordinator({ stateDir });
    try {
        const serverRestartClaimContinuity = await coordinatorRestartContinuityGate();
        const registeredTools = [];
        registerBrowserControlTools({
            registerTool(name, definition, handler) {
                registeredTools.push({ name, definition, handler });
            },
        }, coordinator);
        assert.deepEqual(registeredTools.map((item) => item.name), [
            "browser_control_pair",
            "browser_control_status",
            "browser_control_claim",
            "browser_control_release",
            "browser_control_inspect",
            "browser_control_act",
            "browser_control_navigate",
            "browser_control_wait",
            "browser_control_cdp",
        ]);
        assert.equal(registeredTools.every((item) => typeof item.handler === "function"), true);

        const pairedRequest = await coordinator.beginPair({ label: "Test Chrome", ttlSeconds: 120 });
        assert.match(pairedRequest.pairCode, /^[A-F0-9]{24}$/);

        const paired = await coordinator.pairBridge({
            code: pairedRequest.pairCode,
            instanceKey: "test-profile-instance",
            label: "Test Chrome",
            browserSessionId: "browser-session-A",
            capabilities: {
                debugger: true,
                accessibility: true,
                screenshots: true,
                network: true,
                console: true,
                downloads: true,
                developerMode: false,
                accessMode: "selected",
                browserName: "Test Chromium",
            },
        });
        assert.equal(paired.ok, true);
        assert.ok(paired.bridgeToken.length >= 32);

        await assert.rejects(
            () => coordinator.pairBridge({ code: pairedRequest.pairCode, instanceKey: "second" }),
            /Invalid or expired browser-control pair code/,
        );

        await coordinator.syncBridge({
            bridgeToken: paired.bridgeToken,
            browserSessionId: "browser-session-A",
            tabs: [
                {
                    tabId: 101,
                    windowId: 1,
                    url: "https://example.test/form",
                    title: "Example Form",
                    active: true,
                    shared: true,
                    controllable: true,
                    tabInstanceKey: "tab-101-A",
                },
                {
                    tabId: 102,
                    windowId: 1,
                    url: "https://example.test/other",
                    title: "Other Tab",
                    active: false,
                    shared: true,
                    controllable: true,
                    tabInstanceKey: "tab-102-A",
                },
                {
                    tabId: 103,
                    windowId: 1,
                    url: "https://example.test/revocable",
                    title: "Revocable Tab",
                    active: false,
                    shared: true,
                    controllable: true,
                    tabInstanceKey: "tab-103-A",
                },
            ],
        });

        const initialStatus = await coordinator.status();
        assert.equal(initialStatus.bridges.length, 1);
        assert.equal(initialStatus.bridges[0].online, true);
        assert.equal(initialStatus.tabs.length, 3);

        // Every MCP conversation (orchestrator or worker) receives the same browser_control_* tools.
        // Verify three independent MCP sessions can concurrently claim three different shared tabs,
        // while the coordinator keeps each lease and owner isolated.
        const claimTool = registeredTools.find((item) => item.name === "browser_control_claim");
        const multiSessionClaims = [
            claimTool.handler({ tabId: 101, activate: false, leaseSeconds: 300 }, { sessionId: "orchestrator-session-001" }),
            claimTool.handler({ tabId: 102, activate: false, leaseSeconds: 300 }, { sessionId: "worker-session-001" }),
            claimTool.handler({ tabId: 103, activate: false, leaseSeconds: 300 }, { sessionId: "worker-session-002" }),
        ];
        const expectedMultiTabs = new Set([101, 102, 103]);
        for (let i = 0; i < 3; i += 1) {
            const attachCommand = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
            assert.equal(expectedMultiTabs.delete(attachCommand.params.tabId), true);
            assert.match(attachCommand.params.ownerLabel, /^mcp:/);
            await complete(coordinator, paired.bridgeToken, attachCommand, { attached: true });
        }
        assert.equal(expectedMultiTabs.size, 0);
        const multiSessionResults = await Promise.all(multiSessionClaims);
        assert.equal(multiSessionResults.every((item) => item?.isError !== true && item?.structuredContent?.claimToken), true);
        const multiStatus = await coordinator.status();
        assert.equal(multiStatus.activeClaims.length, 3);
        assert.deepEqual(new Set(multiStatus.activeClaims.map((item) => item.tabId)), new Set([101, 102, 103]));
        assert.equal(multiStatus.activeClaims.every((item) => String(item.ownerLabel).startsWith("mcp:")), true);
        const multiReleasePromises = multiSessionResults.map((item) => coordinator.release(item.structuredContent.claimToken));
        for (let i = 0; i < 3; i += 1) {
            const detachCommand = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
            await complete(coordinator, paired.bridgeToken, detachCommand, { detached: true });
        }
        const multiReleaseResults = await Promise.all(multiReleasePromises);
        assert.equal(multiReleaseResults.every((item) => item.detached), true);
        assert.equal((await coordinator.status()).activeClaims.length, 0);

        const claimPromise = coordinator.claim({ tabId: 101, activate: false, ownerLabel: "agent-A", leaseSeconds: 300 });
        const attach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        assert.equal(attach.params.tabId, 101);
        await complete(coordinator, paired.bridgeToken, attach, { attached: true });
        const claim = await claimPromise;
        assert.equal(claim.tab.tabId, 101);
        assert.ok(claim.claimToken.length >= 32);
        const cdpTool = registeredTools.find((item) => item.name === "browser_control_cdp");
        const developerModeRejected = await cdpTool.handler({ claimToken: claim.claimToken, method: "Runtime.evaluate", params: { expression: "1 + 1" } });
        assert.equal(developerModeRejected.isError, true);
        assert.match(developerModeRejected.content[0].text, /Developer mode is disabled/);
        assert.equal(coordinator.commandQueue(paired.bridgeId).length, 0);

        await assert.rejects(
            () => coordinator.claim({ tabId: 101, activate: false, ownerLabel: "agent-B" }),
            /already claimed|No matching unclaimed/,
        );

        const snapshotPromise = coordinator.snapshot(claim.claimToken, 100);
        const snapshotCommand = await nextCommand(coordinator, paired.bridgeToken, "inspect.snapshot");
        await complete(coordinator, paired.bridgeToken, snapshotCommand, {
            title: "Example Form",
            url: "https://example.test/form",
            viewport: { width: 1200, height: 800 },
            nodes: [
                { backendDOMNodeId: 11, depth: 1, role: "heading", name: "Demo Form" },
                { backendDOMNodeId: 12, depth: 2, role: "textbox", name: "Name", value: "" },
                { backendDOMNodeId: 13, depth: 2, role: "button", name: "Submit" },
            ],
        });
        const snapshot = await snapshotPromise;
        assert.equal(snapshot.snapshotId.startsWith("snapshot_"), true);
        assert.match(snapshot.snapshot, /\[e1\] heading "Demo Form"/);
        assert.match(snapshot.snapshot, /\[e2\] textbox "Name"/);
        assert.match(snapshot.snapshot, /\[e3\] button "Submit"/);
        const resolved = await coordinator.resolveRef(claim.claimToken, "e2");
        assert.equal(resolved.target.backendDOMNodeId, 12);

        const actPromise = coordinator.commandForClaim(claim.claimToken, "page.act", {
            action: "fill",
            target: resolved.target,
            text: "DevSpace Ultra",
        });
        const actCommand = await nextCommand(coordinator, paired.bridgeToken, "page.act");
        assert.equal(actCommand.params.target.backendDOMNodeId, 12);
        await complete(coordinator, paired.bridgeToken, actCommand, { message: "Element filled.", value: "DevSpace Ultra" });
        const acted = await actPromise;
        assert.equal(acted.result.value, "DevSpace Ultra");

        const screenshotPromise = coordinator.commandForClaim(claim.claimToken, "inspect.screenshot", { fullPage: false, format: "png" });
        const screenshotCommand = await nextCommand(coordinator, paired.bridgeToken, "inspect.screenshot");
        await complete(coordinator, paired.bridgeToken, screenshotCommand, {
            data: Buffer.from("fake-png").toString("base64"),
            title: "Example Form",
            url: "https://example.test/form",
            width: 1200,
            height: 800,
        });
        const screenshot = await screenshotPromise;
        assert.ok(screenshot.result.data);

        const releasePromise = coordinator.release(claim.claimToken);
        const detach = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
        assert.equal(detach.params.tabId, 101);
        await complete(coordinator, paired.bridgeToken, detach, { detached: true });
        const released = await releasePromise;
        assert.equal(released.detached, true);

        const revocablePromise = coordinator.claim({ tabId: 103, activate: false, ownerLabel: "agent-revocable", leaseSeconds: 300 });
        const revocableAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        assert.equal(revocableAttach.params.tabId, 103);
        await complete(coordinator, paired.bridgeToken, revocableAttach, { attached: true });
        const revocableClaim = await revocablePromise;
        const revokeSync = await coordinator.syncBridge({
            bridgeToken: paired.bridgeToken,
            browserSessionId: "browser-session-A",
            tabs: [
                { tabId: 101, windowId: 1, url: "https://example.test/form", title: "Example Form", active: true, shared: true, controllable: true, tabInstanceKey: "tab-101-A" },
                { tabId: 102, windowId: 1, url: "https://example.test/other", title: "Other Tab", active: false, shared: true, controllable: true, tabInstanceKey: "tab-102-A" },
            ],
        });
        assert.equal(revokeSync.claimsChanged, true);
        assert.deepEqual(revokeSync.revokedClaims, [revocableClaim.claimId]);
        const revokeDetach = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
        assert.equal(revokeDetach.params.tabId, 103);
        await complete(coordinator, paired.bridgeToken, revokeDetach, { detached: true });
        await assert.rejects(() => coordinator.touchClaim(revocableClaim.claimToken), /Invalid browser claim token/);
        await assert.rejects(() => coordinator.claim({ openUrl: "file:///tmp/not-allowed", ownerLabel: "file-agent" }), /Unsupported browser-control URL scheme/);
        await assert.rejects(() => coordinator.claim({ openUrl: "chrome://settings", ownerLabel: "chrome-agent" }), /Unsupported browser-control URL scheme/);

        const openPromise = coordinator.claim({
            openUrl: "https://example.test/new",
            activate: false,
            ownerLabel: "agent-C",
            leaseSeconds: 300,
        });
        const create = await nextCommand(coordinator, paired.bridgeToken, "tab.create");
        assert.equal(create.params.url, "https://example.test/new");
        await complete(coordinator, paired.bridgeToken, create, {
            tab: {
                tabId: 202,
                windowId: 2,
                url: "https://example.test/new",
                title: "New Work Tab",
                active: false,
                shared: true,
                managed: true,
                controllable: true,
                tabInstanceKey: "tab-202-A",
            },
        });
        const attachNew = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        assert.equal(attachNew.params.tabId, 202);
        await complete(coordinator, paired.bridgeToken, attachNew, { attached: true });
        const openedClaim = await openPromise;
        assert.equal(openedClaim.tab.tabId, 202);
        assert.equal(openedClaim.tab.managed, true);

        assert.equal(coordinator.validateCdpMethod("Network.getResponseBody"), "Network.getResponseBody");
        assert.throws(() => coordinator.validateCdpMethod("Browser.close"), /not available/);
        assert.throws(() => coordinator.validateCdpMethod("Network.clearBrowserCookies"), /blocked/);
        assert.throws(() => coordinator.validateCdpMethod("Network.getCookies"), /blocked/);
        assert.throws(() => coordinator.validateCdpMethod("Storage.getCookies"), /blocked/);

        const cdpMethod = coordinator.validateCdpMethod("Runtime.evaluate");
        assert.equal(cdpMethod, "Runtime.evaluate");
        const touched = await coordinator.touchClaim(openedClaim.claimToken);
        assert.equal(touched.bridge.capabilities.developerMode, false);

        const stateText = await readFile(join(stateDir, "browser-control-state.json"), "utf8");
        assert.equal(stateText.includes(pairedRequest.pairCode), false);
        assert.equal(stateText.includes(paired.bridgeToken), false);
        assert.equal(stateText.includes(openedClaim.claimToken), false);
        assert.equal(stateText.includes("https://example.test"), false);
        assert.equal(stateText.includes("Example Form"), false);
        assert.match(stateText, /"tokenHash"/);

        coordinator.state.claims[openedClaim.claimId].expiresAt = new Date(Date.now() - 1000).toISOString();
        const expired = await coordinator.cleanupExpiredClaims();
        assert.equal(expired.length, 1);
        assert.equal(expired[0].id, openedClaim.claimId);
        const expirationDetach = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
        assert.equal(expirationDetach.params.tabId, 202);
        await complete(coordinator, paired.bridgeToken, expirationDetach, { detached: true });
        await assert.rejects(() => coordinator.touchClaim(openedClaim.claimToken), /Invalid browser claim token/);

        const failingManagedOpen = coordinator.claim({
            openUrl: "https://example.test/attach-fails",
            activate: false,
            ownerLabel: "agent-managed-fail",
        });
        const failingCreate = await nextCommand(coordinator, paired.bridgeToken, "tab.create");
        await complete(coordinator, paired.bridgeToken, failingCreate, {
            tab: {
                tabId: 303,
                windowId: 3,
                url: "https://example.test/attach-fails",
                title: "Attach Fails",
                active: false,
                shared: true,
                managed: true,
                controllable: true,
                tabInstanceKey: "tab-303-A",
            },
        });
        const failingManagedAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        assert.equal(failingManagedAttach.params.tabId, 303);
        await fail(coordinator, paired.bridgeToken, failingManagedAttach, "debugger attach refused on managed tab");
        await assert.rejects(() => failingManagedOpen, /debugger attach refused on managed tab/);
        const cleanupClose = await nextCommand(coordinator, paired.bridgeToken, "page.navigate");
        assert.equal(cleanupClose.params.tabId, 303);
        assert.equal(cleanupClose.params.action, "close");
        await complete(coordinator, paired.bridgeToken, cleanupClose, { message: "Chrome tab closed." });
        assert.equal(coordinator.state.bridges[paired.bridgeId].tabs["303"], undefined);

        const failingClaimPromise = coordinator.claim({ tabId: 102, activate: false, ownerLabel: "agent-D" });
        const failingAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        await fail(coordinator, paired.bridgeToken, failingAttach, "debugger attach refused");
        await assert.rejects(() => failingClaimPromise, /debugger attach refused/);
        assert.equal(Object.values(coordinator.state.claims).some((item) => item.tabId === 102), false);

        const tabIdentityClaimPromise = coordinator.claim({ tabId: 102, activate: false, ownerLabel: "agent-tab-identity", leaseSeconds: 300 });
        const tabIdentityAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        await complete(coordinator, paired.bridgeToken, tabIdentityAttach, { attached: true });
        const tabIdentityClaim = await tabIdentityClaimPromise;
        const tabIdentitySync = await coordinator.syncBridge({
            bridgeToken: paired.bridgeToken,
            browserSessionId: "browser-session-A",
            tabs: [
                { tabId: 101, windowId: 1, url: "https://example.test/form", title: "Example Form", active: true, shared: true, controllable: true, tabInstanceKey: "tab-101-A" },
                { tabId: 102, windowId: 1, url: "https://example.test/other", title: "Other Tab Reused", active: false, shared: true, controllable: true, tabInstanceKey: "tab-102-B" },
            ],
        });
        assert.deepEqual(tabIdentitySync.revokedClaims, [tabIdentityClaim.claimId]);
        const tabIdentityDetach = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
        assert.equal(tabIdentityDetach.params.tabId, 102);
        await complete(coordinator, paired.bridgeToken, tabIdentityDetach, { detached: true });
        await assert.rejects(() => coordinator.touchClaim(tabIdentityClaim.claimToken), /Invalid browser claim token/);

        const sessionClaimPromise = coordinator.claim({ tabId: 102, activate: false, ownerLabel: "agent-session-identity", leaseSeconds: 300 });
        const sessionAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        await complete(coordinator, paired.bridgeToken, sessionAttach, { attached: true });
        const sessionClaim = await sessionClaimPromise;
        const sessionSync = await coordinator.syncBridge({
            bridgeToken: paired.bridgeToken,
            browserSessionId: "browser-session-B",
            tabs: [
                { tabId: 101, windowId: 1, url: "https://example.test/form", title: "Example Form", active: true, shared: true, controllable: true, tabInstanceKey: "tab-101-A" },
                { tabId: 102, windowId: 1, url: "https://example.test/other", title: "Other Tab Reused", active: false, shared: true, controllable: true, tabInstanceKey: "tab-102-B" },
            ],
        });
        assert.deepEqual(sessionSync.revokedClaims, [sessionClaim.claimId]);
        const sessionDetach = await nextCommand(coordinator, paired.bridgeToken, "tab.detach");
        assert.equal(sessionDetach.params.tabId, 102);
        await complete(coordinator, paired.bridgeToken, sessionDetach, { detached: true });
        await assert.rejects(() => coordinator.touchClaim(sessionClaim.claimToken), /Invalid browser claim token/);

        const rePairClaimPromise = coordinator.claim({ tabId: 102, activate: false, ownerLabel: "agent-before-repair", leaseSeconds: 300 });
        const rePairAttach = await nextCommand(coordinator, paired.bridgeToken, "tab.attach");
        await complete(coordinator, paired.bridgeToken, rePairAttach, { attached: true });
        const rePairClaim = await rePairClaimPromise;
        const rePairRequest = await coordinator.beginPair({ label: "Test Chrome Repaired", ttlSeconds: 120 });
        const rePaired = await coordinator.pairBridge({
            code: rePairRequest.pairCode,
            instanceKey: "test-profile-instance",
            label: "Test Chrome Repaired",
            browserSessionId: "browser-session-C",
            capabilities: { debugger: true, accessibility: true, screenshots: true, accessMode: "selected" },
        });
        assert.equal(rePaired.bridgeId, paired.bridgeId);
        assert.notEqual(rePaired.bridgeToken, paired.bridgeToken);
        await assert.rejects(() => coordinator.touchClaim(rePairClaim.claimToken), /Invalid browser claim token/);
        await assert.rejects(() => coordinator.syncBridge({ bridgeToken: paired.bridgeToken, tabs: [] }), /Invalid browser bridge token/);

        const finalStatus = await coordinator.status();
        assert.equal(finalStatus.activeClaims.length, 0);
        assert.equal(finalStatus.tabs.length, 0);

        console.log(JSON.stringify({
            ok: true,
            paired: true,
            tabs: initialStatus.tabs.length,
            exclusiveClaim: true,
            multiMcpSessionClaims: 3,
            semanticRefs: snapshot.nodes.filter((node) => node.ref).length,
            screenshot: true,
            openNewTab: true,
            expiredClaimCleanup: true,
            rawSecretsPersisted: false,
            attachFailureSafe: true,
            unshareRevokesClaim: true,
            failedManagedAttachClosesTab: true,
            rePairRevokesClaims: true,
            tabInstanceReuseRevokesClaim: true,
            browserSessionChangeRevokesClaims: true,
            mcpToolRegistration: registeredTools.length,
            developerModeCdpGuard: true,
            serverRestartClaimContinuity,
        }));
    }
    finally {
        await coordinator.close();
        await rm(stateDir, { recursive: true, force: true });
    }
}

await run();
