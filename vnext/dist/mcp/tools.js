"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KILL_SWITCH_TRIGGER_SCHEMA = exports.DEVICE_STATUS_SCHEMA = exports.CHAT_SWARM_RUNTIME_RECOVER_SCHEMA = exports.CHAT_SWARM_RUNTIME_SCALE_SCHEMA = exports.CHAT_SWARM_RUNTIME_STATUS_SCHEMA = exports.CHAT_SWARM_WAKE_BRIDGE_SCHEMA = exports.CHAT_SWARM_DOCK_SCHEMA = exports.CHAT_SWARM_CLOSE_SCHEMA = exports.CHAT_SWARM_LEAVE_SCHEMA = exports.CHAT_SWARM_RECYCLE_WORKER_SCHEMA = exports.CHAT_SWARM_CANCEL_SCHEMA = exports.CHAT_SWARM_COLLECT_SCHEMA = exports.CHAT_SWARM_SUBMIT_ONCE_SCHEMA = exports.CHAT_SWARM_SUBMIT_SCHEMA = exports.CHAT_SWARM_RECOVER_SCHEMA = exports.CHAT_SWARM_NEXT_SCHEMA = exports.CHAT_SWARM_ACK_SCHEMA = exports.CHAT_SWARM_CLAIM_SCHEMA = exports.CHAT_SWARM_DISPATCH_SCHEMA = exports.CHAT_SWARM_RESIZE_SCHEMA = exports.CHAT_SWARM_STATUS_SCHEMA = exports.CHAT_SWARM_JOIN_BROWSER_SCHEMA = exports.CHAT_SWARM_JOIN_SCHEMA = exports.CHAT_SWARM_CREATE_SCHEMA = exports.SWARM_STATUS_SCHEMA = exports.SWARM_DISPATCH_SCHEMA = exports.KAGGLE_PROJECT_CONTINUE_SCHEMA = exports.KAGGLE_PROJECT_LOGS_SCHEMA = exports.KAGGLE_PROJECT_OUTPUT_SCHEMA = exports.KAGGLE_PROJECT_FILES_SCHEMA = exports.KAGGLE_PROJECT_SOURCE_SCHEMA = exports.KAGGLE_PROJECT_GET_SCHEMA = exports.KAGGLE_PROJECT_LIST_SCHEMA = exports.KAGGLE_RESULT_SCHEMA = exports.KAGGLE_LOGS_SCHEMA = exports.KAGGLE_STATUS_SCHEMA = exports.KAGGLE_RUN_SCHEMA = exports.REMOTE_TASK_CANCEL_SCHEMA = exports.REMOTE_TASK_ARTIFACTS_SCHEMA = exports.REMOTE_TASK_LOGS_SCHEMA = exports.REMOTE_TASK_STATUS_SCHEMA = exports.REMOTE_TASK_SUBMIT_SCHEMA = void 0;
exports.REMOTE_TASK_SUBMIT_SCHEMA = {
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
exports.REMOTE_TASK_STATUS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string', description: 'ID of the task to query' } }, required: ['taskId'], additionalProperties: false };
exports.REMOTE_TASK_LOGS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' }, limit: { type: 'number', description: 'Maximum number of recent log lines to retrieve' } }, required: ['taskId'], additionalProperties: false };
exports.REMOTE_TASK_ARTIFACTS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
exports.REMOTE_TASK_CANCEL_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
exports.KAGGLE_RUN_SCHEMA = {
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
exports.KAGGLE_STATUS_SCHEMA = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };
exports.KAGGLE_LOGS_SCHEMA = exports.KAGGLE_STATUS_SCHEMA;
exports.KAGGLE_RESULT_SCHEMA = exports.KAGGLE_STATUS_SCHEMA;
exports.KAGGLE_PROJECT_LIST_SCHEMA = {
    type: 'object',
    properties: {
        search: { type: 'string', description: 'Search term to filter notebooks/scripts' },
        mine: { type: 'boolean', description: 'Only list own kernels (default: true)', default: true },
        kernelType: { type: 'string', enum: ['all', 'notebook', 'script'], default: 'all' },
        language: { type: 'string', description: 'Programming language (e.g. python, r)' },
        sortBy: { type: 'string', enum: ['hotness', 'commentCount', 'dateCreated', 'dateRun', 'scoreDescending', 'viewCount', 'voteCount'], default: 'dateRun' },
        pageSize: { type: 'number', minimum: 1, maximum: 50, default: 20 },
        pageToken: { type: 'string' }
    },
    additionalProperties: false
};
exports.KAGGLE_PROJECT_GET_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' }
    },
    required: ['kernelRef'],
    additionalProperties: false
};
exports.KAGGLE_PROJECT_SOURCE_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
        version: { type: 'number', description: 'Known historical version number if pulling specific version' },
        offset: { type: 'number', minimum: 0, default: 0, description: 'Character offset for pagination' },
        limit: { type: 'number', minimum: 1, maximum: 100000, default: 50000, description: 'Maximum characters to return in chunk (max 100000)' }
    },
    required: ['kernelRef'],
    additionalProperties: false
};
exports.KAGGLE_PROJECT_FILES_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
        pageSize: { type: 'number', default: 50 },
        pageToken: { type: 'string' }
    },
    required: ['kernelRef'],
    additionalProperties: false
};
exports.KAGGLE_PROJECT_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference' },
        filePattern: { type: 'string', description: 'Filename or pattern to retrieve' },
        maxBytes: { type: 'number', default: 1048576, description: 'Maximum bytes for direct inline return (default 1MB)' }
    },
    required: ['kernelRef'],
    additionalProperties: false
};
exports.KAGGLE_PROJECT_LOGS_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference' },
        limit: { type: 'number', default: 100, description: 'Maximum log lines' }
    },
    required: ['kernelRef'],
    additionalProperties: false
};
exports.KAGGLE_PROJECT_CONTINUE_SCHEMA = {
    type: 'object',
    properties: {
        kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
        expectedProjectFingerprint: { type: 'string', description: 'Expected optimistic concurrency fingerprint from kaggle_project_get' },
        mutation: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['append_notebook_cells', 'append_script', 'replace_source'] },
                cells: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            cellType: { type: 'string', enum: ['code', 'markdown'] },
                            source: { type: 'string' }
                        },
                        required: ['source']
                    }
                },
                code: { type: 'string' },
                source: { type: 'string' }
            },
            required: ['type'],
            additionalProperties: false
        },
        clientRequestId: { type: 'string', description: 'Idempotency client request ID' }
    },
    required: ['kernelRef', 'expectedProjectFingerprint', 'mutation'],
    additionalProperties: false
};
exports.SWARM_DISPATCH_SCHEMA = {
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
exports.SWARM_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
// Mature Chat Swarm compatibility schemas. Keep these intentionally aligned
// with the existing connector contract so a connector endpoint migration does
// not silently change model-visible arguments.
exports.CHAT_SWARM_CREATE_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        workerSlots: { type: 'integer', minimum: 1, maximum: 32, default: 9 }
    },
    additionalProperties: false
};
exports.CHAT_SWARM_JOIN_SCHEMA = {
    type: 'object',
    properties: {
        inviteCode: { type: 'string', minLength: 6, maxLength: 64 },
        label: { type: 'string', minLength: 1, maxLength: 80 }
    },
    required: ['inviteCode'],
    additionalProperties: false
};
exports.CHAT_SWARM_JOIN_BROWSER_SCHEMA = exports.CHAT_SWARM_JOIN_SCHEMA;
exports.CHAT_SWARM_STATUS_SCHEMA = {
    type: 'object',
    properties: { token: { type: 'string', minLength: 16 } },
    required: ['token'],
    additionalProperties: false
};
exports.CHAT_SWARM_RESIZE_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        workerSlots: { type: 'integer', minimum: 0, maximum: 32 }
    },
    required: ['orchestratorToken', 'workerSlots'],
    additionalProperties: false
};
exports.CHAT_SWARM_DISPATCH_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', minLength: 1, maxLength: 100000 },
                    targetWorkerId: { type: 'string', pattern: '^worker-[0-9]{2}$' },
                    taskKey: { type: 'string', minLength: 1, maxLength: 120 }
                },
                required: ['prompt'],
                additionalProperties: false
            }
        }
    },
    required: ['orchestratorToken', 'tasks'],
    additionalProperties: false
};
exports.CHAT_SWARM_CLAIM_SCHEMA = {
    type: 'object',
    properties: { workerToken: { type: 'string', minLength: 16 } },
    required: ['workerToken'],
    additionalProperties: false
};
exports.CHAT_SWARM_ACK_SCHEMA = {
    type: 'object',
    properties: {
        workerToken: { type: 'string', minLength: 16 },
        taskId: { type: 'string', minLength: 8 }
    },
    required: ['workerToken', 'taskId'],
    additionalProperties: false
};
exports.CHAT_SWARM_NEXT_SCHEMA = exports.CHAT_SWARM_CLAIM_SCHEMA;
exports.CHAT_SWARM_RECOVER_SCHEMA = exports.CHAT_SWARM_CLAIM_SCHEMA;
exports.CHAT_SWARM_SUBMIT_SCHEMA = {
    type: 'object',
    properties: {
        workerToken: { type: 'string', minLength: 16 },
        taskId: { type: 'string', minLength: 8 },
        status: { type: 'string', enum: ['completed', 'failed'], default: 'completed' },
        result: { type: 'string', maxLength: 200000, default: '' },
        error: { type: 'string', maxLength: 20000 }
    },
    required: ['workerToken', 'taskId'],
    additionalProperties: false
};
exports.CHAT_SWARM_SUBMIT_ONCE_SCHEMA = exports.CHAT_SWARM_SUBMIT_SCHEMA;
exports.CHAT_SWARM_COLLECT_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        taskIds: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 8 } },
        waitFor: { type: 'string', enum: ['none', 'any', 'all'], default: 'none' },
        waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 0 }
    },
    required: ['orchestratorToken'],
    additionalProperties: false
};
exports.CHAT_SWARM_CANCEL_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        taskIds: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 8 } },
        reason: { type: 'string', maxLength: 500 }
    },
    required: ['orchestratorToken', 'taskIds'],
    additionalProperties: false
};
exports.CHAT_SWARM_RECYCLE_WORKER_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        workerId: { type: 'string', pattern: '^worker-[0-9]{2}$' },
        force: { type: 'boolean', default: false },
        reason: { type: 'string', maxLength: 500 }
    },
    required: ['orchestratorToken', 'workerId'],
    additionalProperties: false
};
exports.CHAT_SWARM_LEAVE_SCHEMA = exports.CHAT_SWARM_CLAIM_SCHEMA;
exports.CHAT_SWARM_CLOSE_SCHEMA = {
    type: 'object',
    properties: {
        orchestratorToken: { type: 'string', minLength: 16 },
        cancelPending: { type: 'boolean', default: true }
    },
    required: ['orchestratorToken'],
    additionalProperties: false
};
exports.CHAT_SWARM_DOCK_SCHEMA = exports.CHAT_SWARM_CLAIM_SCHEMA;
exports.CHAT_SWARM_WAKE_BRIDGE_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
exports.CHAT_SWARM_RUNTIME_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
exports.CHAT_SWARM_RUNTIME_SCALE_SCHEMA = { type: 'object', properties: { workerCount: { type: 'number', minimum: 0, maximum: 32 } }, required: ['workerCount'], additionalProperties: false };
exports.CHAT_SWARM_RUNTIME_RECOVER_SCHEMA = { type: 'object', properties: { workerNumber: { type: 'number' } }, additionalProperties: false };
exports.DEVICE_STATUS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
exports.KILL_SWITCH_TRIGGER_SCHEMA = {
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
