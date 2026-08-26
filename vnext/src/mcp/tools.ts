export const REMOTE_TASK_SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    backend: {
      type: 'string',
      enum: ['kaggle', 'local', 'browser', 'swarm'],
      description: 'Target execution backend'
    },
    capability: {
      type: 'string',
      description: 'Capability name, e.g. kaggle:run, local:git_status, local:run_tests, swarm:dispatch'
    },
    payload: {
      type: 'object',
      description: 'Task specific payload dictionary'
    },
    priority: {
      type: 'number',
      description: 'Task priority (higher runs first)'
    },
    clientRequestId: {
      type: 'string',
      description: 'Idempotency client request ID'
    }
  },
  required: ['backend', 'capability', 'payload']
};

export const REMOTE_TASK_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'ID of the task to query'
    }
  },
  required: ['taskId']
};

export const REMOTE_TASK_LOGS_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'ID of the task'
    },
    limit: {
      type: 'number',
      description: 'Maximum number of recent log lines to retrieve (default 100)'
    }
  },
  required: ['taskId']
};

export const REMOTE_TASK_ARTIFACTS_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'ID of the task'
    }
  },
  required: ['taskId']
};

export const REMOTE_TASK_CANCEL_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'ID of the task to cancel'
    },
    reason: {
      type: 'string',
      description: 'Reason for cancellation'
    }
  },
  required: ['taskId']
};

export const KAGGLE_RUN_SCHEMA = {
  type: 'object',
  properties: {
    kernelSlug: {
      type: 'string',
      description: 'Kaggle kernel slug, e.g. "astor-training-run-001"'
    },
    title: {
      type: 'string',
      description: 'Title of the notebook / script'
    },
    code: {
      type: 'string',
      description: 'Python code or Jupyter notebook JSON to execute'
    },
    enableGpu: {
      type: 'boolean',
      description: 'Whether to request Free Kaggle GPU accelerator (T4/P100)'
    },
    enableInternet: {
      type: 'boolean',
      description: 'Whether internet access is enabled'
    },
    datasetDataSources: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional list of Kaggle dataset slugs'
    },
    clientRequestId: {
      type: 'string',
      description: 'Idempotency key'
    }
  },
  required: ['kernelSlug', 'code']
};

export const KAGGLE_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'Task ID returned by kaggle_run'
    }
  },
  required: ['taskId']
};

export const KAGGLE_LOGS_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'Task ID returned by kaggle_run'
    }
  },
  required: ['taskId']
};

export const KAGGLE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'Task ID returned by kaggle_run'
    }
  },
  required: ['taskId']
};

export const SWARM_DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    taskTitle: {
      type: 'string',
      description: 'Short title for the swarm task'
    },
    prompt: {
      type: 'string',
      description: 'Instruction prompt for the swarm worker'
    },
    roleRequired: {
      type: 'string',
      description: 'Target worker role (optional)'
    },
    timeoutMs: {
      type: 'number',
      description: 'Task timeout in milliseconds'
    }
  },
  required: ['taskTitle', 'prompt']
};

export const SWARM_STATUS_SCHEMA = {
  type: 'object',
  properties: {}
};

export const CHAT_SWARM_DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    swarmName: { type: 'string', description: 'Swarm name (default: "default")' },
    title: { type: 'string', description: 'Task title' },
    prompt: { type: 'string', description: 'Task prompt for worker' },
    roleRequired: { type: 'string', description: 'Required worker role' },
    timeoutMs: { type: 'number', description: 'Task timeout in milliseconds' }
  },
  required: ['prompt']
};

export const CHAT_SWARM_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    swarmName: { type: 'string', description: 'Swarm name (optional)' }
  }
};

export const CHAT_SWARM_NEXT_SCHEMA = {
  type: 'object',
  properties: {
    workerToken: { type: 'string', description: 'Worker session token' }
  },
  required: ['workerToken']
};

export const CHAT_SWARM_SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Task ID' },
    workerToken: { type: 'string', description: 'Worker session token' },
    result: { type: 'object', description: 'Task execution result' },
    error: { type: 'string', description: 'Error message if failed' }
  },
  required: ['taskId', 'workerToken']
};

export const CHAT_SWARM_CANCEL_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: 'Task ID to cancel' },
    reason: { type: 'string', description: 'Reason for cancellation' }
  },
  required: ['taskId']
};

export const CHAT_SWARM_WAKE_BRIDGE_SCHEMA = {
  type: 'object',
  properties: {
    swarmName: { type: 'string', description: 'Swarm name' }
  }
};

export const CHAT_SWARM_RUNTIME_STATUS_SCHEMA = {
  type: 'object',
  properties: {}
};

export const CHAT_SWARM_RUNTIME_SCALE_SCHEMA = {
  type: 'object',
  properties: {
    workerCount: { type: 'number', description: 'Target worker count' }
  },
  required: ['workerCount']
};

export const CHAT_SWARM_RUNTIME_RECOVER_SCHEMA = {
  type: 'object',
  properties: {
    workerNumber: { type: 'number', description: 'Worker number to recover' }
  }
};

export const DEVICE_STATUS_SCHEMA = {
  type: 'object',
  properties: {}
};

export const KILL_SWITCH_TRIGGER_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['EMERGENCY_STOP', 'CLEAR_STOP', 'REVOKE_DEVICE', 'REVOKE_CLIENT'],
      description: 'Kill switch action'
    },
    reason: {
      type: 'string',
      description: 'Reason for triggering kill switch'
    },
    deviceId: {
      type: 'string',
      description: 'Device ID if revoking a device'
    },
    clientId: {
      type: 'string',
      description: 'Client ID if revoking a client'
    }
  },
  required: ['action']
};
