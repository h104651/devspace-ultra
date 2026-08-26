export const REMOTE_TASK_SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    backend: { type: 'string', enum: ['kaggle', 'local', 'browser', 'swarm'], description: 'Target execution backend' },
    capability: { type: 'string', description: 'Capability name, e.g. kaggle:run, local:git_status, local:run_tests, swarm:dispatch' },
    payload: { type: 'object', description: 'Task specific payload dictionary' },
    priority: { type: 'number', description: 'Task priority (higher runs first)' },
    clientRequestId: { type: 'string', description: 'Idempotency client request ID' }
  },
  required: ['backend', 'capability', 'payload'],
  additionalProperties: false
};

export const REMOTE_TASK_STATUS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string', description: 'ID of the task to query' } }, required: ['taskId'], additionalProperties: false };
export const REMOTE_TASK_LOGS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' }, limit: { type: 'number', description: 'Maximum number of recent log lines to retrieve' } }, required: ['taskId'], additionalProperties: false };
export const REMOTE_TASK_ARTIFACTS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
export const REMOTE_TASK_CANCEL_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'], additionalProperties: false };

export const KAGGLE_RUN_SCHEMA = {
  type: 'object',
  properties: {
    kernelSlug: { type: 'string' },
    title: { type: 'string' },
    code: { type: 'string' },
    enableGpu: { type: 'boolean' },
    enableInternet: { type: 'boolean' },
    datasetDataSources: { type: 'array', items: { type: 'string' } },
    clientRequestId: { type: 'string' }
  },
  required: ['kernelSlug', 'code'],
  additionalProperties: false
};
export const KAGGLE_STATUS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
export const KAGGLE_LOGS_SCHEMA = KAGGLE_STATUS_SCHEMA;
export const KAGGLE_RESULT_SCHEMA = KAGGLE_STATUS_SCHEMA;

export const SWARM_DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    taskTitle: { type: 'string' },
    prompt: { type: 'string' },
    roleRequired: { type: 'string' },
    contextFiles: { type: 'array', items: { type: 'string' } },
    timeoutMs: { type: 'number' }
  },
  required: ['taskTitle', 'prompt'],
  additionalProperties: false
};
export const SWARM_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

export const CHAT_SWARM_DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    swarmName: { type: 'string' },
    title: { type: 'string' },
    prompt: { type: 'string' },
    roleRequired: { type: 'string' },
    contextFiles: { type: 'array', items: { type: 'string' } },
    timeoutMs: { type: 'number' }
  },
  required: ['prompt'],
  additionalProperties: false
};
export const CHAT_SWARM_STATUS_SCHEMA = { type: 'object', properties: { swarmName: { type: 'string' } }, additionalProperties: false };
export const CHAT_SWARM_CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    workerName: { type: 'string', description: 'Worker label' },
    role: { type: 'string', description: 'Worker role' },
    capabilities: { type: 'array', items: { type: 'string' } }
  },
  additionalProperties: false
};
export const CHAT_SWARM_NEXT_SCHEMA = { type: 'object', properties: { workerToken: { type: 'string', minLength: 8 } }, required: ['workerToken'], additionalProperties: false };
export const CHAT_SWARM_SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    workerToken: { type: 'string' },
    result: { type: 'object' },
    error: { type: 'string' }
  },
  required: ['taskId', 'workerToken'],
  additionalProperties: false
};
export const CHAT_SWARM_CANCEL_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
export const CHAT_SWARM_WAKE_BRIDGE_SCHEMA = { type: 'object', properties: { swarmName: { type: 'string' } }, additionalProperties: false };
export const CHAT_SWARM_RUNTIME_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
export const CHAT_SWARM_RUNTIME_SCALE_SCHEMA = { type: 'object', properties: { workerCount: { type: 'number', minimum: 0, maximum: 32 } }, required: ['workerCount'], additionalProperties: false };
export const CHAT_SWARM_RUNTIME_RECOVER_SCHEMA = { type: 'object', properties: { workerNumber: { type: 'number' } }, additionalProperties: false };
export const DEVICE_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
export const KILL_SWITCH_TRIGGER_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['EMERGENCY_STOP', 'CLEAR_STOP', 'REVOKE_DEVICE', 'REVOKE_CLIENT'] },
    reason: { type: 'string' },
    deviceId: { type: 'string' },
    clientId: { type: 'string' }
  },
  required: ['action'],
  additionalProperties: false
};
