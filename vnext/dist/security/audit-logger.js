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
exports.AuditLogger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const redactor_1 = require("./redactor");
class AuditLogger {
    logFilePath;
    storageAdapter;
    constructor(storageDir, storageAdapter) {
        this.storageAdapter = storageAdapter;
        if (storageDir) {
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            this.logFilePath = path.join(storageDir, 'audit_log.jsonl');
        }
    }
    log(event) {
        const fullEvent = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...event,
            details: (0, redactor_1.redactObject)(event.details)
        };
        if (this.logFilePath) {
            try {
                const dir = path.dirname(this.logFilePath);
                if (fs.existsSync(dir)) {
                    fs.appendFileSync(this.logFilePath, JSON.stringify(fullEvent) + '\n', 'utf-8');
                }
            }
            catch { }
        }
        if (this.storageAdapter) {
            void this.storageAdapter.appendAuditLog(fullEvent).catch(err => {
                console.error(`Failed to persist audit event ${fullEvent.id}:`, err);
            });
        }
        return fullEvent;
    }
    getRecentLogs(limit = 100) {
        if (!this.logFilePath || !fs.existsSync(this.logFilePath))
            return [];
        try {
            const content = fs.readFileSync(this.logFilePath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);
            const events = [];
            for (const line of lines.slice(-limit)) {
                try {
                    events.push(JSON.parse(line));
                }
                catch { }
            }
            return events.reverse();
        }
        catch {
            return [];
        }
    }
}
exports.AuditLogger = AuditLogger;
