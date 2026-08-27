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
    storageAdapter;
    constructor(storageDirOrStorage) {
        if (typeof storageDirOrStorage === 'string') {
            if (!fs.existsSync(storageDirOrStorage)) {
                fs.mkdirSync(storageDirOrStorage, { recursive: true });
            }
            this.filePath = path.join(storageDirOrStorage, 'kill_switch_state.json');
            this.load();
        }
        else if (storageDirOrStorage && typeof storageDirOrStorage === 'object') {
            this.storageAdapter = storageDirOrStorage;
        }
    }
    async hydrate() {
        if (this.storageAdapter) {
            try {
                const persisted = await this.storageAdapter.getKillSwitchState();
                if (persisted) {
                    this.state = {
                        globalEmergencyStop: !!persisted.globalEmergencyStop,
                        disableLocalAgentExecution: !!persisted.disableLocalAgentExecution,
                        disableKaggleExecution: !!persisted.disableKaggleExecution,
                        disableSwarmExecution: !!persisted.disableSwarmExecution,
                        revokedDeviceIds: Array.isArray(persisted.revokedDeviceIds) ? [...persisted.revokedDeviceIds] : [],
                        revokedClientIds: Array.isArray(persisted.revokedClientIds) ? [...persisted.revokedClientIds] : [],
                        lastTriggeredAt: persisted.lastTriggeredAt,
                        reason: persisted.reason
                    };
                }
            }
            catch (err) {
                console.error('Failed to hydrate durable kill switch state (failing closed):', err);
                this.state = {
                    globalEmergencyStop: true,
                    disableLocalAgentExecution: true,
                    disableKaggleExecution: true,
                    disableSwarmExecution: true,
                    revokedDeviceIds: [],
                    revokedClientIds: [],
                    lastTriggeredAt: Date.now(),
                    reason: 'KILL_SWITCH_STATE_UNAVAILABLE: durable storage read failure during hydration'
                };
            }
        }
    }
    load() {
        if (this.filePath && fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.state = JSON.parse(raw);
            }
            catch (err) {
                console.error('Failed to load kill switch state (failing closed):', err);
                this.state = {
                    globalEmergencyStop: true,
                    disableLocalAgentExecution: true,
                    disableKaggleExecution: true,
                    disableSwarmExecution: true,
                    revokedDeviceIds: [],
                    revokedClientIds: [],
                    lastTriggeredAt: Date.now(),
                    reason: 'KILL_SWITCH_STATE_UNAVAILABLE: file read failure during load'
                };
            }
        }
    }
    async persistNextState(nextState) {
        if (this.filePath) {
            fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), 'utf-8');
        }
        if (this.storageAdapter) {
            await this.storageAdapter.saveKillSwitchState({ ...nextState });
        }
        // Only commit in-memory state after durable persistence succeeds
        this.state = nextState;
    }
    getState() {
        return { ...this.state };
    }
    async triggerGlobalEmergencyStop(reason = 'Global emergency stop triggered') {
        const nextState = {
            ...this.state,
            globalEmergencyStop: true,
            lastTriggeredAt: Date.now(),
            reason
        };
        try {
            await this.persistNextState(nextState);
        }
        catch (err) {
            // For EMERGENCY_STOP specifically, fail closed in memory if persistence failed
            this.state.globalEmergencyStop = true;
            this.state.reason = reason;
            throw err;
        }
    }
    async resetGlobalEmergencyStop() {
        const nextState = {
            ...this.state,
            globalEmergencyStop: false,
            lastTriggeredAt: Date.now(),
            reason: 'Emergency stop cleared'
        };
        await this.persistNextState(nextState);
    }
    async setLocalAgentExecutionDisabled(disabled) {
        const nextState = {
            ...this.state,
            disableLocalAgentExecution: disabled,
            lastTriggeredAt: Date.now()
        };
        await this.persistNextState(nextState);
    }
    async setKaggleExecutionDisabled(disabled) {
        const nextState = {
            ...this.state,
            disableKaggleExecution: disabled,
            lastTriggeredAt: Date.now()
        };
        await this.persistNextState(nextState);
    }
    async setSwarmExecutionDisabled(disabled) {
        const nextState = {
            ...this.state,
            disableSwarmExecution: disabled,
            lastTriggeredAt: Date.now()
        };
        await this.persistNextState(nextState);
    }
    async revokeDevice(deviceId, reason) {
        if (!this.state.revokedDeviceIds.includes(deviceId)) {
            const nextState = {
                ...this.state,
                revokedDeviceIds: [...this.state.revokedDeviceIds, deviceId],
                lastTriggeredAt: Date.now(),
                reason: `Device ${deviceId} revoked: ${reason || 'unspecified'}`
            };
            await this.persistNextState(nextState);
        }
    }
    async revokeClient(clientId, reason) {
        if (!this.state.revokedClientIds.includes(clientId)) {
            const nextState = {
                ...this.state,
                revokedClientIds: [...this.state.revokedClientIds, clientId],
                lastTriggeredAt: Date.now(),
                reason: `Client ${clientId} revoked: ${reason || 'unspecified'}`
            };
            await this.persistNextState(nextState);
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
