export type TaskStatus =
  | 'queued'
  | 'claimed'
  | 'acknowledged'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'retrying'
  | 'stale';

export type TaskBackend = 'kaggle' | 'local' | 'browser' | 'swarm';

export interface TaskLease {
  claimedBy: string; // deviceId or workerId
  claimedAt: number; // timestamp ms
  leaseExpiresAt: number; // timestamp ms
  lastHeartbeatAt: number; // timestamp ms
  acknowledgedAt?: number;
}

export interface TaskRetryPolicy {
  maxRetries: number;
  retryCount: number;
  backoffMs: number;
  requeueOnStale: boolean;
}

export interface TaskArtifactSummary {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  mimeType: string;
  downloadUrl?: string;
  preview?: string;
}

export interface DurableTask<TPayload = any, TResult = any> {
  taskId: string;
  taskKey?: string;
  idempotencyKey?: string;
  clientRequestId?: string;
  backend: TaskBackend;
  capability: string; // e.g. 'kaggle:run', 'local:git_status', 'local:run_tests', 'swarm:dispatch'
  requiredScope: string;
  status: TaskStatus;
  priority: number;
  payload: TPayload;
  result?: TResult;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  lease?: TaskLease;
  retryPolicy: TaskRetryPolicy;
  artifacts: TaskArtifactSummary[];
  logs: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, any>;
}

export interface CreateTaskOptions<TPayload = any> {
  taskId?: string;
  taskKey?: string;
  idempotencyKey?: string;
  clientRequestId?: string;
  backend: TaskBackend;
  capability: string;
  requiredScope?: string;
  priority?: number;
  payload: TPayload;
  maxRetries?: number;
  leaseDurationMs?: number;
  metadata?: Record<string, any>;
}
