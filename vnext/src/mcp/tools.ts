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

export const KAGGLE_PROJECT_LIST_SCHEMA = {
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

export const KAGGLE_PROJECT_GET_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' }
  },
  required: ['kernelRef'],
  additionalProperties: false
};

export const KAGGLE_PROJECT_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
    version: { type: 'number', description: 'Known historical version number if pulling specific version' },
    offset: { type: 'number', minimum: 0, default: 0, description: 'Character offset for raw content pagination' },
    limit: { type: 'number', minimum: 1, maximum: 100000, default: 50000, description: 'Maximum characters to return in raw content chunk (max 100000)' },
    includeCells: { type: 'boolean', default: false, description: 'Whether to include structured cell metadata' },
    cellOffset: { type: 'number', minimum: 0, default: 0, description: 'Starting cell index for pagination' },
    cellLimit: { type: 'number', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of cells to return' },
    includeCellSource: { type: 'boolean', default: false, description: 'Whether to include cell source text in the cell items' },
    maxCellSourceChars: { type: 'number', minimum: 1, maximum: 50000, default: 20000, description: 'Maximum characters per cell source when includeCellSource is true' }
  },
  required: ['kernelRef'],
  additionalProperties: false
};

export const KAGGLE_PROJECT_FILES_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
    pageSize: { type: 'number', default: 50 },
    pageToken: { type: 'string' }
  },
  required: ['kernelRef'],
  additionalProperties: false
};

export const KAGGLE_PROJECT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference' },
    filePattern: { type: 'string', description: 'Filename or pattern to retrieve' },
    maxBytes: { type: 'number', default: 1048576, description: 'Maximum bytes for direct inline return (default 1MB)' }
  },
  required: ['kernelRef'],
  additionalProperties: false
};

export const KAGGLE_PROJECT_LOGS_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference' },
    limit: { type: 'number', default: 100, description: 'Maximum log lines' }
  },
  required: ['kernelRef'],
  additionalProperties: false
};

export const KAGGLE_PROJECT_CONTINUE_SCHEMA = {
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

export const KAGGLE_PROJECT_RESTORE_SCHEMA = {
  type: 'object',
  properties: {
    kernelRef: { type: 'string', description: 'Kaggle project reference, e.g. "owner/kernel-slug"' },
    expectedCurrentFingerprint: { type: 'string', description: 'Expected optimistic concurrency fingerprint from kaggle_project_get' },
    source: { type: 'string', description: 'Complete trusted notebook or script source code' },
    sourceSha256: { type: 'string', description: 'SHA-256 hash of the provided source' },
    kernelType: { type: 'string', enum: ['notebook', 'script'], description: 'Kernel type' },
    language: { type: 'string', enum: ['python', 'r'], default: 'python' },
    enableGpu: { type: 'boolean', description: 'Enable GPU acceleration' },
    enableInternet: { type: 'boolean', description: 'Enable Internet access' },
    machineShape: { type: 'string', description: 'Hardware shape (e.g. NvidiaTeslaT4)' },
    datasetDataSources: { type: 'array', items: { type: 'string' } },
    competitionDataSources: { type: 'array', items: { type: 'string' } },
    kernelDataSources: { type: 'array', items: { type: 'string' } },
    modelDataSources: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object', description: 'Optional project settings dictionary' },
    reason: { type: 'string', description: 'Explicit reason for restore operation' },
    clientRequestId: { type: 'string', description: 'Idempotency client request ID' }
  },
  required: ['kernelRef', 'expectedCurrentFingerprint', 'source', 'sourceSha256', 'kernelType', 'reason'],
  additionalProperties: false
};

export const KAGGLE_WORKSPACE_GET_SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string', description: 'Dataset or project workspace reference, e.g. "astorhsu/astor-tuneup-project"' }
  },
  required: ['project'],
  additionalProperties: false
};

export const KAGGLE_WORKSPACE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string', description: 'Dataset or project workspace reference' },
    path: { type: 'string', description: 'Relative path of file in workspace' },
    offset: { type: 'number', default: 0, description: 'Character offset for chunking' },
    limit: { type: 'number', default: 50000, description: 'Maximum characters to return' }
  },
  required: ['project', 'path'],
  additionalProperties: false
};

export const KAGGLE_WORKSPACE_CONTINUE_SCHEMA = {
  type: 'object',
  properties: {
    project: { type: 'string', description: 'Dataset or project workspace reference' },
    expectedWorkspaceFingerprint: { type: 'string', description: 'Expected optimistic concurrency fingerprint from kaggle_workspace_get' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          expectedSha256: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      },
      description: 'List of file updates or additions to apply to the workspace'
    },
    experimentEntrypoint: { type: 'string', description: 'Experiment entrypoint script or module to execute in runner' },
    runnerKernelRef: { type: 'string', description: 'Optional runner kernel ref' },
    reason: { type: 'string', description: 'Reason for workspace mutation' },
    clientRequestId: { type: 'string', description: 'Idempotency client request ID' }
  },
  required: ['project', 'expectedWorkspaceFingerprint', 'changes', 'reason'],
  additionalProperties: false
};

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

// Mature Chat Swarm compatibility schemas. Keep these intentionally aligned
// with the existing connector contract so a connector endpoint migration does
// not silently change model-visible arguments.
export const CHAT_SWARM_CREATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    workerSlots: { type: 'integer', minimum: 1, maximum: 32, default: 9 }
  },
  additionalProperties: false
};

export const CHAT_SWARM_JOIN_SCHEMA = {
  type: 'object',
  properties: {
    inviteCode: { type: 'string', minLength: 6, maxLength: 64 },
    label: { type: 'string', minLength: 1, maxLength: 80 }
  },
  required: ['inviteCode'],
  additionalProperties: false
};
export const CHAT_SWARM_JOIN_BROWSER_SCHEMA = CHAT_SWARM_JOIN_SCHEMA;

export const CHAT_SWARM_STATUS_SCHEMA = {
  type: 'object',
  properties: { token: { type: 'string', minLength: 16 } },
  required: ['token'],
  additionalProperties: false
};

export const CHAT_SWARM_RESIZE_SCHEMA = {
  type: 'object',
  properties: {
    orchestratorToken: { type: 'string', minLength: 16 },
    workerSlots: { type: 'integer', minimum: 0, maximum: 32 }
  },
  required: ['orchestratorToken', 'workerSlots'],
  additionalProperties: false
};

export const CHAT_SWARM_DISPATCH_SCHEMA = {
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

export const CHAT_SWARM_CLAIM_SCHEMA = {
  type: 'object',
  properties: { workerToken: { type: 'string', minLength: 16 } },
  required: ['workerToken'],
  additionalProperties: false
};

export const CHAT_SWARM_ACK_SCHEMA = {
  type: 'object',
  properties: {
    workerToken: { type: 'string', minLength: 16 },
    taskId: { type: 'string', minLength: 8 }
  },
  required: ['workerToken', 'taskId'],
  additionalProperties: false
};

export const CHAT_SWARM_NEXT_SCHEMA = CHAT_SWARM_CLAIM_SCHEMA;
export const CHAT_SWARM_RECOVER_SCHEMA = CHAT_SWARM_CLAIM_SCHEMA;

export const CHAT_SWARM_SUBMIT_SCHEMA = {
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
export const CHAT_SWARM_SUBMIT_ONCE_SCHEMA = CHAT_SWARM_SUBMIT_SCHEMA;

export const CHAT_SWARM_COLLECT_SCHEMA = {
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

export const CHAT_SWARM_CANCEL_SCHEMA = {
  type: 'object',
  properties: {
    orchestratorToken: { type: 'string', minLength: 16 },
    taskIds: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 8 } },
    reason: { type: 'string', maxLength: 500 }
  },
  required: ['orchestratorToken', 'taskIds'],
  additionalProperties: false
};

export const CHAT_SWARM_RECYCLE_WORKER_SCHEMA = {
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

export const CHAT_SWARM_LEAVE_SCHEMA = CHAT_SWARM_CLAIM_SCHEMA;

export const CHAT_SWARM_CLOSE_SCHEMA = {
  type: 'object',
  properties: {
    orchestratorToken: { type: 'string', minLength: 16 },
    cancelPending: { type: 'boolean', default: true }
  },
  required: ['orchestratorToken'],
  additionalProperties: false
};

export const CHAT_SWARM_DOCK_SCHEMA = CHAT_SWARM_CLAIM_SCHEMA;
export const CHAT_SWARM_WAKE_BRIDGE_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };
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

export const LOCAL_PROJECT_LIST_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

export const LOCAL_PROJECT_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier (e.g. "astor-tuneup", "devspace-ultra")' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Relative path within the target project' },
    limit: { type: 'number', description: 'Maximum character limit to read' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId', 'relativePath'],
  additionalProperties: false
};

export const LOCAL_WRITE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Relative path within the target project' },
    content: { type: 'string', description: 'Content to write to the file' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId', 'relativePath', 'content'],
  additionalProperties: false
};

export const LOCAL_PATCH_FILE_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Relative path within the target project' },
    expectedSha256: { type: 'string', description: 'Expected current file SHA256 hex digest for optimistic concurrency control' },
    patches: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', description: 'Exact text chunk to match and replace' },
          newText: { type: 'string', description: 'New text chunk to substitute' },
          expectedOccurrences: { type: 'number', default: 1, description: 'Expected occurrence count (default: 1)' }
        },
        required: ['oldText', 'newText'],
        additionalProperties: false
      },
      description: 'Ordered list of deterministic text replacement operations'
    },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId', 'relativePath', 'expectedSha256', 'patches'],
  additionalProperties: false
};

export const LOCAL_LIST_DIRECTORY_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Relative path of directory inside workspace project to list', default: '.' },
    maxEntries: { type: 'number', description: 'Maximum number of directory entries to return (default 100, max 1000)', default: 100 },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_FIND_FILES_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Optional starting relative sub-path in workspace', default: '.' },
    pattern: { type: 'string', description: 'Optional filename pattern or substring to search for (e.g. pubspec.yaml, *.dart, *test*)' },
    recursive: { type: 'boolean', description: 'Whether to search subdirectories recursively', default: true },
    maxDepth: { type: 'number', description: 'Optional maximum subdirectory search depth' },
    maxResults: { type: 'number', description: 'Maximum search results to return (default 100, max 500)', default: 100 },
    type: { type: 'string', enum: ['file', 'directory', 'all'], description: 'Filter entries by type', default: 'all' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_SEARCH_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    query: { type: 'string', description: 'Text substring or pattern to search for within files' },
    relativePath: { type: 'string', description: 'Optional starting relative sub-path in workspace', default: '.' },
    pattern: { type: 'string', description: 'Optional filename filter pattern (e.g. *.dart, *.ts)' },
    caseSensitive: { type: 'boolean', description: 'Case sensitive matching', default: false },
    recursive: { type: 'boolean', description: 'Whether to search recursively', default: true },
    maxDepth: { type: 'number', description: 'Optional maximum subdirectory search depth (default 15)', default: 15 },
    maxResults: { type: 'number', description: 'Maximum matching lines to return (default 100, max 500)', default: 100 },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId', 'query'],
  additionalProperties: false
};

export const LOCAL_FIND_REPOSITORIES_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Optional starting relative sub-path in workspace', default: '.' },
    maxDepth: { type: 'number', description: 'Maximum search depth for repository discovery (default 10)', default: 10 },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_CREATE_DIRECTORY_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    relativePath: { type: 'string', description: 'Relative path of directory to create inside workspace project' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId', 'relativePath'],
  additionalProperties: false
};

export const LOCAL_GIT_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    repoRelativePath: { type: 'string', description: 'Optional relative path of subproject Git repository within the workspace' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_RUN_TESTS_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    runnerId: { type: 'string', description: 'Configured test runner ID or standard runner (npm, pytest, flutter)', default: 'npm' },
    workingRelativePath: { type: 'string', description: 'Optional subproject working directory relative to workspace root', default: '.' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export const LOCAL_BUILD_PROJECT_SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', description: 'Target registered project identifier' },
    commandId: { type: 'string', description: 'Configured build command ID or standard command (npm, flutter)', default: 'npm' },
    workingRelativePath: { type: 'string', description: 'Optional subproject working directory relative to workspace root', default: '.' },
    clientRequestId: { type: 'string' }
  },
  required: ['projectId'],
  additionalProperties: false
};

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

export function getCanonicalToolsList(): McpToolDefinition[] {
  return [
    { name: 'remote_task_submit', description: 'Submit durable task to local agent, Kaggle, browser, or swarm backend', inputSchema: REMOTE_TASK_SUBMIT_SCHEMA },
    { name: 'remote_task_status', description: 'Query durable task status', inputSchema: REMOTE_TASK_STATUS_SCHEMA },
    { name: 'remote_task_logs', description: 'Fetch task execution logs', inputSchema: REMOTE_TASK_LOGS_SCHEMA },
    { name: 'remote_task_artifacts', description: 'List task artifacts', inputSchema: REMOTE_TASK_ARTIFACTS_SCHEMA },
    { name: 'remote_task_cancel', description: 'Cancel active task', inputSchema: REMOTE_TASK_CANCEL_SCHEMA },
    { name: 'kaggle_run', description: 'Run code on Kaggle backend', inputSchema: KAGGLE_RUN_SCHEMA },
    { name: 'kaggle_status', description: 'Check Kaggle execution status', inputSchema: KAGGLE_STATUS_SCHEMA },
    { name: 'kaggle_logs', description: 'Fetch Kaggle execution logs', inputSchema: KAGGLE_LOGS_SCHEMA },
    { name: 'kaggle_result', description: 'Retrieve Kaggle results and artifacts', inputSchema: KAGGLE_RESULT_SCHEMA },

    { name: 'kaggle_project_list', description: 'Discover existing Kaggle notebooks and scripts', inputSchema: KAGGLE_PROJECT_LIST_SCHEMA },
    { name: 'kaggle_project_get', description: 'Retrieve current Kaggle project metadata and optimistic concurrency fingerprint', inputSchema: KAGGLE_PROJECT_GET_SCHEMA },
    { name: 'kaggle_project_source', description: 'Read current or known-version project source code with notebook cell structure', inputSchema: KAGGLE_PROJECT_SOURCE_SCHEMA },
    { name: 'kaggle_project_files', description: 'List latest kernel output file metadata', inputSchema: KAGGLE_PROJECT_FILES_SCHEMA },
    { name: 'kaggle_project_output', description: 'Retrieve output from latest run of an existing kernel directly by project ref', inputSchema: KAGGLE_PROJECT_OUTPUT_SCHEMA },
    { name: 'kaggle_project_logs', description: 'Retrieve latest kernel execution logs directly by project ref', inputSchema: KAGGLE_PROJECT_LOGS_SCHEMA },
    { name: 'kaggle_project_continue', description: 'Safely continue an existing persistent Kaggle project with conflict and ownership protection', inputSchema: KAGGLE_PROJECT_CONTINUE_SCHEMA },
    { name: 'kaggle_project_restore', description: 'Explicitly restore an owned Kaggle project from trusted source when remote state is corrupted or suspicious', inputSchema: KAGGLE_PROJECT_RESTORE_SCHEMA },
    { name: 'kaggle_workspace_get', description: 'Retrieve Kaggle dataset-backed project workspace manifest, fingerprint, and file outline', inputSchema: KAGGLE_WORKSPACE_GET_SCHEMA },
    { name: 'kaggle_workspace_file', description: 'Read a specific file from the project workspace with bounded chunking', inputSchema: KAGGLE_WORKSPACE_FILE_SCHEMA },
    { name: 'kaggle_workspace_continue', description: 'Atomically update project workspace dataset version, apply file changes, and trigger thin runner execution', inputSchema: KAGGLE_WORKSPACE_CONTINUE_SCHEMA },

    { name: 'local_project_list', description: 'List registered and authorized local projects with capabilities and metadata', inputSchema: LOCAL_PROJECT_LIST_SCHEMA },
    { name: 'local_project_status', description: 'Inspect status, git branch, and capabilities of an authorized local project', inputSchema: LOCAL_PROJECT_STATUS_SCHEMA },
    { name: 'local_read_file', description: 'Read file content from an authorized local project using relative path', inputSchema: LOCAL_READ_FILE_SCHEMA },
    { name: 'local_write_file', description: 'Write or overwrite file in an authorized local project using relative path', inputSchema: LOCAL_WRITE_FILE_SCHEMA },
    { name: 'local_patch_file', description: 'Patch or create file in an authorized local project using relative path', inputSchema: LOCAL_PATCH_FILE_SCHEMA },
    { name: 'local_list_directory', description: 'List directory entries within an authorized local project or workspace', inputSchema: LOCAL_LIST_DIRECTORY_SCHEMA },
    { name: 'local_find_files', description: 'Recursively search for files matching name or pattern within an authorized workspace', inputSchema: LOCAL_FIND_FILES_SCHEMA },
    { name: 'local_search_text', description: 'Search for text query across files within an authorized local workspace', inputSchema: LOCAL_SEARCH_TEXT_SCHEMA },
    { name: 'local_find_repositories', description: 'Recursively discover Git repositories and project types within an authorized workspace', inputSchema: LOCAL_FIND_REPOSITORIES_SCHEMA },
    { name: 'local_create_directory', description: 'Create directory within an authorized local workspace root', inputSchema: LOCAL_CREATE_DIRECTORY_SCHEMA },
    { name: 'local_git_status', description: 'Get git status of an authorized local workspace or nested subproject repository', inputSchema: LOCAL_GIT_STATUS_SCHEMA },
    { name: 'local_run_tests', description: 'Run test suite inside an authorized local project or subproject root', inputSchema: LOCAL_RUN_TESTS_SCHEMA },
    { name: 'local_build_project', description: 'Execute build command inside an authorized local project or subproject root', inputSchema: LOCAL_BUILD_PROJECT_SCHEMA },

    { name: 'chat_swarm_create', description: 'Create a durable Chat Swarm and return an invite code plus private orchestrator token', inputSchema: CHAT_SWARM_CREATE_SCHEMA },
    { name: 'chat_swarm_join', description: 'Join an existing Chat Swarm worker slot using its invite code', inputSchema: CHAT_SWARM_JOIN_SCHEMA },
    { name: 'chat_swarm_dock', description: 'Mount the persistent Worker Dock stream for an existing worker token', inputSchema: CHAT_SWARM_DOCK_SCHEMA },
    { name: 'chat_swarm_join_browser', description: 'Join a Chat Swarm and prepare the browser wake bridge binding marker', inputSchema: CHAT_SWARM_JOIN_BROWSER_SCHEMA },
    { name: 'chat_swarm_status', description: 'Return durable Chat Swarm roster, capacity and task counts', inputSchema: CHAT_SWARM_STATUS_SCHEMA },
    { name: 'chat_swarm_resize', description: 'Resize an active Chat Swarm without interrupting protected workers', inputSchema: CHAT_SWARM_RESIZE_SCHEMA },
    { name: 'chat_swarm_dispatch', description: 'Atomically dispatch a batch of idempotent Chat Swarm tasks', inputSchema: CHAT_SWARM_DISPATCH_SCHEMA },
    { name: 'chat_swarm_claim', description: 'Claim one immediately available task for an existing worker token', inputSchema: CHAT_SWARM_CLAIM_SCHEMA },
    { name: 'chat_swarm_ack', description: 'Acknowledge that a claimed worker task actually resumed execution', inputSchema: CHAT_SWARM_ACK_SCHEMA },
    { name: 'chat_swarm_next', description: 'Park for one bounded worker checkpoint and claim work when it arrives', inputSchema: CHAT_SWARM_NEXT_SCHEMA },
    { name: 'chat_swarm_recover', description: 'Recover an interrupted worker wait with one bounded checkpoint', inputSchema: CHAT_SWARM_RECOVER_SCHEMA },
    { name: 'chat_swarm_submit_once', description: 'Submit one browser/dock-woken worker result without re-parking', inputSchema: CHAT_SWARM_SUBMIT_ONCE_SCHEMA },
    { name: 'chat_swarm_submit', description: 'Submit a worker result and immediately re-park for the next bounded checkpoint', inputSchema: CHAT_SWARM_SUBMIT_SCHEMA },
    { name: 'chat_swarm_collect', description: 'Collect selected Chat Swarm task results with optional bounded waiting', inputSchema: CHAT_SWARM_COLLECT_SCHEMA },
    { name: 'chat_swarm_cancel', description: 'Cancel queued or claimed Chat Swarm tasks', inputSchema: CHAT_SWARM_CANCEL_SCHEMA },
    { name: 'chat_swarm_recycle_worker', description: 'Recycle a dead worker and safely requeue unacknowledged work', inputSchema: CHAT_SWARM_RECYCLE_WORKER_SCHEMA },
    { name: 'chat_swarm_leave', description: 'Leave a Chat Swarm worker slot and requeue safe in-flight work', inputSchema: CHAT_SWARM_LEAVE_SCHEMA },
    { name: 'chat_swarm_close', description: 'Close a Chat Swarm and optionally cancel pending work', inputSchema: CHAT_SWARM_CLOSE_SCHEMA },
    { name: 'chat_swarm_wake_bridge', description: 'Report Cloudflare Browser Wake Bridge and Worker Dock stream endpoint status', inputSchema: CHAT_SWARM_WAKE_BRIDGE_SCHEMA },
    { name: 'chat_swarm_runtime_status', description: 'Query connected outbound Windows agent/runtime status', inputSchema: CHAT_SWARM_RUNTIME_STATUS_SCHEMA },

    { name: 'swarm_dispatch', description: 'Dispatch simplified vNext swarm task', inputSchema: SWARM_DISPATCH_SCHEMA },
    { name: 'swarm_status', description: 'Check simplified vNext swarm status', inputSchema: SWARM_STATUS_SCHEMA },
    { name: 'device_status', description: 'Inspect local agent status', inputSchema: DEVICE_STATUS_SCHEMA },
    { name: 'kill_switch_trigger', description: 'Administrative emergency-stop and revocation control', inputSchema: KILL_SWITCH_TRIGGER_SCHEMA }
  ];
}

