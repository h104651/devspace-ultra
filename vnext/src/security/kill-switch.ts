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
            revokedDeviceIds: Array.isArray(persisted.revokedDeviceIds) ? persisted.revokedDeviceIds : [],
            revokedClientIds: Array.isArray(persisted.revokedClientIds) ? persisted.revokedClientIds : [],
            lastTriggeredAt: persisted.lastTriggeredAt,
            reason: persisted.reason
          };
        }
      } catch (err) {
        console.error('Failed to hydrate durable kill switch state:', err);
      }
    }
  }

  private load() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.state = JSON.parse(raw);
      } catch (err) {
        console.error('Failed to load kill switch state:', err);
      }
    }
  }

  private save() {
    if (this.filePath) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to persist kill switch state to file:', err);
      }
    }
    if (this.storageAdapter) {
      void this.storageAdapter.saveKillSwitchState({ ...this.state }).catch(err => {
        console.error('Failed to persist durable kill switch state:', err);
      });
    }
  }

  public getState(): KillSwitchState {
    return { ...this.state };
  }

  public triggerGlobalEmergencyStop(reason = 'Global emergency stop triggered'): void {
    this.state.globalEmergencyStop = true;
    this.state.lastTriggeredAt = Date.now();
    this.state.reason = reason;
    this.save();
  }

  public resetGlobalEmergencyStop(): void {
    this.state.globalEmergencyStop = false;
    this.state.lastTriggeredAt = Date.now();
    this.state.reason = 'Emergency stop cleared';
    this.save();
  }

  public setLocalAgentExecutionDisabled(disabled: boolean): void {
    this.state.disableLocalAgentExecution = disabled;
    this.save();
  }

  public setKaggleExecutionDisabled(disabled: boolean): void {
    this.state.disableKaggleExecution = disabled;
    this.save();
  }

  public setSwarmExecutionDisabled(disabled: boolean): void {
    this.state.disableSwarmExecution = disabled;
    this.save();
  }

  public revokeDevice(deviceId: string, reason?: string): void {
    if (!this.state.revokedDeviceIds.includes(deviceId)) {
      this.state.revokedDeviceIds.push(deviceId);
      this.state.lastTriggeredAt = Date.now();
      this.state.reason = `Device ${deviceId} revoked: ${reason || 'unspecified'}`;
      this.save();
    }
  }

  public revokeClient(clientId: string, reason?: string): void {
    if (!this.state.revokedClientIds.includes(clientId)) {
      this.state.revokedClientIds.push(clientId);
      this.state.lastTriggeredAt = Date.now();
      this.state.reason = `Client ${clientId} revoked: ${reason || 'unspecified'}`;
      this.save();
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
