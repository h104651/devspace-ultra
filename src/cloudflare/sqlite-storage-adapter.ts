import { IStorageAdapter } from '../storage/storage-adapter.interface';
import { DurableTask, TaskStatus } from '../types/task';
import { ClientRecord, DeviceRecord } from '../types/auth';
import { ArtifactMetadata } from '../types/artifacts';
import { AuditEvent } from '../types/audit';

export interface SqlStorage {
  exec(query: string, ...params: any[]): {
    toArray(): any[];
    one(): any;
    raw(): any;
  };
}

export class CloudflareSqliteStorageAdapter implements IStorageAdapter {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initTables();
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        taskId TEXT PRIMARY KEY,
        taskKey TEXT,
        idempotencyKey TEXT,
        clientRequestId TEXT,
        backend TEXT NOT NULL,
        capability TEXT NOT NULL,
        requiredScope TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        payloadJson TEXT NOT NULL,
        retryPolicyJson TEXT NOT NULL,
        leaseJson TEXT,
        resultJson TEXT,
        errorJson TEXT,
        artifactsJson TEXT NOT NULL,
        logsJson TEXT NOT NULL,
        metadataJson TEXT,
        startedAt INTEGER,
        completedAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_idemp ON tasks(idempotencyKey);
      CREATE INDEX IF NOT EXISTS idx_tasks_client_req ON tasks(clientRequestId);

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        taskJson TEXT NOT NULL,
        expiresAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clients (
        clientId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scopesJson TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        tokenHash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        deviceId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilitiesJson TEXT NOT NULL,
        registeredAt INTEGER NOT NULL,
        lastConnectedAt INTEGER,
        lastHeartbeatAt INTEGER,
        revokedAt INTEGER,
        revocationReason TEXT,
        tokenHash TEXT NOT NULL,
        ip TEXT
      );

      CREATE TABLE IF NOT EXISTS revoked_tokens (
        tokenId TEXT PRIMARY KEY,
        revokedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        mimeType TEXT,
        preview TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        actor TEXT NOT NULL,
        actorType TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT,
        taskId TEXT,
        scopeUsed TEXT,
        result TEXT NOT NULL,
        detailsJson TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        clientId TEXT PRIMARY KEY,
        clientSecret TEXT,
        clientName TEXT,
        redirectUrisJson TEXT NOT NULL,
        grantTypesJson TEXT NOT NULL,
        responseTypesJson TEXT NOT NULL,
        tokenAuthMethod TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code TEXT PRIMARY KEY,
        clientId TEXT NOT NULL,
        redirectUri TEXT NOT NULL,
        codeChallenge TEXT,
        codeChallengeMethod TEXT,
        scope TEXT NOT NULL,
        state TEXT,
        expiresAt INTEGER NOT NULL
      );
    `);
  }

  private getFirstRow(query: string, ...params: any[]): any {
    const cursor: any = this.sql.exec(query, ...params);
    if (typeof cursor?.toArray === 'function') {
      const rows = cursor.toArray();
      return rows[0];
    }
    if (typeof cursor?.one === 'function') {
      try {
        return cursor.one();
      } catch {
        return undefined;
      }
    }
    try {
      const rows = Array.from(cursor);
      return rows[0];
    } catch {
      return undefined;
    }
  }

  // --- Tasks ---
  async getTask(taskId: string): Promise<DurableTask | undefined> {
    const row = this.getFirstRow('SELECT * FROM tasks WHERE taskId = ?', taskId);
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  async saveTask(task: DurableTask): Promise<void> {
    task.updatedAt = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO tasks (
        taskId, taskKey, idempotencyKey, clientRequestId, backend, capability,
        requiredScope, status, priority, payloadJson, retryPolicyJson, leaseJson,
        resultJson, errorJson, artifactsJson, logsJson, metadataJson,
        startedAt, completedAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.taskId,
      task.taskKey || null,
      task.idempotencyKey || null,
      task.clientRequestId || null,
      task.backend,
      task.capability,
      task.requiredScope,
      task.status,
      task.priority,
      JSON.stringify(task.payload),
      JSON.stringify(task.retryPolicy),
      task.lease ? JSON.stringify(task.lease) : null,
      task.result ? JSON.stringify(task.result) : null,
      task.error ? JSON.stringify(task.error) : null,
      JSON.stringify(task.artifacts || []),
      JSON.stringify(task.logs || []),
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.startedAt || null,
      task.completedAt || null,
      task.createdAt,
      task.updatedAt
    );
  }

  async listTasks(filter?: { status?: TaskStatus; backend?: string; capability?: string; limit?: number }): Promise<DurableTask[]> {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: any[] = [];

    if (filter?.status) {
      query += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.backend) {
      query += ' AND backend = ?';
      params.push(filter.backend);
    }
    if (filter?.capability) {
      query += ' AND capability = ?';
      params.push(filter.capability);
    }

    query += ' ORDER BY priority DESC, createdAt DESC';

    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.sql.exec(query, ...params).toArray();
    return rows.map(r => this.rowToTask(r));
  }

  async deleteTask(taskId: string): Promise<boolean> {
    this.sql.exec('DELETE FROM tasks WHERE taskId = ?', taskId);
    return true;
  }

  private rowToTask(row: any): DurableTask {
    return {
      taskId: row.taskId,
      taskKey: row.taskKey || undefined,
      idempotencyKey: row.idempotencyKey || undefined,
      clientRequestId: row.clientRequestId || undefined,
      backend: row.backend,
      capability: row.capability,
      requiredScope: row.requiredScope,
      status: row.status,
      priority: row.priority,
      payload: JSON.parse(row.payloadJson),
      retryPolicy: JSON.parse(row.retryPolicyJson),
      lease: row.leaseJson ? JSON.parse(row.leaseJson) : undefined,
      result: row.resultJson ? JSON.parse(row.resultJson) : undefined,
      error: row.errorJson ? JSON.parse(row.errorJson) : undefined,
      artifacts: JSON.parse(row.artifactsJson),
      logs: JSON.parse(row.logsJson),
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : undefined,
      startedAt: row.startedAt || undefined,
      completedAt: row.completedAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  // --- Idempotency ---
  async getIdempotency(key: string): Promise<DurableTask | undefined> {
    const now = Date.now();
    const row = this.getFirstRow('SELECT * FROM idempotency WHERE key = ? AND expiresAt > ?', key, now);
    if (!row) return undefined;
    return JSON.parse(row.taskJson);
  }

  async setIdempotency(key: string, task: DurableTask, ttlMs = 24 * 3600 * 1000): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    this.sql.exec(
      'INSERT OR REPLACE INTO idempotency (key, taskId, taskJson, expiresAt) VALUES (?, ?, ?, ?)',
      key,
      task.taskId,
      JSON.stringify(task),
      expiresAt
    );
  }

  // --- Auth / Registry ---
  async getClient(clientId: string): Promise<ClientRecord | undefined> {
    const row = this.getFirstRow('SELECT * FROM clients WHERE clientId = ?', clientId);
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      name: row.name,
      scopes: JSON.parse(row.scopesJson),
      status: row.status,
      createdAt: row.createdAt,
      tokenHash: row.tokenHash
    };
  }

  async saveClient(client: ClientRecord): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO clients (clientId, name, scopesJson, status, createdAt, tokenHash) VALUES (?, ?, ?, ?, ?, ?)',
      client.clientId,
      client.name,
      JSON.stringify(client.scopes),
      client.status,
      client.createdAt,
      client.tokenHash
    );
  }

  async listClients(): Promise<ClientRecord[]> {
    const rows = this.sql.exec('SELECT * FROM clients').toArray();
    return rows.map(r => ({
      clientId: r.clientId,
      name: r.name,
      scopes: JSON.parse(r.scopesJson),
      status: r.status,
      createdAt: r.createdAt,
      tokenHash: r.tokenHash
    }));
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const row = this.getFirstRow('SELECT * FROM devices WHERE deviceId = ?', deviceId);
    if (!row) return undefined;
    return {
      deviceId: row.deviceId,
      name: row.name,
      platform: row.platform,
      status: row.status,
      capabilities: JSON.parse(row.capabilitiesJson),
      registeredAt: row.registeredAt,
      lastConnectedAt: row.lastConnectedAt || undefined,
      lastHeartbeatAt: row.lastHeartbeatAt || undefined,
      revokedAt: row.revokedAt || undefined,
      revocationReason: row.revocationReason || undefined,
      tokenHash: row.tokenHash,
      ip: row.ip || undefined
    };
  }

  async saveDevice(device: DeviceRecord): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO devices (
        deviceId, name, platform, status, capabilitiesJson, registeredAt,
        lastConnectedAt, lastHeartbeatAt, revokedAt, revocationReason, tokenHash, ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      device.deviceId,
      device.name,
      device.platform,
      device.status,
      JSON.stringify(device.capabilities),
      device.registeredAt,
      device.lastConnectedAt || null,
      device.lastHeartbeatAt || null,
      device.revokedAt || null,
      device.revocationReason || null,
      device.tokenHash,
      device.ip || null
    );
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const rows = this.sql.exec('SELECT * FROM devices').toArray();
    return rows.map(r => ({
      deviceId: r.deviceId,
      name: r.name,
      platform: r.platform,
      status: r.status,
      capabilities: JSON.parse(r.capabilitiesJson),
      registeredAt: r.registeredAt,
      lastConnectedAt: r.lastConnectedAt || undefined,
      lastHeartbeatAt: r.lastHeartbeatAt || undefined,
      revokedAt: r.revokedAt || undefined,
      revocationReason: r.revocationReason || undefined,
      tokenHash: r.tokenHash,
      ip: r.ip || undefined
    }));
  }

  async isTokenRevoked(tokenId: string): Promise<boolean> {
    const row = this.getFirstRow('SELECT tokenId FROM revoked_tokens WHERE tokenId = ?', tokenId);
    return !!row;
  }

  async revokeToken(tokenId: string): Promise<void> {
    this.sql.exec('INSERT OR REPLACE INTO revoked_tokens (tokenId, revokedAt) VALUES (?, ?)', tokenId, Date.now());
  }

  // --- Artifacts ---
  async saveArtifactMetadata(meta: ArtifactMetadata): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO artifacts (id, taskId, name, type, sizeBytes, sha256, mimeType, preview, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      meta.id,
      meta.taskId,
      meta.name,
      meta.type,
      meta.sizeBytes,
      meta.sha256,
      meta.mimeType || null,
      meta.preview || null,
      meta.createdAt
    );
  }

  async getArtifactMetadata(id: string): Promise<ArtifactMetadata | undefined> {
    const row = this.getFirstRow('SELECT * FROM artifacts WHERE id = ?', id);
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.taskId,
      name: row.name,
      type: row.type,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      mimeType: row.mimeType || undefined,
      preview: row.preview || undefined,
      createdAt: row.createdAt
    };
  }

  async listTaskArtifacts(taskId: string): Promise<ArtifactMetadata[]> {
    const rows = this.sql.exec('SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt ASC', taskId).toArray();
    return rows.map(r => ({
      id: r.id,
      taskId: r.taskId,
      name: r.name,
      type: r.type,
      sizeBytes: r.sizeBytes,
      sha256: r.sha256,
      mimeType: r.mimeType || undefined,
      preview: r.preview || undefined,
      createdAt: r.createdAt
    }));
  }

  // --- Audit ---
  async appendAuditLog(event: AuditEvent): Promise<void> {
    this.sql.exec(
      'INSERT INTO audit_logs (id, timestamp, actor, actorType, action, resource, taskId, scopeUsed, result, detailsJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      event.id,
      event.timestamp,
      event.actor,
      event.actorType,
      event.action,
      event.resource || null,
      event.taskId || null,
      event.scopeUsed || null,
      event.result,
      event.details ? JSON.stringify(event.details) : null
    );
  }

  async getRecentAuditLogs(limit = 100): Promise<AuditEvent[]> {
    const rows = this.sql.exec('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?', limit).toArray();
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      actor: r.actor,
      actorType: r.actorType,
      action: r.action,
      resource: r.resource || undefined,
      taskId: r.taskId || undefined,
      scopeUsed: r.scopeUsed || undefined,
      result: r.result,
      details: r.detailsJson ? JSON.parse(r.detailsJson) : undefined
    }));
  }

  // --- OAuth 2.0 ---
  async saveOAuthClient(client: any): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO oauth_clients (clientId, clientSecret, clientName, redirectUrisJson, grantTypesJson, responseTypesJson, tokenAuthMethod, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      client.clientId,
      client.clientSecret || null,
      client.clientName,
      JSON.stringify(client.redirectUris || []),
      JSON.stringify(client.grantTypes || []),
      JSON.stringify(client.responseTypes || []),
      client.tokenAuthMethod || 'none',
      client.createdAt || Date.now()
    );
  }

  async getOAuthClient(clientId: string): Promise<any | undefined> {
    const row = this.getFirstRow('SELECT * FROM oauth_clients WHERE clientId = ?', clientId);
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      clientSecret: row.clientSecret || undefined,
      clientName: row.clientName,
      redirectUris: JSON.parse(row.redirectUrisJson),
      grantTypes: JSON.parse(row.grantTypesJson),
      responseTypes: JSON.parse(row.responseTypesJson),
      tokenAuthMethod: row.tokenAuthMethod,
      createdAt: row.createdAt
    };
  }

  async saveOAuthCode(record: any): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO oauth_codes (code, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, state, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      record.code,
      record.clientId,
      record.redirectUri,
      record.codeChallenge || null,
      record.codeChallengeMethod || null,
      record.scope,
      record.state || null,
      record.expiresAt
    );
  }

  async getOAuthCode(code: string): Promise<any | undefined> {
    const row = this.getFirstRow('SELECT * FROM oauth_codes WHERE code = ?', code);
    if (!row) return undefined;
    return {
      code: row.code,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge || undefined,
      codeChallengeMethod: row.codeChallengeMethod || undefined,
      scope: row.scope,
      state: row.state || undefined,
      expiresAt: row.expiresAt
    };
  }

  async deleteOAuthCode(code: string): Promise<void> {
    this.sql.exec('DELETE FROM oauth_codes WHERE code = ?', code);
  }
}
