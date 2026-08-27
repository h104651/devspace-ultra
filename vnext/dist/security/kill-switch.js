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
exports.KillSwitch = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class KillSwitch {
    state = {
        globalEmergencyStop: false,
        disableLocalAgentExecution: false,
        disableKaggleExecution: false,
        disableSwarmExecution: false,
        revokedDeviceIds: [],
        revokedClientIds: []
    };
    filePath;
    constructor(storageDir) {
        if (storageDir) {
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            this.filePath = path.join(storageDir, 'kill_switch_state.json');
            this.load();
        }
    }
    load() {
        if (this.filePath && fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.state = JSON.parse(raw);
            }
            catch (err) {
                console.error('Failed to load kill switch state:', err);
            }
        }
    }
    save() {
        if (this.filePath) {
            try {
                fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
            }
            catch (err) {
                console.error('Failed to persist kill switch state:', err);
            }
        }
    }
    getState() {
        return { ...this.state };
    }
    triggerGlobalEmergencyStop(reason = 'Global emergency stop triggered') {
        this.state.globalEmergencyStop = true;
        this.state.lastTriggeredAt = Date.now();
        this.state.reason = reason;
        this.save();
    }
    resetGlobalEmergencyStop() {
        this.state.globalEmergencyStop = false;
        this.state.lastTriggeredAt = Date.now();
        this.state.reason = 'Emergency stop cleared';
        this.save();
    }
    setLocalAgentExecutionDisabled(disabled) {
        this.state.disableLocalAgentExecution = disabled;
        this.save();
    }
    setKaggleExecutionDisabled(disabled) {
        this.state.disableKaggleExecution = disabled;
        this.save();
    }
    setSwarmExecutionDisabled(disabled) {
        this.state.disableSwarmExecution = disabled;
        this.save();
    }
    revokeDevice(deviceId, reason) {
        if (!this.state.revokedDeviceIds.includes(deviceId)) {
            this.state.revokedDeviceIds.push(deviceId);
            this.state.lastTriggeredAt = Date.now();
            this.state.reason = `Device ${deviceId} revoked: ${reason || 'unspecified'}`;
            this.save();
        }
    }
    revokeClient(clientId, reason) {
        if (!this.state.revokedClientIds.includes(clientId)) {
            this.state.revokedClientIds.push(clientId);
            this.state.lastTriggeredAt = Date.now();
            this.state.reason = `Client ${clientId} revoked: ${reason || 'unspecified'}`;
            this.save();
        }
    }
    isDeviceRevoked(deviceId) {
        return this.state.globalEmergencyStop || this.state.revokedDeviceIds.includes(deviceId);
    }
    isClientRevoked(clientId) {
        return this.state.globalEmergencyStop || this.state.revokedClientIds.includes(clientId);
    }
    isExecutionAllowed(backend, deviceId) {
        if (this.state.globalEmergencyStop) {
            return { allowed: false, reason: `EMERGENCY_DENY_ALL: ${this.state.reason || 'Global kill switch active'}` };
        }
        if (backend === 'local') {
            if (this.state.disableLocalAgentExecution) {
                return { allowed: false, reason: 'LOCAL_AGENT_EXECUTION_DISABLED' };
            }
            if (deviceId && this.state.revokedDeviceIds.includes(deviceId)) {
                return { allowed: false, reason: `DEVICE_REVOKED: Device ${deviceId} has been revoked` };
            }
        }
        if (backend === 'kaggle' && this.state.disableKaggleExecution) {
            return { allowed: false, reason: 'KAGGLE_EXECUTION_DISABLED' };
        }
        if (backend === 'swarm' && this.state.disableSwarmExecution) {
            return { allowed: false, reason: 'SWARM_EXECUTION_DISABLED' };
        }
        return { allowed: true };
    }
}
exports.KillSwitch = KillSwitch;
