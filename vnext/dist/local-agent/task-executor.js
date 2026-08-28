"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskExecutor = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const project_registry_1 = require("./project-registry");
class TaskExecutor {
    projectRegistry;
    allowRawShell;
    constructor(config) {
        this.allowRawShell = !!config.allowRawShell;
        if (config.projectRegistry) {
            this.projectRegistry = config.projectRegistry;
        }
        else {
            this.projectRegistry = new project_registry_1.ProjectRegistry({
                configFilePath: config.projectsConfigFile,
                initialProjects: config.projects || config.allowedWorkspaces
            });
        }
    }
    getRegistry() {
        return this.projectRegistry;
    }
    resolveProjectForTask(payload) {
        if (payload.projectId) {
            const project = this.projectRegistry.getProject(payload.projectId);
            return { project, relativePath: payload.relativePath, isLegacy: false };
        }
        // Deprecated legacy compatibility fallback: resolve absolute workspace or filePath
        const legacyPath = payload.workspace || payload.filePath;
        if (!legacyPath) {
            const err = new Error('MISSING_PROJECT_ID: Target projectId is required for local task routing');
            err.code = 'MISSING_PROJECT_ID';
            throw err;
        }
        const match = this.projectRegistry.resolveLegacyPath(legacyPath);
        if (!match) {
            const err = new Error(`WORKSPACE_ACCESS_DENIED: Path '${legacyPath}' is outside authorized registered project workspaces`);
            err.code = 'WORKSPACE_ACCESS_DENIED';
            throw err;
        }
        return { project: match.project, relativePath: match.relativePath, isLegacy: true };
    }
    async executeTask(task, onLog) {
        onLog(`[EXECUTOR] Starting capability: ${task.capability}`);
        switch (task.capability) {
            case 'local:list_projects': {
                const projects = this.projectRegistry.listProjects();
                return {
                    count: projects.length,
                    projects
                };
            }
            case 'local:project_status': {
                const { project } = this.resolveProjectForTask(task.payload);
                const gitDetected = fs.existsSync(path.join(project.canonicalRoot, '.git'));
                let gitInfo;
                if (gitDetected && project.permissions.read) {
                    try {
                        gitInfo = await this.runGitStatus(project.canonicalRoot);
                    }
                    catch (e) {
                        onLog(`[EXECUTOR] Git status warning: ${e.message}`);
                    }
                }
                return {
                    projectId: project.projectId,
                    displayName: project.displayName,
                    exists: fs.existsSync(project.canonicalRoot),
                    gitDetected,
                    branch: gitInfo?.branch,
                    headCommit: gitInfo?.headCommit,
                    isClean: gitInfo?.isClean,
                    permissions: { ...project.permissions }
                };
            }
            case 'local:git_status': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const gitResult = await this.runGitStatus(project.canonicalRoot);
                return {
                    projectId: project.projectId,
                    ...gitResult
                };
            }
            case 'local:read_file': {
                const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
                const targetPath = project_registry_1.ProjectPathSecurity.resolveReadPath(project.canonicalRoot, effectiveRelPath);
                const content = fs.readFileSync(targetPath, 'utf-8');
                return {
                    projectId: project.projectId,
                    relativePath: effectiveRelPath,
                    sizeBytes: Buffer.byteLength(content),
                    content: task.payload.limit ? content.substring(0, task.payload.limit) : content
                };
            }
            case 'local:write_file':
            case 'local:patch_file': {
                const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.write) {
                    const err = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
                    throw err;
                }
                const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
                const targetPath = project_registry_1.ProjectPathSecurity.resolveWritePath(project.canonicalRoot, effectiveRelPath);
                const dir = path.dirname(targetPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                const content = typeof task.payload.content === 'string' ? task.payload.content : '';
                fs.writeFileSync(targetPath, content, 'utf-8');
                onLog(`[EXECUTOR] Successfully wrote ${Buffer.byteLength(content)} bytes to ${effectiveRelPath}`);
                return {
                    projectId: project.projectId,
                    relativePath: effectiveRelPath,
                    status: 'written',
                    sizeBytes: Buffer.byteLength(content)
                };
            }
            case 'local:run_tests': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.test) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Test execution is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const runner = task.payload.runner || 'npm';
                let cmd = 'npm test';
                if (runner === 'pytest')
                    cmd = 'pytest';
                if (runner === 'flutter')
                    cmd = 'flutter test';
                if (task.payload.customCommand) {
                    cmd = task.payload.customCommand;
                }
                onLog(`[EXECUTOR] Running tests in project '${project.projectId}' via command: ${cmd}`);
                return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
            }
            case 'local:build_project': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.build) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Build execution is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const cmd = task.payload.command || 'npm run build';
                onLog(`[EXECUTOR] Building project '${project.projectId}' via: ${cmd}`);
                return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
            }
            case 'local:raw_shell': {
                if (!this.allowRawShell) {
                    const err = new Error('RAW_SHELL_DENIED: Raw shell execution is disabled on this agent');
                    err.code = 'RAW_SHELL_DENIED';
                    throw err;
                }
                const { project } = this.resolveProjectForTask(task.payload);
                const cmd = task.payload.command;
                if (!cmd) {
                    const err = new Error('MISSING_COMMAND: No command provided for raw shell');
                    err.code = 'MISSING_COMMAND';
                    throw err;
                }
                onLog(`[AUDIT_SHELL] Executing raw command in '${project.projectId}': ${cmd}`);
                return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
            }
            default:
                throw new Error(`UNSUPPORTED_CAPABILITY: Agent cannot execute '${task.capability}'`);
        }
    }
    runGitStatus(repoPath) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)('git status --porcelain', { cwd: repoPath }, (err, stdout) => {
                if (err)
                    return reject(err);
                (0, child_process_1.exec)('git branch --show-current', { cwd: repoPath }, (errBranch, branchOut) => {
                    const branch = (branchOut || 'HEAD').trim();
                    (0, child_process_1.exec)('git rev-parse HEAD', { cwd: repoPath }, (_errCommit, commitOut) => {
                        const headCommit = (commitOut || '').trim();
                        const isClean = stdout.trim().length === 0;
                        resolve({
                            branch: branch || 'main',
                            headCommit,
                            isClean,
                            changes: stdout.trim().split('\n').filter(Boolean)
                        });
                    });
                });
            });
        });
    }
    runCommandAsync(command, cwd, onLog) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.exec)(command, { cwd, maxBuffer: 10 * 1024 * 1024 });
            let stdoutAcc = '';
            child.stdout?.on('data', (data) => {
                const text = data.toString();
                stdoutAcc += text;
                onLog(text.trim());
            });
            child.stderr?.on('data', (data) => {
                const text = data.toString();
                stdoutAcc += text;
                onLog(`[STDERR] ${text.trim()}`);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout: stdoutAcc, exitCode: 0 });
                }
                else {
                    reject(new Error(`Command failed with exit code ${code}: ${stdoutAcc.slice(-500)}`));
                }
            });
            child.on('error', (err) => {
                reject(err);
            });
        });
    }
}
exports.TaskExecutor = TaskExecutor;
