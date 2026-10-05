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
    this.masterSecret = masterSecret || process.env.MASTER_SECRET || crypto.randomBytes(32).toString('hex');

    if (storageDir) {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.filePath = path.join(storageDir, 'auth_registry.json');
      this.load();
    }
  }

  private hashToken(rawToken: string): string {
    return crypto.createHmac('sha256', this.masterSecret).update(rawToken).digest('hex');
  }

  private load() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data.clients) {
          for (const c of data.clients) {
            this.clients.set(c.clientId, c);
          }
        }
        if (data.devices) {
          for (const d of data.devices) {
            this.devices.set(d.deviceId, d);
          }
        }
        if (data.revokedTokens) {
          for (const t of data.revokedTokens) {
            this.revokedTokens.add(t);
          }
        }
      } catch (err) {
        console.error('Failed to load auth registry:', err);
      }
    }
  }

  private save() {
    if (this.filePath) {
      try {
        const dir = path.dirname(this.filePath);
        if (fs.existsSync(dir)) {
          const payload = {
            clients: Array.from(this.clients.values()),
            devices: Array.from(this.devices.values()),
            revokedTokens: Array.from(this.revokedTokens.values())
          };
          fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
        }
      } catch (err) {
        // Silently ignore if storage dir was cleaned up during test teardown
      }
    }
  }

  /**
   * Generates a signed token for a client or device.
   */
  public generateToken(
    subjectId: string,
    type: TokenType,
    scopes: string[],
    expiresInMs = 30 * 24 * 3600 * 1000, // 30 days default
    metadata?: Record<string, any>
  ): { token: string; payload: TokenPayload } {
    const tokenId = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + expiresInMs;

    const payload: TokenPayload = {
      tokenId,
      type,
      subjectId,
      scopes,
      issuedAt,
      expiresAt,
      metadata
    };

    const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const headerAndPayload = `dsu_${type}_${serialized}`;
    const signature = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');
    const token = `${headerAndPayload}.${signature}`;

    return { token, payload };
  }

  /**
   * Validates a signed token and returns its decoded payload.
   */
  public validateToken(rawToken: string): { valid: boolean; payload?: TokenPayload; error?: string } {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith('dsu_')) {
      return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
    }

    const parts = rawToken.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'MALFORMED_TOKEN' };
    }

    const [headerAndPayload, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: 'INVALID_SIGNATURE' };
    }

    try {
      const payloadBase64 = headerAndPayload.replace(/^dsu_[a-z]+_/, '');
      const payload: TokenPayload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));

      if (this.revokedTokens.has(payload.tokenId)) {
        return { valid: false, error: 'TOKEN_REVOKED' };
      }

      if (Date.now() > payload.expiresAt) {
        return { valid: false, error: 'TOKEN_EXPIRED' };
      }

      // If device token, verify device record is active
      if (payload.type === 'device') {
        const dev = this.devices.get(payload.subjectId);
        if (dev && dev.status === 'revoked') {
          return { valid: false, error: 'DEVICE_REVOKED' };
        }
      }

      // If client token, verify client record is active
      if (payload.type === 'client') {
        const client = this.clients.get(payload.subjectId);
        if (client && client.status === 'revoked') {
          return { valid: false, error: 'CLIENT_REVOKED' };
        }
      }

      return { valid: true, payload };
    } catch {
      return { valid: false, error: 'CORRUPTED_PAYLOAD' };
    }
  }

  /**
   * Registers a new client (e.g. ChatGPT integration).
   */
  public registerClient(
    name: string,
    scopes: string[] = ['admin'],
    expiresInMs?: number
  ): { clientId: string; token: string; record: ClientRecord } {
    const clientId = `client-${crypto.randomBytes(6).toString('hex')}`;
    const { token } = this.generateToken(clientId, 'client', scopes, expiresInMs);
    const tokenHash = this.hashToken(token);

    const record: ClientRecord = {
      clientId,
      name,
      scopes,
      status: 'active',
      createdAt: Date.now(),
      tokenHash
    };

    this.clients.set(clientId, record);
    this.save();
    return { clientId, token, record };
  }

  /**
   * Registers a local agent device.
   */
  public registerDevice(
    name: string,
    platform: 'windows' | 'linux' | 'darwin' | 'cloud' = 'windows',
    capabilities: string[] = ['local:read', 'local:write', 'local:test']
  ): { deviceId: string; token: string; record: DeviceRecord } {
    const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
    const scopes = ['device:connect', ...capabilities];
    const { token } = this.generateToken(deviceId, 'device', scopes);
    const tokenHash = this.hashToken(token);

    const record: DeviceRecord = {
      deviceId,
      name,
      platform,
      status: 'offline',
      capabilities,
      registeredAt: Date.now(),
      tokenHash
    };

    this.devices.set(deviceId, record);
    this.save();
    return { deviceId, token, record };
  }

  public isTokenRevoked(tokenId: string): boolean {
    return this.revokedTokens.has(tokenId);
  }

  public revokeToken(tokenId: string): void {
    this.revokedTokens.add(tokenId);
    this.save();
  }

  public revokeDevice(deviceId: string, reason = 'Administrative revocation'): void {
    const dev = this.devices.get(deviceId);
    if (dev) {
      dev.status = 'revoked';
      dev.revokedAt = Date.now();
      dev.revocationReason = reason;
      this.save();
    }
  }

  public updateDeviceStatus(
    deviceId: string,
    status: 'online' | 'offline',
    ip?: string
  ): void {
    const dev = this.devices.get(deviceId);
    if (dev && dev.status !== 'revoked') {
      dev.status = status;
      if (status === 'online') {
        dev.lastConnectedAt = Date.now();
        dev.lastHeartbeatAt = Date.now();
      }
      if (ip) {
        dev.ip = ip;
      }
      this.save();
    }
  }

  public updateDeviceHeartbeat(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    if (dev && dev.status === 'online') {
      dev.lastHeartbeatAt = Date.now();
    }
  }

  public getDevice(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  public listDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  public listClients(): ClientRecord[] {
    return Array.from(this.clients.values());
  }
}
