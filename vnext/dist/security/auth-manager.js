"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class AuthManager {
    masterSecret;
    clients = new Map();
    devices = new Map();
    revokedTokens = new Set();
    filePath;
    constructor(masterSecret, storageDir) {
        const envSecret = typeof process !== 'undefined' ? process.env?.MASTER_SECRET : undefined;
        this.masterSecret = masterSecret || envSecret || crypto.randomBytes(32).toString('hex');
        if (storageDir) {
            if (!fs.existsSync(storageDir))
                fs.mkdirSync(storageDir, { recursive: true });
            this.filePath = path.join(storageDir, 'auth_registry.json');
            this.load();
        }
    }
    hashToken(rawToken) {
        return crypto.createHmac('sha256', this.masterSecret).update(rawToken).digest('hex');
    }
    load() {
        if (!this.filePath || !fs.existsSync(this.filePath))
            return;
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            for (const c of data.clients || [])
                this.clients.set(c.clientId, c);
            for (const d of data.devices || [])
                this.devices.set(d.deviceId, d);
            for (const t of data.revokedTokens || [])
                this.revokedTokens.add(t);
        }
        catch (err) {
            console.error('Failed to load auth registry:', err);
        }
    }
    save() {
        if (!this.filePath)
            return;
        try {
            fs.writeFileSync(this.filePath, JSON.stringify({ clients: Array.from(this.clients.values()), devices: Array.from(this.devices.values()), revokedTokens: Array.from(this.revokedTokens.values()) }, null, 2), 'utf-8');
        }
        catch { }
    }
    hydrateClients(records) {
        for (const record of records || [])
            if (record?.clientId)
                this.clients.set(record.clientId, record);
    }
    hydrateDevices(records) {
        for (const record of records || [])
            if (record?.deviceId)
                this.devices.set(record.deviceId, record);
    }
    generateToken(subjectId, type, scopes, expiresInMs = 30 * 24 * 3600 * 1000, metadata) {
        const payload = { tokenId: crypto.randomUUID(), type, subjectId, scopes, issuedAt: Date.now(), expiresAt: Date.now() + expiresInMs, metadata };
        const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const headerAndPayload = `dsu_${type}_${serialized}`;
        const signature = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');
        return { token: `${headerAndPayload}.${signature}`, payload };
    }
    validateToken(rawToken) {
        if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith('dsu_'))
            return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
        const parts = rawToken.split('.');
        if (parts.length !== 2)
            return { valid: false, error: 'MALFORMED_TOKEN' };
        const [headerAndPayload, signature] = parts;
        const expectedSig = crypto.createHmac('sha256', this.masterSecret).update(headerAndPayload).digest('base64url');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expectedSig);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf))
            return { valid: false, error: 'INVALID_SIGNATURE' };
        try {
            const payloadBase64 = headerAndPayload.replace(/^dsu_[a-z]+_/, '');
            const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf-8'));
            if (!payload.tokenId || !payload.subjectId || !Array.isArray(payload.scopes))
                return { valid: false, error: 'CORRUPTED_PAYLOAD' };
            if (this.revokedTokens.has(payload.tokenId))
                return { valid: false, error: 'TOKEN_REVOKED' };
            if (Date.now() > payload.expiresAt)
                return { valid: false, error: 'TOKEN_EXPIRED' };
            if (payload.type === 'device') {
                const dev = this.devices.get(payload.subjectId);
                if (dev?.status === 'revoked')
                    return { valid: false, error: 'DEVICE_REVOKED' };
            }
            if (payload.type === 'client') {
                const client = this.clients.get(payload.subjectId);
                if (client?.status === 'revoked')
                    return { valid: false, error: 'CLIENT_REVOKED' };
            }
            return { valid: true, payload };
        }
        catch {
            return { valid: false, error: 'CORRUPTED_PAYLOAD' };
        }
    }
    registerClient(name, scopes = ['admin'], expiresInMs) {
        const clientId = `client-${crypto.randomBytes(6).toString('hex')}`;
        const { token } = this.generateToken(clientId, 'client', scopes, expiresInMs);
        const record = { clientId, name, scopes, status: 'active', createdAt: Date.now(), tokenHash: this.hashToken(token) };
        this.clients.set(clientId, record);
        this.save();
        return { clientId, token, record };
    }
    registerDevice(name, platform = 'windows', capabilities = ['local:read', 'local:write', 'local:test']) {
        const deviceId = `dev-${crypto.randomBytes(6).toString('hex')}`;
        const { token } = this.generateToken(deviceId, 'device', ['device:connect', ...capabilities]);
        const record = { deviceId, name, platform, status: 'offline', capabilities, registeredAt: Date.now(), tokenHash: this.hashToken(token) };
        this.devices.set(deviceId, record);
        this.save();
        return { deviceId, token, record };
    }
    rememberAuthenticatedDevice(rawToken, deviceId, name, capabilities, platform = 'windows') {
        const existing = this.devices.get(deviceId);
        const record = {
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
    isTokenRevoked(tokenId) { return this.revokedTokens.has(tokenId); }
    revokeToken(tokenId) { this.revokedTokens.add(tokenId); this.save(); }
    revokeDevice(deviceId, reason = 'Administrative revocation') {
        const dev = this.devices.get(deviceId);
        if (dev) {
            dev.status = 'revoked';
            dev.revokedAt = Date.now();
            dev.revocationReason = reason;
            this.save();
        }
    }
    updateDeviceStatus(deviceId, status, ip) {
        const dev = this.devices.get(deviceId);
        if (dev && dev.status !== 'revoked') {
            dev.status = status;
            if (status === 'online') {
                dev.lastConnectedAt = Date.now();
                dev.lastHeartbeatAt = Date.now();
            }
            if (ip)
                dev.ip = ip;
            this.save();
        }
    }
    updateDeviceHeartbeat(deviceId) {
        const dev = this.devices.get(deviceId);
        if (dev && dev.status === 'online') {
            dev.lastHeartbeatAt = Date.now();
            this.save();
        }
    }
    getDevice(deviceId) { return this.devices.get(deviceId); }
    listDevices() { return Array.from(this.devices.values()); }
    listClients() { return Array.from(this.clients.values()); }
}
exports.AuthManager = AuthManager;
