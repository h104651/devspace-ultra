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

export type TaskAttemptStatus =
  | 'claimed'
  | 'acknowledged'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

/**
 * One durable execution attempt for a task.
 *
 * Attempts are append-only history. A retry creates a new record rather than
 * overwriting the previous worker/lease state, so stale recovery and operator
 * diagnostics can distinguish "the task" from each concrete execution turn.
 */
export interface TaskAttempt {
  id: string;
  attemptNumber: number;
  status: TaskAttemptStatus;
  claimedBy: string;
  claimedAt: number;
  acknowledgedAt?: number;
  startedAt?: number;
  completedAt?: number;
  errorCode?: string;
  errorMessage?: string;
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

export interface ExternalRunInfo {
  provider: 'kaggle' | 'browser' | 'swarm';
  kernelRef?: string;
  versionNumber?: number | 'unknown';
  submittedAt: number;
  lastPolledAt?: number;
  lastRemoteStatus?: string;
  reconciliationState?: 'pending' | 'active' | 'completed' | 'failed';
  metadata?: Record<string, any>;
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
  /**
   * Optional for backwards compatibility with tasks persisted before the
   * attempt-ledger migration. New tasks always initialize this to an empty list.
   */
  attempts?: TaskAttempt[];
  /** ID of the single currently active attempt, if any. */
  activeAttemptId?: string;
  artifacts: TaskArtifactSummary[];
  logs: string[];
  externalRun?: ExternalRunInfo;
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
