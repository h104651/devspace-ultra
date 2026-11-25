import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { CloudflareR2ArtifactStorage, R2Bucket } from '../../src/cloudflare/r2-artifact-storage';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { AuthManager } from '../../src/security/auth-manager';
import { KillSwitch } from '../../src/security/kill-switch';
import { TaskStore } from '../../src/storage/task-store';
import { GatewayServer } from '../../src/gateway/server';
import { LeaseMonitor } from '../../src/gateway/lease-monitor';
import { ConnectionManager } from '../../src/gateway/connection-manager';
import { AuditLogger } from '../../src/security/audit-logger';
import { LocalAgentClient } from '../../src/local-agent/client';
import {
  isSessionHealthy,
  HEARTBEAT_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  AgentSessionAttachment
} from '../../src/gateway/connection-health-policy';
import { isSideEffectCapability } from '../../src/local-agent/capabilities';

// In-memory SQLite Mock for DO testing
class MockSqlStorage implements SqlStorage {
  public tables: Map<string, Map<string, any>> = new Map();
  public failTaskWrites = false;

  private mapTask(row: any[]) {
    return {
      taskId: row[0], taskKey: row[1], idempotencyKey: row[2], clientRequestId: row[3],
      backend: row[4], capability: row[5], requiredScope: row[6], status: row[7],
      priority: row[8], payloadJson: row[9], retryPolicyJson: row[10], leaseJson: row[11],
      resultJson: row[12], errorJson: row[13], artifactsJson: row[14], logsJson: row[15],
      metadataJson: row[16], startedAt: row[17], completedAt: row[18], createdAt: row[19], updatedAt: row[20],
      attemptsJson: row[21], activeAttemptId: row[22], externalRunJson: row[23], targetDeviceId: row[24]
    };
  }

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const q = query.trim().toUpperCase();

    if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX') || q.startsWith('ALTER TABLE')) {
      const match = query.match(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
      if (match && !this.tables.has(match[1])) this.tables.set(match[1], new Map());
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('INSERT') || q.startsWith('INSERT OR REPLACE')) {
      const match = query.match(/INTO\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        if (tableName.toLowerCase() === 'tasks' && this.failTaskWrites) throw new Error('Injected SQLite task write failure');
        if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
        this.tables.get(tableName)!.set(String(params[0]), params);
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('DELETE')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (match) this.tables.get(match[1])?.delete(String(params[0]));
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('UPDATE')) {
      const match = query.match(/UPDATE\s+([a-zA-Z0-9_]+)/i);
      if (match && match[1] === 'devices') {
        const table = this.tables.get('devices');
        if (table) {
          if (query.includes('lastHeartbeatAt')) {
            const [hb, devId] = params;
            const row = table.get(String(devId));
            if (row) {
              row[7] = Math.max(Number(row[7]) || 0, Number(hb));
            }
          } else if (query.includes('lastConnectedAt')) {
            const [status, connAt, devId] = params;
            const row = table.get(String(devId));
            if (row) {
              row[3] = status;
              row[6] = connAt;
            }
          } else if (query.includes('status')) {
            const [status, devId] = params;
            const row = table.get(String(devId));
            if (row) {
              row[3] = status;
            }
          }
        }
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('SELECT')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!match) return { toArray: () => [], one: () => null, raw: () => [] };
      const tableName = match[1];
      const table = this.tables.get(tableName) || new Map();
      const allRows = Array.from(table.values());

      if (tableName === 'devices') {
        const mapped = allRows.map(r => ({
          deviceId: r[0], name: r[1], platform: r[2], status: r[3],
          capabilitiesJson: r[4], registeredAt: r[5], lastConnectedAt: r[6],
          lastHeartbeatAt: r[7], revokedAt: r[8], revocationReason: r[9],
          tokenHash: r[10], ip: r[11], activeTokenId: r[12]
        }));
        if (/WHERE\s+DEVICEID\s*=\s*\?/i.test(query)) {
          const filtered = mapped.filter(d => d.deviceId === String(params[0]));
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered[0] || null };
        }
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped[0] || null };
      }

      if (tableName === 'tasks') {
        const mapped = allRows.map(r => this.mapTask(r));
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped[0] || null };
      }

      return { toArray: () => allRows, one: () => allRows[0] || null, raw: () => allRows[0] || null };
    }

    return { toArray: () => [], one: () => null, raw: () => null };
  }
}

class MockDOWebSocket {
  private attachment: any = null;
  public sentMessages: any[] = [];
  public closed = false;
  public closeCode?: number;
  public closeReason?: string;

  serializeAttachment(att: any) { this.attachment = structuredClone(att); }
  deserializeAttachment() { return this.attachment ? structuredClone(this.attachment) : null; }
  send(data: string) { this.sentMessages.push(JSON.parse(data)); }
  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

function createDOContext(sql: SqlStorage, kv: Map<string, any>, webSockets: MockDOWebSocket[]) {
  return {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: any) => { kv.set(key, structuredClone(value)); },
      setAlarm: async (when: number) => { kv.set('alarm', when); },
      deleteAlarm: async () => { kv.delete('alarm'); }
    },
    getWebSockets: () => webSockets.filter(ws => !ws.closed),
    acceptWebSocket: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
  };
}

export async function runConnectionLifecycleFencingTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testMasterSecret = 'super-secret-master-test-key-32chars!!';

  // Helper to setup GatewayDurableObject
  function setupTestDO() {
    const sql = new MockSqlStorage();
    const kv = new Map<string, any>();
    const webSockets: MockDOWebSocket[] = [];
    const ctx = createDOContext(sql, kv, webSockets);
    const env = { MASTER_SECRET: testMasterSecret };
    const gateway = new GatewayDurableObject(ctx, env as any);
    return { gateway, sql, kv, webSockets, ctx };
  }

  console.log('\n--- Running Connection Lifecycle & Session Fencing Tests (T01-T24) ---');

  // =========================================================================
  // T01: 正常註冊與心跳 (Normal registration & heartbeat)
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 1', 'windows', ['local:read_file', 'local:git_status']);

    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);

    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      platform: 'windows',
      capabilities: ['local:read_file', 'local:git_status']
    }));

    assert.strictEqual(ws1.sentMessages.length, 1);
    const regAck = ws1.sentMessages[0];
    assert.strictEqual(regAck.type, 'AGENT_REGISTERED');
    assert.strictEqual(regAck.deviceId, deviceId);
    assert.ok(regAck.sessionId, 'SessionId must be assigned');

    const att = ws1.deserializeAttachment();
    assert.strictEqual(att.sessionId, regAck.sessionId);
    assert.strictEqual(att.deviceId, deviceId);

    // Send Heartbeat
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_HEARTBEAT',
      deviceId
    }));

    assert.strictEqual(ws1.sentMessages.length, 2);
    assert.strictEqual(ws1.sentMessages[1].type, 'AGENT_HEARTBEAT_ACK');
    passed++;
  } catch (err: any) {
    console.error('T01 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T02: 正常 WebSocket Close
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 2', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    assert.strictEqual(auth.getDevice(deviceId)?.status, 'online');

    // Orderly Close
    await gateway.webSocketClose(ws as any, 1000, 'Normal shutdown');
    assert.strictEqual(auth.getDevice(deviceId)?.status, 'offline');
    passed++;
  } catch (err: any) {
    console.error('T02 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T03: 強制終止 Agent (Abrupt drop / TerminateProcess)
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 3', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Client dies without close frame. Sockets in edge proxy still exist.
    // However, heartbeat ceases. After 45s, watchdog evicts the socket.
    const now = Date.now() + 50_000;
    await (gateway as any).runWatchdogStaleEviction(now);

    assert.strictEqual(ws.closed, true);
    assert.strictEqual(ws.closeReason, 'Heartbeat timeout');
    assert.strictEqual(auth.getDevice(deviceId)?.status, 'offline');
    passed++;
  } catch (err: any) {
    console.error('T03 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T04: 網路突然中斷 (Sudden network silence)
  // =========================================================================
  try {
    const session: AgentSessionAttachment = {
      sessionId: 'sess-1',
      deviceId: 'dev-1',
      name: 'node',
      platform: 'windows',
      capabilities: ['local:read_file'],
      connectedAt: 1000,
      lastHeartbeatAt: 1000
    };
    // Network silent for 40s -> still healthy (under 45s TTL)
    assert.strictEqual(isSessionHealthy(session, 41_000, HEARTBEAT_TTL_MS), true);
    // Network silent for 50s -> stale!
    assert.strictEqual(isSessionHealthy(session, 51_000, HEARTBEAT_TTL_MS), false);
    passed++;
  } catch (err: any) {
    console.error('T04 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T05: Heartbeat TTL 邊界值 (Boundary conditions: 44.9s vs 45.1s)
  // =========================================================================
  try {
    const baseTime = 100_000;
    const session: AgentSessionAttachment = {
      sessionId: 'sess-b',
      deviceId: 'dev-b',
      name: 'node',
      platform: 'windows',
      capabilities: [],
      connectedAt: baseTime,
      lastHeartbeatAt: baseTime
    };

    // Exactly 44,999ms elapsed -> healthy
    assert.strictEqual(isSessionHealthy(session, baseTime + 44_999, 45_000), true);
    // Exactly 45,000ms elapsed -> healthy (inclusive threshold)
    assert.strictEqual(isSessionHealthy(session, baseTime + 45_000, 45_000), true);
    // 45,001ms elapsed -> stale!
    assert.strictEqual(isSessionHealthy(session, baseTime + 45_001, 45_000), false);
    passed++;
  } catch (err: any) {
    console.error('T05 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T06: Stale Socket 仍存在時，裝置被正確判定 Offline
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 6', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Backdate attachment heartbeat to 60 seconds ago without closing the socket
    const att = ws.deserializeAttachment();
    att.lastHeartbeatAt = Date.now() - 60_000;
    ws.serializeAttachment(att);

    // Call handleDeviceStatus via MCP with admin caller context
    const caller = { scopes: ['admin'], actorId: 'admin-test', type: 'client' as const };
    const statusResult = await (gateway as any).mcpHandlers.handleDeviceStatus({ deviceId }, caller);
    const devEntry = statusResult.devices.find((d: any) => d.deviceId === deviceId);
    assert.ok(devEntry);
    assert.strictEqual(devEntry.status, 'offline', 'Stale socket must result in status offline');
    assert.strictEqual(statusResult.totalOnline, 0, 'Total online must be 0 when socket is stale');
    passed++;
  } catch (err: any) {
    console.error('T06 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T07: 相同 Device ID 重複註冊 (Healthy incumbent remains authoritative)
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 7', 'windows', ['local:read_file']);

    // 1st Connection
    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));
    const s1Id = ws1.sentMessages[0].sessionId;

    // 2nd Connection for same device
    const ws2 = new MockDOWebSocket();
    webSockets.push(ws2);
    await gateway.webSocketMessage(ws2 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));
    assert.strictEqual(ws1.closed, false, 'Healthy incumbent must not be evicted');
    assert.strictEqual(ws2.closed, true, 'Duplicate newcomer must be rejected');
    assert.strictEqual(ws2.closeCode, 1008);
    assert.strictEqual((gateway as any).getActiveSession(deviceId)?.sessionId, s1Id);
    passed++;
  } catch (err: any) {
    console.error('T07 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T08: 新 Session 建立後，舊 Close Event 延遲抵達 (Delayed close from old session)
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 8', 'windows', ['local:read_file']);

    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Expire the incumbent without closing the underlying edge socket.
    const staleAttachment = ws1.deserializeAttachment();
    staleAttachment.lastHeartbeatAt = Date.now() - HEARTBEAT_TTL_MS - 1000;
    ws1.serializeAttachment(staleAttachment);

    const ws2 = new MockDOWebSocket();
    webSockets.push(ws2);
    await gateway.webSocketMessage(ws2 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    assert.strictEqual(auth.getDevice(deviceId)?.status, 'online');

    // Delayed close event for ws1 arrives now!
    await gateway.webSocketClose(ws1 as any, 1008, 'Superseded by new registration');

    // Device must NOT be marked offline because ws2 is active!
    assert.strictEqual(auth.getDevice(deviceId)?.status, 'online');
    passed++;
  } catch (err: any) {
    console.error('T08 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T09: 舊 Session Heartbeat 不得覆蓋新 Session
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 9', 'windows', ['local:read_file']);

    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Expire the incumbent without closing the underlying edge socket.
    const staleAttachment = ws1.deserializeAttachment();
    staleAttachment.lastHeartbeatAt = Date.now() - HEARTBEAT_TTL_MS - 1000;
    ws1.serializeAttachment(staleAttachment);

    const ws2 = new MockDOWebSocket();
    webSockets.push(ws2);
    await gateway.webSocketMessage(ws2 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // ws1 attempts to send HEARTBEAT
    ws1.closed = false; // pretend socket linger
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_HEARTBEAT',
      deviceId
    }));

    const lastMsg = ws1.sentMessages[ws1.sentMessages.length - 1];
    assert.strictEqual(lastMsg.type, 'ERROR');
    assert.ok(lastMsg.error.includes('SESSION_FENCED'));
    assert.strictEqual(ws1.closed, true);
    passed++;
  } catch (err: any) {
    console.error('T09 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T10: Heartbeat 時間不可倒退 (Monotonic Heartbeats)
  // =========================================================================
  try {
    const auth = new AuthManager('test-master-secret-at-least-32-chars-long!!');
    const { deviceId } = auth.registerDevice('Node 10', 'windows', ['local:read_file']);
    auth.updateDeviceStatus(deviceId, 'online', undefined, 1000);

    auth.updateDeviceHeartbeat(deviceId, 5000);
    assert.strictEqual(auth.getDevice(deviceId)?.lastHeartbeatAt, 5000);

    // Older timestamp arrives
    auth.updateDeviceHeartbeat(deviceId, 3000);
    assert.strictEqual(auth.getDevice(deviceId)?.lastHeartbeatAt, 5000, 'Heartbeat must not regress backwards');

    // Newer timestamp arrives
    auth.updateDeviceHeartbeat(deviceId, 7000);
    assert.strictEqual(auth.getDevice(deviceId)?.lastHeartbeatAt, 7000);
    passed++;
  } catch (err: any) {
    console.error('T10 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T11: 舊 Session 不得認領新任務
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const taskStore = (gateway as any).taskStore as TaskStore;
    const { deviceId, token } = auth.registerDevice('Node 11', 'windows', ['local:read_file']);

    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Expire the incumbent without closing the underlying edge socket.
    const staleAttachment = ws1.deserializeAttachment();
    staleAttachment.lastHeartbeatAt = Date.now() - HEARTBEAT_TTL_MS - 1000;
    ws1.serializeAttachment(staleAttachment);

    const ws2 = new MockDOWebSocket();
    webSockets.push(ws2);
    await gateway.webSocketMessage(ws2 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: deviceId,
      payload: { path: 'test.txt' }
    });

    ws1.closed = false;
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'TASK_CLAIM_POLL',
      deviceId,
      supportedCapabilities: ['local:read_file']
    }));

    const lastMsg = ws1.sentMessages[ws1.sentMessages.length - 1];
    assert.strictEqual(lastMsg.type, 'ERROR');
    assert.ok(lastMsg.error.includes('SESSION_FENCED'));

    // Verify task was NOT claimed by ws1
    const tasks = taskStore.listTasks();
    assert.strictEqual(tasks[0].status, 'queued');
    passed++;
  } catch (err: any) {
    console.error('T11 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T12: 舊 Session 不得越權回報結果
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const taskStore = (gateway as any).taskStore as TaskStore;
    const { deviceId, token } = auth.registerDevice('Node 12', 'windows', ['local:read_file']);

    const ws1 = new MockDOWebSocket();
    webSockets.push(ws1);
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Expire the incumbent without closing the underlying edge socket.
    const staleAttachment = ws1.deserializeAttachment();
    staleAttachment.lastHeartbeatAt = Date.now() - HEARTBEAT_TTL_MS - 1000;
    ws1.serializeAttachment(staleAttachment);

    const ws2 = new MockDOWebSocket();
    webSockets.push(ws2);
    await gateway.webSocketMessage(ws2 as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));
    const s2Id = ws2.sentMessages[0].sessionId;

    // Task claimed by session 2
    const task = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: deviceId,
      payload: { path: 'data.txt' }
    });
    taskStore.claimTaskById(task.taskId, deviceId, undefined, s2Id);

    // Old ws1 tries to complete the task
    ws1.closed = false;
    await gateway.webSocketMessage(ws1 as any, JSON.stringify({
      type: 'TASK_COMPLETE',
      taskId: task.taskId,
      deviceId,
      result: { data: 'forged' }
    }));

    const lastMsg = ws1.sentMessages[ws1.sentMessages.length - 1];
    assert.strictEqual(lastMsg.type, 'ERROR');
    assert.ok(lastMsg.error.includes('SESSION_FENCED'));
    assert.strictEqual(taskStore.getTask(task.taskId)?.status, 'claimed', 'Task status must remain claimed');
    passed++;
  } catch (err: any) {
    console.error('T12 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T13: 執行中任務遇到斷線及重連
  // =========================================================================
  try {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'device-13',
      payload: { path: 'a.txt' }
    });

    taskStore.claimTaskById(task.taskId, 'device-13', undefined, 'sess-old');
    assert.strictEqual(task.status, 'claimed');

    // Superseding session fails tasks cleanly
    const count = taskStore.failTasksForSupersededSession('device-13', 'sess-old');
    assert.strictEqual(count, 1);
    // Read-only task requeues
    assert.strictEqual(taskStore.getTask(task.taskId)?.status, 'queued');
    passed++;
  } catch (err: any) {
    console.error('T13 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T14: 具副作用任務的安全重試及恢復 (Side-effect fail-closed)
  // =========================================================================
  try {
    const taskStore = new TaskStore();

    // 1. Mutating task: write_file
    const writeTask = taskStore.createTask({
      backend: 'local',
      capability: 'local:write_file',
      targetDeviceId: 'device-14',
      payload: { path: 'b.txt', content: 'hello' }
    });

    taskStore.claimTaskById(writeTask.taskId, 'device-14', undefined, 'sess-write');
    taskStore.startTask(writeTask.taskId, 'device-14', 'sess-write');

    // Case A: superseded session while running mutating task
    taskStore.failTasksForSupersededSession('device-14', 'sess-write');
    const updatedWrite = taskStore.getTask(writeTask.taskId);
    assert.strictEqual(updatedWrite?.status, 'stale', 'Mutating task must become stale (fail-closed) requiring manual recovery');
    assert.strictEqual(updatedWrite?.error?.code, 'SESSION_SUPERSEDED_MUTATION_UNCERTAIN');

    // Case B: lease expired while running mutating task
    const runningMutating = taskStore.createTask({
      backend: 'local',
      capability: 'local:write_file',
      targetDeviceId: 'device-14',
      payload: { path: 'c.txt', content: 'mut' },
      maxRetries: 3
    });
    taskStore.claimTaskById(runningMutating.taskId, 'device-14', 1, 'sess-mut');
    taskStore.startTask(runningMutating.taskId, 'device-14', 'sess-mut');
    runningMutating.lease!.leaseExpiresAt = Date.now() - 1000; // expire lease
    taskStore.recoverStaleTasks();
    assert.strictEqual(taskStore.getTask(runningMutating.taskId)?.status, 'stale', 'Running mutating task must not auto-requeue on lease expiration');
    assert.strictEqual(taskStore.getTask(runningMutating.taskId)?.error?.code, 'MUTATION_UNCERTAIN_ON_STALE');

    // 2. Read-only task: git_status safely requeues
    const readTask = taskStore.createTask({
      backend: 'local',
      capability: 'local:git_status',
      targetDeviceId: 'device-14',
      payload: { workspace: '.' }
    });
    taskStore.claimTaskById(readTask.taskId, 'device-14', undefined, 'sess-read');
    taskStore.failTasksForSupersededSession('device-14', 'sess-read');
    assert.strictEqual(taskStore.getTask(readTask.taskId)?.status, 'queued', 'Read-only task safely requeues');
    passed++;
  } catch (err: any) {
    console.error('T14 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T15: 兩台不同裝置並行任務
  // =========================================================================
  try {
    const taskStore = new TaskStore();
    const t1 = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'dev-1',
      payload: { path: '1.txt' }
    });
    const t2 = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'dev-2',
      payload: { path: '2.txt' }
    });

    const c1 = taskStore.claimTask('dev-1', ['local:read_file'], undefined, 'sess-dev-1');
    const c2 = taskStore.claimTask('dev-2', ['local:read_file'], undefined, 'sess-dev-2');

    assert.strictEqual(c1?.taskId, t1.taskId);
    assert.strictEqual(c2?.taskId, t2.taskId);
    passed++;
  } catch (err: any) {
    console.error('T15 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T16: 目標裝置離線不轉派
  // =========================================================================
  try {
    const taskStore = new TaskStore();
    taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'offline-dev',
      payload: { path: 'secret.txt' }
    });

    // Online device 'other-dev' polls
    const claim = taskStore.claimTask('other-dev', ['local:read_file'], undefined, 'sess-other');
    assert.strictEqual(claim, undefined, 'Offline targeted task must never be misrouted to another device');
    passed++;
  } catch (err: any) {
    console.error('T16 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T17: 未指定 Device ID 的防誤操作 (AMBIGUOUS_DEVICE_TARGET)
  // =========================================================================
  try {
    const { gateway } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const taskRouter = (gateway as any).taskRouter;

    auth.registerDevice('Dev A', 'windows', ['local:read_file']);
    auth.registerDevice('Dev B', 'windows', ['local:read_file']);

    let threw = false;
    try {
      await taskRouter.routeTaskSubmit(
        { backend: 'local', capability: 'local:read_file', payload: { path: 'test' } },
        ['tasks:submit', 'local:read'],
        'actor-test'
      );
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('AMBIGUOUS_DEVICE_TARGET'));
    }
    assert.strictEqual(threw, true);
    passed++;
  } catch (err: any) {
    console.error('T17 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T18: Durable Object Hibernation／Session 還原
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 18', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));
    const sId = ws.sentMessages[0].sessionId;

    // Simulate DO eviction from memory (clearing in-memory activeSessions map)
    (gateway as any).activeSessions.clear();
    assert.strictEqual((gateway as any).activeSessions.size, 0);

    // Call getActiveSession -> should rehydrate from WebSocket attachments
    const restored = (gateway as any).getActiveSession(deviceId);
    assert.ok(restored);
    assert.strictEqual(restored.sessionId, sId);
    assert.strictEqual(restored.deviceId, deviceId);
    passed++;
  } catch (err: any) {
    console.error('T18 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T19: Watchdog 與 Kaggle Alarm 共存
  // =========================================================================
  try {
    const { gateway, kv, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Node 19', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Schedule a Kaggle poll
    await (gateway as any).scheduleKagglePoll('task-kaggle-1', 'kernel-1', 10_000);

    const alarmTime = kv.get('alarm');
    assert.ok(alarmTime);
    assert.ok(alarmTime <= Date.now() + 11_000, 'Alarm must be scheduled for the earlier Kaggle poll');

    // Trigger alarm
    await gateway.alarm();
    passed++;
  } catch (err: any) {
    console.error('T19 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T20: 撤銷 Token 與 Emergency Stop 相容性
  // =========================================================================
  try {
    const { gateway, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const killSwitch = (gateway as any).killSwitch as KillSwitch;
    const { deviceId, token } = auth.registerDevice('Node 20', 'windows', ['local:read_file']);

    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_REGISTER',
      token,
      deviceId,
      capabilities: ['local:read_file']
    }));

    // Trigger KillSwitch for this device
    killSwitch.revokeDevice(deviceId, 'Emergency Stop');

    // Send Heartbeat
    await gateway.webSocketMessage(ws as any, JSON.stringify({
      type: 'AGENT_HEARTBEAT',
      deviceId
    }));

    const lastMsg = ws.sentMessages[ws.sentMessages.length - 1];
    assert.strictEqual(lastMsg.type, 'ERROR');
    assert.ok(lastMsg.error.includes('DEVICE_REVOKED'));
    assert.strictEqual(ws.closed, true);
    passed++;
  } catch (err: any) {
    console.error('T20 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T21: 第二台唯讀 Scope 的實際執行拒絕
  // =========================================================================
  try {
    const { gateway } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const taskRouter = (gateway as any).taskRouter;

    // Node 2 has only local:read
    auth.registerDevice('Node21-RO', 'windows', ['local:read_file']);

    let threw = false;
    try {
      // Client tries to submit local:write_file targeted to Node21-RO
      await taskRouter.routeTaskSubmit(
        { backend: 'local', capability: 'local:write_file', targetDeviceId: 'Node21-RO', payload: { path: 'a', content: 'b' } },
        ['tasks:submit', 'local:read'], // missing local:write scope!
        'actor-test'
      );
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('AUTH_FORBIDDEN'));
    }
    assert.strictEqual(threw, true);
    passed++;
  } catch (err: any) {
    console.error('T21 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T22: 相同 Project ID 的跨裝置隔離
  // =========================================================================
  try {
    const taskStore = new TaskStore();
    const tDev1 = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'device-A',
      payload: { projectId: 'my-project', path: 'config.json' }
    });
    const tDev2 = taskStore.createTask({
      backend: 'local',
      capability: 'local:read_file',
      targetDeviceId: 'device-B',
      payload: { projectId: 'my-project', path: 'config.json' }
    });

    const claimA = taskStore.claimTask('device-A', ['local:read_file'], undefined, 'sess-A');
    assert.strictEqual(claimA?.taskId, tDev1.taskId);
    assert.strictEqual(claimA?.targetDeviceId, 'device-A');

    const claimB = taskStore.claimTask('device-B', ['local:read_file'], undefined, 'sess-B');
    assert.strictEqual(claimB?.taskId, tDev2.taskId);
    assert.strictEqual(claimB?.targetDeviceId, 'device-B');
    passed++;
  } catch (err: any) {
    console.error('T22 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T23: 既有 Bootstrap Token 回歸測試
  // =========================================================================
  try {
    const auth = new AuthManager('test-master-secret-at-least-32-chars-long!!');
    const { token } = auth.generateToken('win11-arm64-workstation', 'device', ['admin:all', 'tasks:submit', 'local:read', 'local:write']);
    const val = auth.validateToken(token);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.payload?.type, 'device');
    assert.ok(val.payload?.scopes.includes('tasks:submit'));
    assert.strictEqual(val.payload?.subjectId, 'win11-arm64-workstation');
    passed++;
  } catch (err: any) {
    console.error('T23 FAILED:', err);
    failed++;
  }

  // =========================================================================
  // T24: 既有 Chat Swarm、Kaggle、Artifacts 回歸測試
  // =========================================================================
  try {
    const { gateway } = setupTestDO();
    assert.ok((gateway as any).swarmOrchestrator);
    assert.ok((gateway as any).kaggleBackend);
    assert.ok((gateway as any).artifactStore);
    passed++;
  } catch (err: any) {
    console.error('T24 FAILED:', err);
    failed++;
  }

  // R06/R07: an assignment may already have side effects even if ACK/RUNNING is lost.
  try {
    for (const stage of ['claimed', 'acknowledged', 'running'] as const) {
      const store = new TaskStore();
      const task = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: 'mutation-dev', payload: {}, maxRetries: 3 });
      store.claimTaskById(task.taskId, 'mutation-dev', 1, 'session-a');
      if (stage !== 'claimed') store.acknowledgeTask(task.taskId, 'mutation-dev', 'session-a');
      if (stage === 'running') store.startTask(task.taskId, 'mutation-dev', 'session-a');
      task.lease!.leaseExpiresAt = Date.now() - 1000;
      store.recoverStaleTasks();
      assert.strictEqual(task.status, 'stale', stage);
      assert.strictEqual(task.error?.code, 'MUTATION_UNCERTAIN_ON_STALE', stage);
    }
    passed++;
  } catch (err) { console.error('R06/R07 FAILED:', err); failed++; }

  // R04: old attempt ID cannot be accepted through a fresh authenticated session.
  try {
    const store = new TaskStore();
    const task = store.createTask({ backend: 'local', capability: 'local:read_file', targetDeviceId: 'attempt-dev', payload: {} });
    store.claimTaskById(task.taskId, 'attempt-dev', undefined, 'session-a');
    const oldAttempt = task.activeAttemptId;
    assert.ok(oldAttempt);
    store.failTasksForSupersededSession('attempt-dev', 'session-a');
    assert.strictEqual(store.claimTask('attempt-dev', ['local:read_file'], undefined, 'legacy', false), undefined);
    store.claimTask('attempt-dev', ['local:read_file'], undefined, 'session-b', true);
    assert.ok(task.activeAttemptId && task.activeAttemptId !== oldAttempt);
    assert.strictEqual(store.ownsLocalAttempt(task.taskId, 'attempt-dev', 'session-b', oldAttempt, true), false);
    assert.strictEqual(store.ownsLocalAttempt(task.taskId, 'attempt-dev', 'session-b', undefined, true), false);
    assert.strictEqual(store.ownsLocalAttempt(task.taskId, 'attempt-dev', 'session-b', task.activeAttemptId, true), true);
    passed++;
  } catch (err) { console.error('R04 FAILED:', err); failed++; }

  // D01: actual DO message path must never emit an assignment after a failed durable claim.
  try {
    const { gateway, sql, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const store = (gateway as any).taskStore as TaskStore;
    const { deviceId, token } = auth.registerDevice('Durability test', 'windows', ['local:write', 'local:write_file']);
    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({ type: 'AGENT_REGISTER', deviceId, token, capabilities: ['local:write_file'], supportsAttemptFencing: true }));
    const task = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: deviceId, payload: { path: 'never-executed.txt' } });
    assert.strictEqual(sql.tables.get('tasks')?.get(task.taskId)?.[7], 'queued');
    sql.failTaskWrites = true;
    const poll = JSON.stringify({ type: 'TASK_CLAIM_POLL', deviceId, supportedCapabilities: ['local:write_file'] });
    await gateway.webSocketMessage(ws as any, poll);
    assert.ok(!ws.sentMessages.some(m => m.type === 'TASK_ASSIGNED'));
    assert.ok(ws.sentMessages.some(m => m.type === 'ERROR' && m.error.includes('LOCAL_TASK_PERSISTENCE_UNAVAILABLE')));
    assert.strictEqual(sql.tables.get('tasks')?.get(task.taskId)?.[7], 'queued');
    assert.strictEqual(store.getTask(task.taskId)?.status, 'stale');
    sql.failTaskWrites = false;
    await gateway.webSocketMessage(ws as any, poll);
    assert.ok(!ws.sentMessages.some(m => m.type === 'TASK_ASSIGNED'), 'A healthy subsequent write cannot bypass quarantine');
    passed++;
  } catch (err) { console.error('D01 FAILED:', err); failed++; }

  // D02: a failed completion must retain the previously persisted claim and
  // must not expose a successful result or replay a potentially applied mutation.
  try {
    const { gateway, sql, webSockets } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const store = (gateway as any).taskStore as TaskStore;
    const { deviceId, token } = auth.registerDevice('Durability completion', 'windows', ['local:write', 'local:write_file']);
    const ws = new MockDOWebSocket();
    webSockets.push(ws);
    await gateway.webSocketMessage(ws as any, JSON.stringify({ type: 'AGENT_REGISTER', deviceId, token, capabilities: ['local:write_file'], supportsAttemptFencing: true }));
    const task = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: deviceId, payload: {} });
    await gateway.webSocketMessage(ws as any, JSON.stringify({ type: 'TASK_CLAIM_POLL', deviceId, supportedCapabilities: ['local:write_file'] }));
    const assigned = ws.sentMessages.find(m => m.type === 'TASK_ASSIGNED');
    assert.ok(assigned);
    const row = sql.tables.get('tasks')?.get(task.taskId);
    assert.strictEqual(row?.[7], 'claimed');
    assert.strictEqual(row?.[22], assigned.task.activeAttemptId);
    assert.strictEqual(JSON.parse(row![11]).claimedSessionId, assigned.task.lease.claimedSessionId);
    sql.failTaskWrites = true;
    await gateway.webSocketMessage(ws as any, JSON.stringify({ type: 'TASK_COMPLETE', deviceId, taskId: task.taskId, attemptId: assigned.task.activeAttemptId, result: { changed: true } }));
    assert.strictEqual(store.getTask(task.taskId)?.status, 'stale');
    assert.strictEqual(store.getTask(task.taskId)?.result, undefined);
    assert.strictEqual(sql.tables.get('tasks')?.get(task.taskId)?.[7], 'claimed');
    sql.failTaskWrites = false;
    const adapter = new CloudflareSqliteStorageAdapter(sql);
    const persisted = (await adapter.listTasks()).find(t => t.taskId === task.taskId);
    assert.ok(persisted?.lease);
    const restarted = new TaskStore(undefined, 60000, adapter);
    persisted!.lease!.leaseExpiresAt = Date.now() - 1;
    restarted.hydrate([persisted!]);
    restarted.recoverStaleTasks();
    assert.strictEqual(restarted.getTask(task.taskId)?.status, 'stale');
    assert.strictEqual(restarted.getTask(task.taskId)?.error?.code, 'MUTATION_UNCERTAIN_ON_STALE');
    assert.strictEqual(restarted.claimTask(deviceId, ['local:write_file'], undefined, 'new-session'), undefined);
    passed++;
  } catch (err) { console.error('D02 FAILED:', err); failed++; }

  // D03: file-backed claim survives restart; failure to write blocks dispatch.
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-durable-dispatch-'));
    try {
      const store = new TaskStore(root);
      const task = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: 'file-dev', payload: {} });
      store.claimTask('file-dev', ['local:write_file'], undefined, 'file-session');
      const persisted = new TaskStore(root).getTask(task.taskId);
      assert.strictEqual(persisted?.status, 'claimed');
      assert.strictEqual(persisted?.activeAttemptId, task.activeAttemptId);
      const second = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: 'file-dev', payload: {} });
      const taskDir = path.join(root, 'tasks');
      fs.renameSync(taskDir, path.join(root, 'saved-tasks'));
      fs.writeFileSync(taskDir, 'not a directory');
      assert.throws(() => store.claimTask('file-dev', ['local:write_file'], undefined, 'file-session'), /LOCAL_TASK_PERSISTENCE_UNAVAILABLE/);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'saved-tasks', second.taskId + '.json'), 'utf8')).status, 'queued');
      fs.unlinkSync(taskDir);
      fs.renameSync(path.join(root, 'saved-tasks'), taskDir);
      assert.throws(() => store.claimTask('file-dev', ['local:write_file'], undefined, 'file-session'), /LOCAL_TASK_PERSISTENCE_UNAVAILABLE/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    passed++;
  } catch (err) { console.error('D03 FAILED:', err); failed++; }

  // D08: TaskStore startup with corrupted task JSON files must fail-closed.
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-durable-corrupt-'));
    try {
      const taskDir = path.join(root, 'tasks');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'corrupted-task.json'), '{ broken_json');
      const store = new TaskStore(root);
      assert.throws(() => store.claimTask('any-dev', ['local:read_file'], undefined, 's1'), /LOCAL_TASK_PERSISTENCE_UNAVAILABLE/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    passed++;
  } catch (err) { console.error('D08 FAILED:', err); failed++; }

  // D09: LeaseMonitor tick survives persistence quarantine without unhandled exception.
  try {
    const store = new TaskStore();
    store.blockLocalDispatch();
    const monitor = new LeaseMonitor(store, { getConnectedAgents: () => [] } as any, { log: () => {} } as any, 1000);
    monitor.tick();
    monitor.stop();
    passed++;
  } catch (err) { console.error('D09 FAILED:', err); failed++; }

  // R01: same process can reconnect while Edge still holds the healthy socket.
  try {
    const { gateway, webSockets, ctx } = setupTestDO();
    const auth = (gateway as any).authManager as AuthManager;
    const { deviceId, token } = auth.registerDevice('Reconnect', 'windows', ['local:read_file']);
    const proof = 'a'.repeat(64);
    const register = async (sequence: number, reconnectProof = proof, target = gateway) => {
      const ws = new MockDOWebSocket();
      webSockets.push(ws);
      await target.webSocketMessage(ws as any, JSON.stringify({
        type: 'AGENT_REGISTER', deviceId, token, capabilities: ['local:read_file'],
        supportsAttemptFencing: true, reconnectProof, reconnectSequence: sequence
      }));
      return ws;
    };
    let current = await register(1);
    assert.strictEqual(current.sentMessages[0].type, 'AGENT_REGISTERED');
    assert.ok(current.deserializeAttachment().reconnectProofHash);
    assert.ok(!JSON.stringify(current.deserializeAttachment()).includes(proof));
    for (let i = 2; i <= 11; i++) {
      const old = current;
      current = await register(i);
      assert.strictEqual(current.sentMessages[0].type, 'AGENT_REGISTERED');
      assert.strictEqual(old.closed, true);
      assert.strictEqual((gateway as any).getActiveSession(deviceId).sessionId, current.deserializeAttachment().sessionId);
      await gateway.webSocketClose(old as any, 1006, 'Delayed close');
      await gateway.webSocketError(old as any, new Error('Delayed error'));
      assert.strictEqual(auth.getDevice(deviceId)?.status, 'online');
      assert.strictEqual((gateway as any).getActiveSession(deviceId).sessionId, current.deserializeAttachment().sessionId);
    }
    const impostor = await register(12, 'b'.repeat(64));
    assert.strictEqual(impostor.closeCode, 1008);
    const replay = await register(11);
    assert.strictEqual(replay.closeReason, 'Stale reconnect sequence');
    const malformed = await register(12, 'invalid');
    assert.strictEqual(malformed.closeReason, 'Invalid reconnect identity');
    assert.strictEqual(current.closed, false);
    // A takeover must preserve the existing task-attempt safety policy.
    const store = (gateway as any).taskStore as TaskStore;
    const session = current.deserializeAttachment().sessionId;
    const read = store.createTask({ backend: 'local', capability: 'local:read_file', targetDeviceId: deviceId, payload: {} });
    const write = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: deviceId, payload: {} });
    store.claimTaskById(read.taskId, deviceId, undefined, session);
    store.claimTaskById(write.taskId, deviceId, undefined, session);
    store.startTask(write.taskId, deviceId, session);
    const beforeWake = await register(12);
    assert.strictEqual(beforeWake.sentMessages[0].type, 'AGENT_REGISTERED');
    assert.strictEqual(store.getTask(read.taskId)?.status, 'queued');
    assert.strictEqual(store.getTask(write.taskId)?.status, 'stale');
    assert.strictEqual(store.getTask(write.taskId)?.error?.code, 'SESSION_SUPERSEDED_MUTATION_UNCERTAIN');
    current = beforeWake;
    const restored = new GatewayDurableObject(ctx, { MASTER_SECRET: testMasterSecret } as any);
    const afterWake = await register(13, proof, restored);
    assert.strictEqual(afterWake.sentMessages[0].type, 'AGENT_REGISTERED');
    assert.strictEqual(current.closed, true);
    passed++;
  } catch (err) { console.error('R01 FAILED:', err); failed++; }

  console.log(`Connection Lifecycle & Session Fencing Tests: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}
