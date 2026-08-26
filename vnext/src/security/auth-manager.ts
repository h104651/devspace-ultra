import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ClientRecord, DeviceRecord, TokenPayload, TokenType } from '../types/auth';

export class AuthManager {
  private masterSecret: string;
  private clients: Map<string, ClientRecord> = new Map();
  private devices: Map<string, DeviceRecord> = new Map();
  private revokedTokens: Set<string> = new Set();
  private filePath?: string;

  constructor(masterSecret?: string, storageDir?: string) {
    const envSecret = typeof process !== 'undefined' ? process.env?.MASTER_SECRET : undefined;
    this.masterSecret = masterSecret || envSecret || crypto.randomBytes(32).toString('hex');
    if (storageDir) {
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      this.filePath = path.join(storageDir, 'auth_registry.json');
      this.load();
    }
  }

  private hashToken(rawToken: string): string {
    return crypto.createHmac('sha256', this.masterSecret).update(rawToken).digest('hex');
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      for (const c of data.clients || []) this.clients.set(c.clientId, c);
      for (const d of data.devices || []) this.devices.set(d.deviceId, d);
      for (const t of data.revokedTokens || []) this.revokedTokens.add(t);
    } catch (err) { console.error('Failed to load auth registry:', err); }
  }

  private save() {
    if (!this.filePath) return;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ clients: Array.from(this.clients.values()), devices: Array.from(this.devices.values()), revokedTokens: Array.from(this.revokedTokens.values()) }, null, 2), 'utf-8');
    } catch {}
  }

  public hydrateClients(records: ClientRecord[]): void {
    for (const record of records || []) if (record?.clientId) this.clients.set(record.clientId, record);
  }

  public hydrateDevices(records: DeviceRecord[]): void {
    for (const record of records || []) if (record?.deviceId) this.devices.set(record.deviceId, record);
  }

  public generateToken(subjectId: string, type: TokenType, scopes: string[], expiresInMs = 30 * 24 * 3600 * 1000, metadata?: Record<string, any>): { token: string; payload: TokenPayload } {
    const payload: TokenPayload = { tokenId: crypto.randomUUID(), type, subjectId, scopes, issuedAt: Date.now(), expiresAt: Date.now() + expiresInMs, metadata };
    const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const headerAndPayload = `dsu_${type}_${serialized}`;
    const signature = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');
    return { token: `${headerAndPayload}.${signature}`, payload };
  }

  public validateToken(rawToken: string): { valid: boolean; payload?: TokenPayload; error?: string } {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith('dsu_')) return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
    const parts = rawToken.split('.');
    if (parts.length !== 2) return { valid: false, error: 'MALFORMED_TOKEN' };
    const [headerAndPayload, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return { valid: false, error: 'INVALID_SIGNATURE' };

    try {
      const payloadBase64 = headerAndPayload.replace(/^dsu_[a-z]+_/, '');
      const payload: TokenPayload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));
      if (!payload.tokenId || !payload.subjectId || !Array.isArray(payload.scopes)) return { valid: false, error: 'CORRUPTED_PAYLOAD' };
      if (this.revokedTokens.has(payload.tokenId)) return { valid: false, error: 'TOKEN_REVOKED' };
      if (Date.now() > payload.expiresAt) return { valid: false, error: 'TOKEN_EXPIRED' };
      if (payload.type === 'device') {
        const dev = this.devices.get(payload.subjectId);
        if (dev?.status === 'revoked') return { valid: false, error: 'DEVICE_REVOKED' };
      }
      if (payload.type === 'client') {
        const client = this.clients.get(payload.subjectId);
        if (client?.status === 'revoked') return { valid: false, error: 'CLIENT_REVOKED' };
      }
      return { valid: true, payload };
    } catch { return { valid: false, error: 'CORRUPTED_PAYLOAD' }; }
  }

  public registerClient(name: string, scopes: string[] = ['admin'], expiresInMs?: number): { clientId: string; token: string; record: ClientRecord } {
    const clientId = `client-${crypto.randomBytes(6).toString('hex')}`;
    const { token } = this.generateToken(clientId, 'client', scopes, expiresInMs);
    const record: ClientRecord = { clientId, name, scopes, status: 'active', createdAt: Date.now(), tokenHash: this.hashToken(token) };
    this.clients.set(clientId, record);
    this.save();
    return { clientId, token, record };
  }

  public registerDevice(name: string, platform: 'windows' | 'linux' | 'darwin' | 'cloud' = 'windows', capabilities: string[] = ['local:read', 'local:write', 'local:test']): { deviceId: string; token: string; record: DeviceRecord } {
    const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
    const { token } = this.generateToken(deviceId, 'device', ['device:connect', ...capabilities]);
    const record: DeviceRecord = { deviceId, name, platform, status: 'offline', capabilities, registeredAt: Date.now(), tokenHash: this.hashToken(token) };
    this.devices.set(deviceId, record);
    this.save();
    return { deviceId, token, record };
  }

  public rememberAuthenticatedDevice(rawToken: string, deviceId: string, name: string, capabilities: string[], platform: DeviceRecord['platform'] = 'windows'): DeviceRecord {
    const existing = this.devices.get(deviceId);
    const record: DeviceRecord = {
      deviceId,
      name: name || existing?.name || deviceId,
      platform,
      status: existing?.status === 'revoked' ? 'revoked' : 'online',
      capabilities: capabilities || existing?.capabilities || [],
      registeredAt: existing?.registeredAt || Date.now(),
      lastConnectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      tokenHash: existing?.tokenHash || this.hashToken(rawToken),
      revokedAt: existing?.revokedAt,
      revocationReason: existing?.revocationReason,
      ip: existing?.ip
    };
    this.devices.set(deviceId, record);
    this.save();
    return record;
  }

  public isTokenRevoked(tokenId: string): boolean { return this.revokedTokens.has(tokenId); }
  public revokeToken(tokenId: string): void { this.revokedTokens.add(tokenId); this.save(); }

  public revokeDevice(deviceId: string, reason = 'Administrative revocation'): void {
    const dev = this.devices.get(deviceId);
    if (dev) { dev.status = 'revoked'; dev.revokedAt = Date.now(); dev.revocationReason = reason; this.save(); }
  }

  public updateDeviceStatus(deviceId: string, status: 'online' | 'offline', ip?: string): void {
    const dev = this.devices.get(deviceId);
    if (dev && dev.status !== 'revoked') {
      dev.status = status;
      if (status === 'online') { dev.lastConnectedAt = Date.now(); dev.lastHeartbeatAt = Date.now(); }
      if (ip) dev.ip = ip;
      this.save();
    }
  }

  public updateDeviceHeartbeat(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    if (dev && dev.status === 'online') { dev.lastHeartbeatAt = Date.now(); this.save(); }
  }

  public getDevice(deviceId: string): DeviceRecord | undefined { return this.devices.get(deviceId); }
  public listDevices(): DeviceRecord[] { return Array.from(this.devices.values()); }
  public listClients(): ClientRecord[] { return Array.from(this.clients.values()); }
}
