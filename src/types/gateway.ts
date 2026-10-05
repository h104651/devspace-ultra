import { DurableTask } from './task';

export interface AgentRegisterMessage {
  type: 'AGENT_REGISTER';
  messageId: string;
  timestamp: number;
  deviceId: string;
  name: string;
  platform: 'windows' | 'linux' | 'darwin';
  capabilities: string[];
  token: string;
}

export interface AgentRegisteredMessage {
  type: 'AGENT_REGISTERED';
  messageId: string;
  timestamp: number;
  deviceId: string;
}

export interface AgentHeartbeatMessage {
  type: 'AGENT_HEARTBEAT';
  messageId: string;
  timestamp: number;
  deviceId: string;
  activeTaskIds: string[];
}

export interface AgentHeartbeatAckMessage {
  type: 'AGENT_HEARTBEAT_ACK';
  messageId: string;
  timestamp: number;
}

export interface TaskClaimPollMessage {
  type: 'TASK_CLAIM_POLL';
  messageId: string;
  timestamp: number;
  deviceId: string;
  supportedCapabilities: string[];
  maxTasks?: number;
}

export interface TaskAssignedMessage {
  type: 'TASK_ASSIGNED';
  messageId: string;
  timestamp: number;
  task: DurableTask;
}

export interface TaskAckMessage {
  type: 'TASK_ACK';
  messageId: string;
  timestamp: number;
  taskId: string;
  deviceId: string;
}

export interface TaskProgressMessage {
  type: 'TASK_PROGRESS';
  messageId: string;
  timestamp: number;
  taskId: string;
  deviceId: string;
  stage: string;
  percent?: number;
}

export interface TaskLogAppendMessage {
  type: 'TASK_LOG_APPEND';
  messageId: string;
  timestamp: number;
  taskId: string;
  deviceId: string;
  lines: string[];
}

export interface TaskCompleteMessage {
  type: 'TASK_COMPLETE';
  messageId: string;
  timestamp: number;
  taskId: string;
  deviceId: string;
  result: any;
}

export interface TaskFailMessage {
  type: 'TASK_FAIL';
  messageId: string;
  timestamp: number;
  taskId: string;
  deviceId: string;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface GenericErrorMessage {
  type: 'ERROR';
  messageId: string;
  timestamp: number;
  error: string;
}

export type GatewayMessage =
  | AgentRegisterMessage
  | AgentRegisteredMessage
  | AgentHeartbeatMessage
  | AgentHeartbeatAckMessage
  | TaskClaimPollMessage
  | TaskAssignedMessage
  | TaskAckMessage
  | TaskProgressMessage
  | TaskLogAppendMessage
  | TaskCompleteMessage
  | TaskFailMessage
  | GenericErrorMessage;
