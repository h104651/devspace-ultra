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
                const rootHasGit = fs.existsSync(path.join(project.canonicalRoot, '.git'));
                let gitDetected = rootHasGit;
                let gitInfo;
                let discoveredRepositoriesCount = 0;
                if (project.permissions.read && fs.existsSync(project.canonicalRoot)) {
                    if (rootHasGit) {
                        try {
                            gitInfo = await this.runGitStatus(project.canonicalRoot);
                        }
                        catch (e) {
                            onLog(`[EXECUTOR] Git status warning: ${e.message}`);
                        }
                    }
                    else {
                        try {
                            const discovered = await this.discoverRepositories(project.canonicalRoot, '.', 4);
                            discoveredRepositoriesCount = discovered.length;
                            if (discovered.length > 0) {
                                gitDetected = true;
                                if (discovered.length === 1) {
                                    gitInfo = {
                                        branch: discovered[0].branch,
                                        headCommit: discovered[0].headCommit,
                                        isClean: discovered[0].isClean
                                    };
                                }
                            }
                        }
                        catch (e) {
                            onLog(`[EXECUTOR] Repository discovery warning: ${e.message}`);
                        }
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
                    discoveredRepositoriesCount: discoveredRepositoriesCount > 0 ? discoveredRepositoriesCount : undefined,
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
                const requestedRepoRel = task.payload.repoRelativePath;
                let targetDir;
                let effectiveRepoRel;
                if (requestedRepoRel && requestedRepoRel !== '.') {
                    targetDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, requestedRepoRel);
                    effectiveRepoRel = path.relative(project.canonicalRoot, targetDir).replace(/\\/g, '/') || '.';
                    if (!fs.existsSync(path.join(targetDir, '.git'))) {
                        return {
                            projectId: project.projectId,
                            repoRelativePath: effectiveRepoRel,
                            gitDetected: false,
                            message: `Directory '${effectiveRepoRel}' is not a Git repository`
                        };
                    }
                }
                else {
                    if (fs.existsSync(path.join(project.canonicalRoot, '.git'))) {
                        targetDir = project.canonicalRoot;
                        effectiveRepoRel = '.';
                    }
                    else {
                        const discovered = await this.discoverRepositories(project.canonicalRoot, '.', 6);
                        if (discovered.length === 0) {
                            return {
                                projectId: project.projectId,
                                gitDetected: false,
                                message: 'No Git repository detected in workspace'
                            };
                        }
                        if (discovered.length === 1) {
                            effectiveRepoRel = discovered[0].repoRelativePath;
                            targetDir = path.resolve(project.canonicalRoot, effectiveRepoRel);
                        }
                        else {
                            return {
                                projectId: project.projectId,
                                gitDetected: true,
                                ambiguous: true,
                                message: `Multiple Git repositories found in workspace '${project.projectId}'. Specify 'repoRelativePath' to choose one.`,
                                candidateRepositories: discovered.map(r => r.repoRelativePath),
                                repositories: discovered
                            };
                        }
                    }
                }
                const gitResult = await this.runGitStatus(targetDir);
                return {
                    projectId: project.projectId,
                    repoRelativePath: effectiveRepoRel,
                    gitDetected: true,
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
            case 'local:list_directory': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const requestedRel = task.payload.relativePath || '.';
                const targetDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, requestedRel);
                const effectiveRel = path.relative(project.canonicalRoot, targetDir).replace(/\\/g, '/') || '.';
                const maxEntries = Math.min(Math.max(1, task.payload.maxEntries || 100), 1000);
                const rawEntries = fs.readdirSync(targetDir, { withFileTypes: true });
                const entries = [];
                for (const dirent of rawEntries) {
                    const entryPath = path.join(targetDir, dirent.name);
                    const entryRel = path.relative(project.canonicalRoot, entryPath).replace(/\\/g, '/');
                    let type = 'other';
                    if (dirent.isFile())
                        type = 'file';
                    else if (dirent.isDirectory())
                        type = 'directory';
                    else if (dirent.isSymbolicLink())
                        type = 'symlink';
                    let sizeBytes;
                    let modifiedTime;
                    if (dirent.isSymbolicLink()) {
                        try {
                            const real = fs.realpathSync(entryPath);
                            if (project_registry_1.ProjectPathSecurity.isPathInsideRoot(real, project.canonicalRoot)) {
                                const stat = fs.statSync(real);
                                sizeBytes = stat.size;
                                modifiedTime = stat.mtime.toISOString();
                            }
                        }
                        catch { }
                    }
                    else {
                        try {
                            const stat = fs.statSync(entryPath);
                            sizeBytes = stat.size;
                            modifiedTime = stat.mtime.toISOString();
                        }
                        catch { }
                    }
                    entries.push({
                        name: dirent.name,
                        type,
                        relativePath: entryRel,
                        sizeBytes,
                        modifiedTime
                    });
                }
                entries.sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory')
                        return -1;
                    if (a.type !== 'directory' && b.type === 'directory')
                        return 1;
                    return a.name.localeCompare(b.name);
                });
                const totalEntries = entries.length;
                const page = entries.slice(0, maxEntries);
                return {
                    projectId: project.projectId,
                    relativePath: effectiveRel,
                    totalEntries,
                    returnedEntries: page.length,
                    hasMore: totalEntries > maxEntries,
                    entries: page
                };
            }
            case 'local:find_files': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const requestedRel = task.payload.relativePath || '.';
                const startDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, requestedRel);
                const effectiveRel = path.relative(project.canonicalRoot, startDir).replace(/\\/g, '/') || '.';
                const maxResults = Math.min(Math.max(1, task.payload.maxResults || 100), 500);
                const maxDepth = task.payload.maxDepth !== undefined ? Math.max(0, task.payload.maxDepth) : 15;
                const pattern = task.payload.pattern || task.payload.name;
                const recursive = task.payload.recursive !== false;
                const typeFilter = task.payload.type || 'all';
                const results = [];
                const visitedRealPaths = new Set();
                await this.collectFiles(project.canonicalRoot, startDir, 0, maxDepth, pattern, recursive, typeFilter, maxResults, visitedRealPaths, results);
                return {
                    projectId: project.projectId,
                    baseRelativePath: effectiveRel,
                    count: results.length,
                    truncated: results.length >= maxResults,
                    files: results
                };
            }
            case 'local:search_text': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const query = task.payload.query;
                if (!query || typeof query !== 'string') {
                    const err = new Error('INVALID_ARGUMENT: query string is required for local:search_text');
                    err.code = 'INVALID_ARGUMENT';
                    throw err;
                }
                const requestedRel = task.payload.relativePath || '.';
                const startDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, requestedRel);
                const effectiveRel = path.relative(project.canonicalRoot, startDir).replace(/\\/g, '/') || '.';
                const maxResults = Math.min(Math.max(1, task.payload.maxResults || 100), 500);
                const maxDepth = task.payload.maxDepth !== undefined ? Math.max(0, task.payload.maxDepth) : 15;
                const pattern = task.payload.pattern;
                const caseSensitive = !!task.payload.caseSensitive;
                const recursive = task.payload.recursive !== false;
                const matches = [];
                const visitedRealPaths = new Set();
                await this.collectTextMatches(project.canonicalRoot, startDir, 0, maxDepth, query, pattern, caseSensitive, recursive, maxResults, visitedRealPaths, matches);
                return {
                    projectId: project.projectId,
                    baseRelativePath: effectiveRel,
                    query,
                    count: matches.length,
                    truncated: matches.length >= maxResults,
                    matches
                };
            }
            case 'local:find_repositories': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.read) {
                    const err = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
                    throw err;
                }
                const requestedRel = task.payload.relativePath || '.';
                const startDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, requestedRel);
                const effectiveRel = path.relative(project.canonicalRoot, startDir).replace(/\\/g, '/') || '.';
                const maxDepth = task.payload.maxDepth !== undefined ? Math.max(0, task.payload.maxDepth) : 10;
                const repositories = await this.discoverRepositories(project.canonicalRoot, requestedRel, maxDepth);
                return {
                    projectId: project.projectId,
                    baseRelativePath: effectiveRel,
                    count: repositories.length,
                    repositories
                };
            }
            case 'local:create_directory': {
                const { project } = this.resolveProjectForTask(task.payload);
                if (!project.permissions.write) {
                    const err = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
                    err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
                    throw err;
                }
                const rawRel = task.payload.relativePath;
                if (!rawRel || typeof rawRel !== 'string') {
                    const err = new Error('INVALID_ARGUMENT: relativePath is required for local:create_directory');
                    err.code = 'INVALID_ARGUMENT';
                    throw err;
                }
                const safeRel = project_registry_1.ProjectPathSecurity.validateRelativePath(rawRel);
                const targetPath = path.resolve(project.canonicalRoot, safeRel);
                if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(targetPath, project.canonicalRoot)) {
                    const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path '${rawRel}' escapes project root`);
                    err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                    throw err;
                }
                let parent = path.dirname(targetPath);
                while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
                    parent = path.dirname(parent);
                }
                if (fs.existsSync(parent)) {
                    const realParent = fs.realpathSync(parent);
                    if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(realParent, project.canonicalRoot)) {
                        const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Parent directory resolves outside project root`);
                        err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                        throw err;
                    }
                }
                fs.mkdirSync(targetPath, { recursive: true });
                const realTarget = fs.realpathSync(targetPath);
                if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(realTarget, project.canonicalRoot)) {
                    const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Created directory resolves via symlink outside project root`);
                    err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                    throw err;
                }
                return {
                    projectId: project.projectId,
                    relativePath: safeRel,
                    status: 'created'
                };
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
                const workingRel = task.payload.workingRelativePath;
                const targetCwd = (workingRel && workingRel !== '.')
                    ? project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, workingRel)
                    : project.canonicalRoot;
                const runnerId = task.payload.runnerId || task.payload.runner || 'npm';
                const cmdConfig = this.resolveTestCommand(project, runnerId);
                onLog(`[EXECUTOR] Running tests in project '${project.projectId}' (cwd: '${path.relative(project.canonicalRoot, targetCwd) || '.'}') via runner '${runnerId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
                return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, targetCwd, cmdConfig.env, onLog);
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
                const workingRel = task.payload.workingRelativePath;
                const targetCwd = (workingRel && workingRel !== '.')
                    ? project_registry_1.ProjectPathSecurity.resolveDirectoryPath(project.canonicalRoot, workingRel)
                    : project.canonicalRoot;
                const commandId = task.payload.commandId || 'npm';
                const cmdConfig = this.resolveBuildCommand(project, commandId);
                onLog(`[EXECUTOR] Building project '${project.projectId}' (cwd: '${path.relative(project.canonicalRoot, targetCwd) || '.'}') via command '${commandId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
                return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, targetCwd, cmdConfig.env, onLog);
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
            const headPath = path.join(repoPath, '.git', 'HEAD');
            let fallbackBranch = null;
            if (fs.existsSync(headPath)) {
                try {
                    const headContent = fs.readFileSync(headPath, 'utf-8').trim();
                    if (headContent.startsWith('ref: refs/heads/')) {
                        fallbackBranch = headContent.replace('ref: refs/heads/', '');
                    }
                    else if (headContent) {
                        fallbackBranch = headContent;
                    }
                }
                catch { }
            }
            let child;
            try {
                child = (0, child_process_1.spawn)(gitExe, ['status', '--porcelain'], { cwd: repoPath, shell: false });
            }
            catch (err) {
                if (fallbackBranch) {
                    return resolve({
                        branch: fallbackBranch,
                        headCommit: null,
                        isClean: null,
                        changes: [],
                        gitStatusAvailable: false
                    });
                }
                return reject(new Error(`Failed to execute git: ${err.message}`));
            }
            let statusOut = '';
            child.stdout?.on('data', (d) => { statusOut += d.toString(); });
            child.on('close', (code) => {
                if (code !== 0) {
                    if (fallbackBranch) {
                        return resolve({
                            branch: fallbackBranch,
                            headCommit: null,
                            isClean: null,
                            changes: [],
                            gitStatusAvailable: false
                        });
                    }
                    return reject(new Error(`git status failed with exit code ${code}`));
                }
                const isClean = statusOut.trim().length === 0;
                const branchChild = (0, child_process_1.spawn)(gitExe, ['branch', '--show-current'], { cwd: repoPath, shell: false });
                let branchOut = '';
                branchChild.stdout?.on('data', (d) => { branchOut += d.toString(); });
                branchChild.on('close', () => {
                    let branch = (branchOut || '').trim() || fallbackBranch || 'HEAD';
                    const commitChild = (0, child_process_1.spawn)(gitExe, ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false });
                    let commitOut = '';
                    commitChild.stdout?.on('data', (d) => { commitOut += d.toString(); });
                    commitChild.on('close', (commitCode) => {
                        const headCommit = commitCode === 0 ? (commitOut || '').trim() || null : null;
                        resolve({
                            branch,
                            headCommit,
                            isClean,
                            changes: statusOut.trim().split('\n').filter(Boolean),
                            gitStatusAvailable: true
                        });
                    });
                    commitChild.on('error', () => {
                        resolve({
                            branch,
                            headCommit: null,
                            isClean,
                            changes: statusOut.trim().split('\n').filter(Boolean),
                            gitStatusAvailable: true
                        });
                    });
                });
                branchChild.on('error', () => {
                    resolve({
                        branch: fallbackBranch || 'HEAD',
                        headCommit: null,
                        isClean,
                        changes: statusOut.trim().split('\n').filter(Boolean),
                        gitStatusAvailable: true
                    });
                });
            });
            child.on('error', () => {
                if (fallbackBranch) {
                    return resolve({
                        branch: fallbackBranch,
                        headCommit: null,
                        isClean: null,
                        changes: [],
                        gitStatusAvailable: false
                    });
                }
                reject(new Error('git execution failed'));
            });
        });
    }
    runGitInfo(repoPath) {
        return new Promise((resolve) => {
            const isWindows = process.platform === 'win32';
            const gitExe = isWindows ? 'git.exe' : 'git';
            const headPath = path.join(repoPath, '.git', 'HEAD');
            let fallbackBranch = null;
            if (fs.existsSync(headPath)) {
                try {
                    const headContent = fs.readFileSync(headPath, 'utf-8').trim();
                    if (headContent.startsWith('ref: refs/heads/')) {
                        fallbackBranch = headContent.replace('ref: refs/heads/', '');
                    }
                    else if (headContent) {
                        fallbackBranch = headContent;
                    }
                }
                catch { }
            }
            try {
                const branchChild = (0, child_process_1.spawn)(gitExe, ['branch', '--show-current'], { cwd: repoPath, shell: false });
                let branchOut = '';
                branchChild.stdout?.on('data', (d) => { branchOut += d.toString(); });
                branchChild.on('close', () => {
                    const commitChild = (0, child_process_1.spawn)(gitExe, ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false });
                    let commitOut = '';
                    commitChild.stdout?.on('data', (d) => { commitOut += d.toString(); });
                    commitChild.on('close', (commitCode) => {
                        const remoteChild = (0, child_process_1.spawn)(gitExe, ['config', '--get', 'remote.origin.url'], { cwd: repoPath, shell: false });
                        let remoteOut = '';
                        remoteChild.stdout?.on('data', (d) => { remoteOut += d.toString(); });
                        remoteChild.on('close', (remoteCode) => {
                            const statusChild = (0, child_process_1.spawn)(gitExe, ['status', '--porcelain'], { cwd: repoPath, shell: false });
                            let statusOut = '';
                            statusChild.stdout?.on('data', (d) => { statusOut += d.toString(); });
                            statusChild.on('close', (statusCode) => {
                                const branch = (branchOut || '').trim() || fallbackBranch || (statusCode === 0 ? 'HEAD' : null);
                                const isClean = statusCode === 0 ? (statusOut.trim().length === 0) : null;
                                resolve({
                                    branch,
                                    headCommit: commitCode === 0 ? (commitOut || '').trim() || null : null,
                                    remoteUrl: remoteCode === 0 ? (remoteOut || '').trim() || null : null,
                                    isClean
                                });
                            });
                            statusChild.on('error', () => resolve({
                                branch: (branchOut || '').trim() || fallbackBranch || null,
                                headCommit: commitCode === 0 ? (commitOut || '').trim() || null : null,
                                remoteUrl: remoteCode === 0 ? (remoteOut || '').trim() || null : null,
                                isClean: null
                            }));
                        });
                        remoteChild.on('error', () => resolve({
                            branch: (branchOut || '').trim() || fallbackBranch || null,
                            headCommit: commitCode === 0 ? (commitOut || '').trim() || null : null,
                            remoteUrl: null,
                            isClean: null
                        }));
                    });
                    commitChild.on('error', () => resolve({
                        branch: (branchOut || '').trim() || fallbackBranch || null,
                        headCommit: null,
                        remoteUrl: null,
                        isClean: null
                    }));
                });
                branchChild.on('error', () => resolve({
                    branch: fallbackBranch,
                    headCommit: null,
                    remoteUrl: null,
                    isClean: null
                }));
            }
            catch {
                resolve({ branch: fallbackBranch, headCommit: null, remoteUrl: null, isClean: null });
            }
        });
    }
    async discoverRepositories(canonicalRoot, subRelPath = '.', maxDepth = 10) {
        const startDir = project_registry_1.ProjectPathSecurity.resolveDirectoryPath(canonicalRoot, subRelPath);
        const discovered = [];
        const visitedRealPaths = new Set();
        const queue = [{ dir: startDir, depth: 0 }];
        while (queue.length > 0) {
            const { dir, depth } = queue.shift();
            if (depth > maxDepth)
                continue;
            let realDir;
            try {
                realDir = fs.realpathSync(dir);
                if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(realDir, canonicalRoot))
                    continue;
            }
            catch {
                continue;
            }
            const normKey = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
            if (visitedRealPaths.has(normKey))
                continue;
            visitedRealPaths.add(normKey);
            const hasGit = fs.existsSync(path.join(dir, '.git'));
            if (hasGit) {
                const repoRel = path.relative(canonicalRoot, dir).replace(/\\/g, '/') || '.';
                const gitInfo = await this.runGitInfo(dir);
                const indicators = [];
                const types = [];
                if (fs.existsSync(path.join(dir, 'pubspec.yaml'))) {
                    indicators.push('pubspec.yaml');
                    types.push('flutter', 'dart');
                }
                if (fs.existsSync(path.join(dir, 'package.json'))) {
                    indicators.push('package.json');
                    types.push('node', 'javascript/typescript');
                }
                if (fs.existsSync(path.join(dir, 'pyproject.toml'))) {
                    indicators.push('pyproject.toml');
                    if (!types.includes('python'))
                        types.push('python');
                }
                if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
                    indicators.push('requirements.txt');
                    if (!types.includes('python'))
                        types.push('python');
                }
                if (fs.existsSync(path.join(dir, 'setup.py'))) {
                    indicators.push('setup.py');
                    if (!types.includes('python'))
                        types.push('python');
                }
                if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
                    indicators.push('Cargo.toml');
                    types.push('rust');
                }
                if (fs.existsSync(path.join(dir, 'go.mod'))) {
                    indicators.push('go.mod');
                    types.push('go');
                }
                if (fs.existsSync(path.join(dir, 'pom.xml')) || fs.existsSync(path.join(dir, 'build.gradle')) || fs.existsSync(path.join(dir, 'build.gradle.kts'))) {
                    if (fs.existsSync(path.join(dir, 'pom.xml')))
                        indicators.push('pom.xml');
                    if (fs.existsSync(path.join(dir, 'build.gradle')))
                        indicators.push('build.gradle');
                    if (fs.existsSync(path.join(dir, 'build.gradle.kts')))
                        indicators.push('build.gradle.kts');
                    types.push('jvm');
                }
                discovered.push({
                    repoRelativePath: repoRel,
                    branch: gitInfo.branch,
                    headCommit: gitInfo.headCommit,
                    remoteUrl: gitInfo.remoteUrl,
                    isClean: gitInfo.isClean,
                    projectIndicators: indicators,
                    projectTypes: Array.from(new Set(types))
                });
            }
            let dirents = [];
            try {
                dirents = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch { }
            for (const d of dirents) {
                if (d.name === '.git' || d.name === 'node_modules' || d.name === '.dart_tool' || d.name === 'build' || d.name === 'dist') {
                    continue;
                }
                let isDir = d.isDirectory();
                const subDir = path.join(dir, d.name);
                if (d.isSymbolicLink()) {
                    try {
                        const real = fs.realpathSync(subDir);
                        if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(real, canonicalRoot))
                            continue;
                        const stat = fs.statSync(real);
                        isDir = stat.isDirectory();
                    }
                    catch {
                        continue;
                    }
                }
                if (!isDir)
                    continue;
                try {
                    const realSub = fs.realpathSync(subDir);
                    if (project_registry_1.ProjectPathSecurity.isPathInsideRoot(realSub, canonicalRoot)) {
                        const subNorm = process.platform === 'win32' ? realSub.toLowerCase() : realSub;
                        if (!visitedRealPaths.has(subNorm)) {
                            queue.push({ dir: subDir, depth: depth + 1 });
                        }
                    }
                }
                catch { }
            }
        }
        return discovered;
    }
    async collectFiles(canonicalRoot, currentDir, currentDepth, maxDepth, pattern, recursive, typeFilter, maxResults, visitedRealPaths, results) {
        if (results.length >= maxResults)
            return;
        if (currentDepth > maxDepth)
            return;
        let realCurrentDir;
        try {
            realCurrentDir = fs.realpathSync(currentDir);
        }
        catch {
            return;
        }
        if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(realCurrentDir, canonicalRoot)) {
            return;
        }
        const normKey = process.platform === 'win32' ? realCurrentDir.toLowerCase() : realCurrentDir;
        if (visitedRealPaths.has(normKey)) {
            return;
        }
        visitedRealPaths.add(normKey);
        let dirents;
        try {
            dirents = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const dirent of dirents) {
            if (results.length >= maxResults)
                break;
            if (dirent.name === '.git' && dirent.isDirectory())
                continue;
            const fullPath = path.join(currentDir, dirent.name);
            let isDirectory = dirent.isDirectory();
            let isFile = dirent.isFile();
            if (dirent.isSymbolicLink()) {
                try {
                    const real = fs.realpathSync(fullPath);
                    if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(real, canonicalRoot))
                        continue;
                    const stat = fs.statSync(real);
                    isDirectory = stat.isDirectory();
                    isFile = stat.isFile();
                }
                catch {
                    continue;
                }
            }
            const relPath = path.relative(canonicalRoot, fullPath).replace(/\\/g, '/');
            const matchesPattern = matchPattern(dirent.name, pattern) || (pattern && pattern.includes('/') ? matchPattern(relPath, pattern) : false);
            const matchesType = typeFilter === 'all' ||
                (typeFilter === 'file' && isFile) ||
                (typeFilter === 'directory' && isDirectory);
            if (matchesPattern && matchesType) {
                let sizeBytes;
                let modifiedTime;
                try {
                    const stat = fs.statSync(fullPath);
                    sizeBytes = stat.size;
                    modifiedTime = stat.mtime.toISOString();
                }
                catch { }
                results.push({
                    relativePath: relPath,
                    name: dirent.name,
                    isDirectory,
                    sizeBytes: isFile ? sizeBytes : undefined,
                    modifiedTime
                });
            }
            if (isDirectory && recursive && currentDepth < maxDepth) {
                await this.collectFiles(canonicalRoot, fullPath, currentDepth + 1, maxDepth, pattern, recursive, typeFilter, maxResults, visitedRealPaths, results);
            }
        }
    }
    async collectTextMatches(canonicalRoot, currentDir, currentDepth, maxDepth, query, pattern, caseSensitive, recursive, maxResults, visitedRealPaths, matches) {
        if (matches.length >= maxResults)
            return;
        if (currentDepth > maxDepth)
            return;
        let realCurrentDir;
        try {
            realCurrentDir = fs.realpathSync(currentDir);
        }
        catch {
            return;
        }
        if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(realCurrentDir, canonicalRoot)) {
            return;
        }
        const normKey = process.platform === 'win32' ? realCurrentDir.toLowerCase() : realCurrentDir;
        if (visitedRealPaths.has(normKey)) {
            return;
        }
        visitedRealPaths.add(normKey);
        let dirents;
        try {
            dirents = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const BINARY_EXTS = new Set([
            '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite',
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip',
            '.tar', '.gz', '.7z', '.rar', '.mp3', '.mp4', '.wav', '.mov',
            '.pyc', '.pyo', '.class', '.o', '.a', '.obj', '.apk', '.aab', '.ipa'
        ]);
        for (const dirent of dirents) {
            if (matches.length >= maxResults)
                break;
            if (dirent.name === '.git' && dirent.isDirectory())
                continue;
            const fullPath = path.join(currentDir, dirent.name);
            let isDirectory = dirent.isDirectory();
            let isFile = dirent.isFile();
            if (dirent.isSymbolicLink()) {
                try {
                    const real = fs.realpathSync(fullPath);
                    if (!project_registry_1.ProjectPathSecurity.isPathInsideRoot(real, canonicalRoot))
                        continue;
                    const stat = fs.statSync(real);
                    isDirectory = stat.isDirectory();
                    isFile = stat.isFile();
                }
                catch {
                    continue;
                }
            }
            const relPath = path.relative(canonicalRoot, fullPath).replace(/\\/g, '/');
            if (isFile) {
                const ext = path.extname(dirent.name).toLowerCase();
                if (BINARY_EXTS.has(ext))
                    continue;
                if (pattern && !matchPattern(dirent.name, pattern) && !matchPattern(relPath, pattern)) {
                    continue;
                }
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 5 * 1024 * 1024)
                        continue;
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    if (content.includes('\0'))
                        continue;
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (matches.length >= maxResults)
                            break;
                        const line = lines[i];
                        const lineMatches = caseSensitive
                            ? line.includes(query)
                            : line.toLowerCase().includes(query.toLowerCase());
                        if (lineMatches) {
                            matches.push({
                                relativePath: relPath,
                                lineNumber: i + 1,
                                lineContent: line.trim()
                            });
                        }
                    }
                }
                catch { }
            }
            else if (isDirectory && recursive && currentDepth < maxDepth) {
                await this.collectTextMatches(canonicalRoot, fullPath, currentDepth + 1, maxDepth, query, pattern, caseSensitive, recursive, maxResults, visitedRealPaths, matches);
            }
        }
    }
}
exports.TaskExecutor = TaskExecutor;
function matchPattern(name, pattern) {
    if (!pattern || pattern === '*' || pattern === '')
        return true;
    if (pattern.includes('*') || pattern.includes('?')) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${escaped}$`, 'i').test(name);
    }
    return name.toLowerCase().includes(pattern.toLowerCase());
}
