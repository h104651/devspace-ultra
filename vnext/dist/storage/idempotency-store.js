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
exports.IdempotencyStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class IdempotencyStore {
    records = new Map();
    filePath;
    defaultTtlMs;
    storageAdapter;
    constructor(storageDir, defaultTtlMs = 24 * 3600 * 1000, storageAdapter) {
        this.defaultTtlMs = defaultTtlMs;
        this.storageAdapter = storageAdapter;
        if (storageDir) {
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            this.filePath = path.join(storageDir, 'idempotency_store.json');
            this.load();
        }
    }
    load() {
        if (this.filePath && fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const data = JSON.parse(raw);
                const now = Date.now();
                for (const [k, v] of Object.entries(data)) {
                    if (v.expiresAt > now) {
                        this.records.set(k, v);
                    }
                }
            }
            catch (err) {
                console.error('Failed to load idempotency store:', err);
            }
        }
    }
    save() {
        if (this.filePath) {
            try {
                const obj = {};
                for (const [k, v] of this.records.entries()) {
                    obj[k] = v;
                }
                fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
            }
            catch (err) {
                console.error('Failed to save idempotency store:', err);
            }
        }
    }
    get(key) {
        if (!key)
            return undefined;
        const record = this.records.get(key);
        if (!record)
            return undefined;
        if (Date.now() > record.expiresAt) {
            this.records.delete(key);
            this.save();
            return undefined;
        }
        return record.result;
    }
    async getDurable(key) {
        const local = this.get(key);
        if (local !== undefined)
            return local;
        if (!this.storageAdapter || !key)
            return undefined;
        const persisted = await this.storageAdapter.getIdempotency(key);
        if (!persisted)
            return undefined;
        const now = Date.now();
        this.records.set(key, {
            key,
            result: persisted,
            createdAt: now,
            expiresAt: now + this.defaultTtlMs
        });
        return persisted;
    }
    set(key, result, ttlMs) {
        if (!key)
            return;
        const now = Date.now();
        const expiresAt = now + (ttlMs ?? this.defaultTtlMs);
        this.records.set(key, {
            key,
            result,
            createdAt: now,
            expiresAt
        });
        this.save();
    }
    async setDurable(key, result, ttlMs) {
        this.set(key, result, ttlMs);
        if (this.storageAdapter && key && result?.taskId) {
            await this.storageAdapter.setIdempotency(key, result, ttlMs ?? this.defaultTtlMs);
        }
    }
}
exports.IdempotencyStore = IdempotencyStore;
