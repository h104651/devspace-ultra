import * as fs from 'fs';
import * as path from 'path';

export interface KillSwitchState {
  globalEmergencyStop: boolean;
  disableLocalAgentExecution: boolean;
  disableKaggleExecution: boolean;
  disableSwarmExecution: boolean;
  revokedDeviceIds: string[];
  revokedClientIds: string[];
  lastTriggeredAt?: number;
  reason?: string;
}

export interface IKillSwitchStorage {
  getKillSwitchState(): Promise<KillSwitchState | undefined>;
  saveKillSwitchState(state: KillSwitchState): Promise<void>;
}

export class KillSwitch {
  private state: KillSwitchState = {
    globalEmergencyStop: false,
    disableLocalAgentExecution: false,
    disableKaggleExecution: false,
    disableSwarmExecution: false,
    revokedDeviceIds: [],
    revokedClientIds: []
  };

  private filePath?: string;
  private storageAdapter?: IKillSwitchStorage;

  constructor(storageDirOrStorage?: string | IKillSwitchStorage) {
    if (typeof storageDirOrStorage === 'string') {
      if (!fs.existsSync(storageDirOrStorage)) {
        fs.mkdirSync(storageDirOrStorage, { recursive: true });
      }
      this.filePath = path.join(storageDirOrStorage, 'kill_switch_state.json');
      this.load();
    } else if (storageDirOrStorage && typeof storageDirOrStorage === 'object') {
      this.storageAdapter = storageDirOrStorage;
    }
  }

  public async hydrate(): Promise<void> {
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
      } catch (err) {
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

  private load() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.state = JSON.parse(raw);
      } catch (err) {
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

  private async persistNextState(nextState: KillSwitchState): Promise<void> {
    if (this.filePath) {
      fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), 'utf-8');
    }
    if (this.storageAdapter) {
      await this.storageAdapter.saveKillSwitchState({ ...nextState });
    }
    // Only commit in-memory state after durable persistence succeeds
    this.state = nextState;
  }

  public getState(): KillSwitchState {
    return { ...this.state };
  }

  public async triggerGlobalEmergencyStop(reason = 'Global emergency stop triggered'): Promise<void> {
    const nextState: KillSwitchState = {
      ...this.state,
      globalEmergencyStop: true,
      lastTriggeredAt: Date.now(),
      reason
    };
    try {
      await this.persistNextState(nextState);
    } catch (err) {
      // For EMERGENCY_STOP specifically, fail closed in memory if persistence failed
      this.state.globalEmergencyStop = true;
      this.state.reason = reason;
      throw err;
    }
  }

  public async resetGlobalEmergencyStop(): Promise<void> {
    const nextState: KillSwitchState = {
      ...this.state,
      globalEmergencyStop: false,
      lastTriggeredAt: Date.now(),
      reason: 'Emergency stop cleared'
    };
    await this.persistNextState(nextState);
  }

  public async setLocalAgentExecutionDisabled(disabled: boolean): Promise<void> {
    const nextState: KillSwitchState = {
      ...this.state,
      disableLocalAgentExecution: disabled,
      lastTriggeredAt: Date.now()
    };
    await this.persistNextState(nextState);
  }

  public async setKaggleExecutionDisabled(disabled: boolean): Promise<void> {
    const nextState: KillSwitchState = {
      ...this.state,
      disableKaggleExecution: disabled,
      lastTriggeredAt: Date.now()
    };
    await this.persistNextState(nextState);
  }

  public async setSwarmExecutionDisabled(disabled: boolean): Promise<void> {
    const nextState: KillSwitchState = {
      ...this.state,
      disableSwarmExecution: disabled,
      lastTriggeredAt: Date.now()
    };
    await this.persistNextState(nextState);
  }

  public async revokeDevice(deviceId: string, reason?: string): Promise<void> {
    if (!this.state.revokedDeviceIds.includes(deviceId)) {
      const nextState: KillSwitchState = {
        ...this.state,
        revokedDeviceIds: [...this.state.revokedDeviceIds, deviceId],
        lastTriggeredAt: Date.now(),
        reason: `Device ${deviceId} revoked: ${reason || 'unspecified'}`
      };
      await this.persistNextState(nextState);
    }
  }

  public async revokeClient(clientId: string, reason?: string): Promise<void> {
    if (!this.state.revokedClientIds.includes(clientId)) {
      const nextState: KillSwitchState = {
        ...this.state,
        revokedClientIds: [...this.state.revokedClientIds, clientId],
        lastTriggeredAt: Date.now(),
        reason: `Client ${clientId} revoked: ${reason || 'unspecified'}`
      };
      await this.persistNextState(nextState);
    }
  }

  public isDeviceRevoked(deviceId: string): boolean {
    return this.state.globalEmergencyStop || this.state.revokedDeviceIds.includes(deviceId);
  }

  public isClientRevoked(clientId: string): boolean {
    return this.state.globalEmergencyStop || this.state.revokedClientIds.includes(clientId);
  }

  public isExecutionAllowed(backend: 'kaggle' | 'local' | 'browser' | 'swarm', deviceId?: string): {
    allowed: boolean;
    reason?: string;
  } {
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
