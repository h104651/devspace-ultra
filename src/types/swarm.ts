export type SwarmWorkerStatus = 'idle' | 'busy' | 'recovering' | 'stale' | 'offline';

export interface SwarmWorkerState {
  workerId: string;
  name: string;
  role: string;
  capabilities: string[];
  status: SwarmWorkerStatus;
  currentTaskId?: string;
  lastClaimAt?: number;
  lastHeartbeatAt?: number;
  leaseExpiresAt?: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
}

export interface SwarmTaskSpec {
  roleRequired?: string;
  taskTitle: string;
  prompt: string;
  contextFiles?: string[];
  timeoutMs?: number;
}

export interface WakeBridgeEvent {
  eventId: string;
  timestamp: number;
  channel: string;
  targetWorkerId?: string;
  action: 'WAKE' | 'NOTIFY' | 'CANCEL' | 'RECYCLE';
  payload?: any;
}
