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
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const project_registry_1 = require("./project-registry");
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
class TaskExecutor {
    projectRegistry;
    allowRawShell;
    fileLocks = new Map();
    constructor(config) {
        this.allowRawShell = !!config.allowRawShell;
        if (config.projectRegistry) {
            this.projectRegistry = config.projectRegistry;
        }
        else {
            this.projectRegistry = new project_registry_1.ProjectRegistry({
                configFilePath: config.projectsConfigFile,
                initialProjects: config.projects,
                initialLegacyWorkspaces: config.allowedWorkspaces
            });
        }
    }
    getRegistry() {
        return this.projectRegistry;
    }
    async acquireFileLock(key) {
        while (this.fileLocks.has(key)) {
            await this.fileLocks.get(key);
        }
        let release;
        const lockPromise = new Promise((res) => {
            release = res;
        });
        this.fileLocks.set(key, lockPromise);
        return () => {
            if (this.fileLocks.get(key) === lockPromise) {
                this.fileLocks.delete(key);
            }
            release();
        };
    }
    resolveProjectForTask(payload) {
        if (payload?.projectId) {
            const project = this.projectRegistry.getProject(payload.projectId);
            return { project, relativePath: payload.relativePath, isLegacy: false };
        }
        // Deprecated legacy compatibility fallback: resolve absolute workspace or filePath
        const legacyPath = payload?.workspace || payload?.filePath;
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
                    permissions: { ...project.permissions },
                    hostExecutionEnabled: project.permissions.hostExecution,
                    securityModel: {
                        fileOperations: 'PROJECT_ROOT_CONFINED',
                        processExecution: 'HOST_EXECUTION_NOT_OS_SANDBOXED'
                    },
                    configuredTestRunners: project.commands?.test ? Object.keys(project.commands.test) : undefined,
                    configuredBuildCommands: project.commands?.build ? Object.keys(project.commands.build) : undefined
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
            case 'local:write_file': {
                const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.write) {
                    const err = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
                    throw err;
                }
                const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
                const lockKey = `${project.projectId}:${path.normalize(effectiveRelPath || '').toLowerCase()}`;
                const unlock = await this.acquireFileLock(lockKey);
                try {
                    const targetPath = project_registry_1.ProjectPathSecurity.resolveWritePath(project.canonicalRoot, effectiveRelPath);
                    const dir = path.dirname(targetPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    const content = typeof task.payload.content === 'string' ? task.payload.content : '';
                    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
                    fs.writeFileSync(tmpPath, content, 'utf-8');
                    fs.renameSync(tmpPath, targetPath);
                    onLog(`[EXECUTOR] Successfully wrote ${Buffer.byteLength(content)} bytes to ${effectiveRelPath}`);
                    return {
                        projectId: project.projectId,
                        relativePath: effectiveRelPath,
                        status: 'written',
                        sizeBytes: Buffer.byteLength(content)
                    };
                }
                finally {
                    unlock();
                }
            }
            case 'local:patch_file': {
                const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.write) {
                    const err = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
                    throw err;
                }
                const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
                if (!effectiveRelPath) {
                    const err = new Error('LOCAL_PROJECT_PATH_ESCAPE: relativePath is required for patch_file');
                    err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                    throw err;
                }
                const expectedSha256 = task.payload.expectedSha256;
                if (!expectedSha256 || typeof expectedSha256 !== 'string') {
                    const err = new Error('LOCAL_PATCH_INVALID: expectedSha256 is required for deterministic patch execution');
                    err.code = 'LOCAL_PATCH_INVALID';
                    throw err;
                }
                const rawPatches = Array.isArray(task.payload.patches)
                    ? task.payload.patches
                    : (task.payload.patch ? [task.payload.patch] : []);
                if (rawPatches.length === 0) {
                    const err = new Error('LOCAL_PATCH_INVALID: patches array must contain at least one patch block');
                    err.code = 'LOCAL_PATCH_INVALID';
                    throw err;
                }
                // Per-file mutation lock critical section
                const lockKey = `${project.projectId}:${path.normalize(effectiveRelPath).toLowerCase()}`;
                const unlock = await this.acquireFileLock(lockKey);
                try {
                    // 1. Resolve read path and verify realpath/symlink boundaries
                    const targetPath = project_registry_1.ProjectPathSecurity.resolveReadPath(project.canonicalRoot, effectiveRelPath);
                    const currentContent = fs.readFileSync(targetPath, 'utf-8');
                    // 2. Compute current SHA256 and verify expectedSha256
                    const currentSha256 = crypto.createHash('sha256').update(currentContent, 'utf-8').digest('hex');
                    if (currentSha256.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
                        const err = new Error(`LOCAL_FILE_CONFLICT: Expected SHA256 '${expectedSha256}' does not match current file SHA256 '${currentSha256}'`);
                        err.code = 'LOCAL_FILE_CONFLICT';
                        throw err;
                    }
                    // 3. Apply patches in memory
                    let patchedContent = currentContent;
                    for (let i = 0; i < rawPatches.length; i++) {
                        const patch = rawPatches[i];
                        if (typeof patch.oldText !== 'string' || typeof patch.newText !== 'string') {
                            const err = new Error(`LOCAL_PATCH_INVALID: Patch at index ${i} must have string oldText and newText`);
                            err.code = 'LOCAL_PATCH_INVALID';
                            throw err;
                        }
                        const expectedOccurrences = patch.expectedOccurrences !== undefined ? patch.expectedOccurrences : 1;
                        const matchCount = (patchedContent.match(new RegExp(escapeRegExp(patch.oldText), 'g')) || []).length;
                        if (matchCount !== expectedOccurrences) {
                            const err = new Error(`LOCAL_PATCH_FAILED: Patch at index ${i} expected ${expectedOccurrences} occurrence(s) of target text, but found ${matchCount}`);
                            err.code = 'LOCAL_PATCH_FAILED';
                            throw err;
                        }
                        patchedContent = patchedContent.replaceAll(patch.oldText, patch.newText);
                    }
                    // 4. Verify write path and nearest parent boundaries
                    const writeTargetPath = project_registry_1.ProjectPathSecurity.resolveWritePath(project.canonicalRoot, effectiveRelPath);
                    // 5. Pre-commit check: confirm target on disk still matches currentSha256
                    const preCommitContent = fs.readFileSync(writeTargetPath, 'utf-8');
                    const preCommitSha = crypto.createHash('sha256').update(preCommitContent, 'utf-8').digest('hex');
                    if (preCommitSha.toLowerCase() !== currentSha256.toLowerCase()) {
                        const err = new Error(`LOCAL_FILE_CONFLICT: Target file was modified concurrently prior to commit`);
                        err.code = 'LOCAL_FILE_CONFLICT';
                        throw err;
                    }
                    // 6. Atomic disk replacement
                    const dir = path.dirname(writeTargetPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    const tmpPath = `${writeTargetPath}.patch-tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
                    fs.writeFileSync(tmpPath, patchedContent, 'utf-8');
                    fs.renameSync(tmpPath, writeTargetPath);
                    // 7. Read back and compute new SHA256
                    const newReadback = fs.readFileSync(writeTargetPath, 'utf-8');
                    const newSha256 = crypto.createHash('sha256').update(newReadback, 'utf-8').digest('hex');
                    onLog(`[EXECUTOR] Successfully patched ${effectiveRelPath} (previous: ${currentSha256.substring(0, 8)}, new: ${newSha256.substring(0, 8)})`);
                    return {
                        projectId: project.projectId,
                        relativePath: effectiveRelPath,
                        status: 'patched',
                        previousSha256: currentSha256,
                        newSha256,
                        sizeBytes: Buffer.byteLength(newReadback)
                    };
                }
                finally {
                    unlock();
                }
            }
            case 'local:run_tests': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.test || !project.permissions.hostExecution) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Host process execution for tests is forbidden on project '${project.projectId}'. Set permissions.test = true and permissions.hostExecution = true to allow.`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                // Reject arbitrary shell command execution in normal test capability
                if (task.payload.customCommand || task.payload.command) {
                    const err = new Error('LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN: Arbitrary shell command execution is forbidden on local:run_tests. Use configured runnerId or local:raw_shell with raw_shell:run scope.');
                    err.code = 'LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN';
                    throw err;
                }
                const runnerId = task.payload.runnerId || task.payload.runner || 'npm';
                const cmdConfig = this.resolveTestCommand(project, runnerId);
                onLog(`[EXECUTOR] Running tests in project '${project.projectId}' via runner '${runnerId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
                return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, project.canonicalRoot, cmdConfig.env, onLog);
            }
            case 'local:build_project': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.build || !project.permissions.hostExecution) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Host process execution for build is forbidden on project '${project.projectId}'. Set permissions.build = true and permissions.hostExecution = true to allow.`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                // Reject arbitrary shell command execution in normal build capability
                if (task.payload.command || task.payload.customCommand) {
                    const err = new Error('LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN: Arbitrary shell command execution is forbidden on local:build_project. Use configured commandId or local:raw_shell with raw_shell:run scope.');
                    err.code = 'LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN';
                    throw err;
                }
                const commandId = task.payload.commandId || 'npm';
                const cmdConfig = this.resolveBuildCommand(project, commandId);
                onLog(`[EXECUTOR] Building project '${project.projectId}' via command '${commandId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
                return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, project.canonicalRoot, cmdConfig.env, onLog);
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
                return this.executeRawShell(cmd, project.canonicalRoot, onLog);
            }
            default:
                throw new Error(`UNSUPPORTED_CAPABILITY: Agent cannot execute '${task.capability}'`);
        }
    }
    resolveTestCommand(project, runnerId) {
        // 1. Check custom configured project commands
        if (project.commands?.test?.[runnerId]) {
            return project.commands.test[runnerId];
        }
        // 2. Standard built-in runners
        const isWindows = process.platform === 'win32';
        switch (runnerId.toLowerCase()) {
            case 'npm':
            case 'npm_test':
                return {
                    executable: isWindows ? 'npm.cmd' : 'npm',
                    args: ['test']
                };
            case 'pytest':
                return {
                    executable: isWindows ? 'pytest.exe' : 'pytest',
                    args: []
                };
            case 'flutter':
            case 'flutter_test':
                return {
                    executable: isWindows ? 'flutter.bat' : 'flutter',
                    args: ['test']
                };
            default: {
                const err = new Error(`LOCAL_RUNNER_NOT_FOUND: Unknown test runnerId '${runnerId}' for project '${project.projectId}'. Configure it in project.commands.test or use standard runners (npm, pytest, flutter).`);
                err.code = 'LOCAL_RUNNER_NOT_FOUND';
                throw err;
            }
        }
    }
    resolveBuildCommand(project, commandId) {
        // 1. Check custom configured project commands
        if (project.commands?.build?.[commandId]) {
            return project.commands.build[commandId];
        }
        // 2. Standard built-in build commands
        const isWindows = process.platform === 'win32';
        switch (commandId.toLowerCase()) {
            case 'npm':
            case 'npm_build':
                return {
                    executable: isWindows ? 'npm.cmd' : 'npm',
                    args: ['run', 'build']
                };
            case 'flutter':
            case 'flutter_apk':
                return {
                    executable: isWindows ? 'flutter.bat' : 'flutter',
                    args: ['build', 'apk']
                };
            default: {
                const err = new Error(`LOCAL_COMMAND_NOT_FOUND: Unknown build commandId '${commandId}' for project '${project.projectId}'. Configure it in project.commands.build or use standard commands (npm, flutter).`);
                err.code = 'LOCAL_COMMAND_NOT_FOUND';
                throw err;
            }
        }
    }
    executeProcessWithoutShell(executable, args, cwd, extraEnv, onLog) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(executable, args, {
                cwd,
                env: { ...process.env, ...extraEnv },
                shell: false,
                windowsHide: true
            });
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
                    const err = new Error(`Process failed with exit code ${code}: ${stdoutAcc.slice(-500)}`);
                    err.code = 'LOCAL_PROCESS_FAILED';
                    err.exitCode = code;
                    reject(err);
                }
            });
            child.on('error', (err) => {
                reject(err);
            });
        });
    }
    executeRawShell(command, cwd, onLog) {
        return new Promise((resolve, reject) => {
            const shellExecutable = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
            const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
            const child = (0, child_process_1.spawn)(shellExecutable, shellArgs, {
                cwd,
                env: process.env,
                shell: false,
                windowsHide: true
            });
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
                    const err = new Error(`Raw shell command failed with exit code ${code}: ${stdoutAcc.slice(-500)}`);
                    err.code = 'RAW_SHELL_FAILED';
                    err.exitCode = code;
                    reject(err);
                }
            });
            child.on('error', (err) => {
                reject(err);
            });
        });
    }
    runGitStatus(repoPath) {
        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const gitExe = isWindows ? 'git.exe' : 'git';
            const child = (0, child_process_1.spawn)(gitExe, ['status', '--porcelain'], { cwd: repoPath, shell: false });
            let statusOut = '';
            child.stdout?.on('data', d => { statusOut += d.toString(); });
            child.on('close', code => {
                if (code !== 0)
                    return reject(new Error(`git status failed with exit code ${code}`));
                const branchChild = (0, child_process_1.spawn)(gitExe, ['branch', '--show-current'], { cwd: repoPath, shell: false });
                let branchOut = '';
                branchChild.stdout?.on('data', d => { branchOut += d.toString(); });
                branchChild.on('close', () => {
                    const branch = (branchOut || 'HEAD').trim();
                    const commitChild = (0, child_process_1.spawn)(gitExe, ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false });
                    let commitOut = '';
                    commitChild.stdout?.on('data', d => { commitOut += d.toString(); });
                    commitChild.on('close', () => {
                        const headCommit = (commitOut || '').trim();
                        const isClean = statusOut.trim().length === 0;
                        resolve({
                            branch: branch || 'main',
                            headCommit,
                            isClean,
                            changes: statusOut.trim().split('\n').filter(Boolean)
                        });
                    });
                });
            });
            child.on('error', err => reject(err));
        });
    }
}
exports.TaskExecutor = TaskExecutor;
