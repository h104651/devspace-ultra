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
exports.ProjectRegistry = exports.ProjectPathSecurity = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class ProjectPathSecurity {
    /**
     * Normalizes projectId (lowercase, trimmed).
     */
    static normalizeProjectId(projectId) {
        if (!projectId || typeof projectId !== 'string') {
            const err = new Error('INVALID_PROJECT_ID: Project ID must be a non-empty string');
            err.code = 'INVALID_PROJECT_ID';
            throw err;
        }
        const normalized = projectId.trim().toLowerCase();
        if (!/^[a-z0-9-_.]+$/.test(normalized)) {
            const err = new Error(`INVALID_PROJECT_ID: Project ID '${projectId}' contains invalid characters. Use letters, numbers, hyphens, dots, or underscores.`);
            err.code = 'INVALID_PROJECT_ID';
            throw err;
        }
        return normalized;
    }
    /**
     * Platform-aware canonical root resolution.
     */
    static getCanonicalRoot(rawRoot) {
        const resolved = path.resolve(rawRoot);
        if (fs.existsSync(resolved)) {
            try {
                return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
            }
            catch {
                return resolved;
            }
        }
        return resolved;
    }
    /**
     * Validates that relativePath is strictly relative and does not contain drive letters, UNC paths, or dotdot escapes.
     */
    static validateRelativePath(relativePath) {
        if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
            const err = new Error('LOCAL_PROJECT_PATH_ESCAPE: relativePath must be a non-empty string');
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        // Check for backslashes or slashes mixed traversal
        const slashUnified = relativePath.replace(/\\/g, '/');
        // Reject absolute paths, drive letters (e.g. C:, D:), UNC (\\ or //), or leading slash
        if (path.isAbsolute(relativePath) ||
            /^[a-zA-Z]:/.test(relativePath) ||
            /^(\\|\/){2}/.test(relativePath) ||
            relativePath.startsWith('/') ||
            relativePath.startsWith('\\') ||
            slashUnified.startsWith('/')) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Absolute, drive-qualified, or UNC path is forbidden: '${relativePath}'`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        // Reject traversal segments in unified slashes
        const segments = slashUnified.split('/');
        let depth = 0;
        for (const seg of segments) {
            if (seg === '..') {
                depth--;
                if (depth < 0) {
                    const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path traversal escaping project root is forbidden: '${relativePath}'`);
                    err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                    throw err;
                }
            }
            else if (seg !== '' && seg !== '.') {
                depth++;
            }
        }
        // Normalize path separators for local platform
        const normalized = path.normalize(process.platform === 'win32' ? relativePath : slashUnified);
        // Reject traversal escaping root
        if (normalized === '..' ||
            normalized.startsWith('..' + path.sep) ||
            normalized.startsWith('../') ||
            normalized.startsWith('..\\')) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path traversal escaping project root is forbidden: '${relativePath}'`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        return normalized;
    }
    /**
     * Checks if targetPath is inside canonicalRoot using platform-appropriate comparison.
     */
    static isPathInsideRoot(targetPath, canonicalRoot) {
        const isWindows = process.platform === 'win32';
        const normTarget = isWindows ? path.normalize(targetPath).toLowerCase() : path.normalize(targetPath);
        const normRoot = isWindows ? path.normalize(canonicalRoot).toLowerCase() : path.normalize(canonicalRoot);
        if (normTarget === normRoot)
            return true;
        if (normTarget.startsWith(normRoot + path.sep) || normTarget.startsWith(normRoot + '/'))
            return true;
        return false;
    }
    /**
     * Safely resolves a relative path within a project root for reading, checking realpath/symlinks/junctions.
     */
    static resolveReadPath(canonicalRoot, relativePath) {
        const safeRel = this.validateRelativePath(relativePath);
        const resolved = path.resolve(canonicalRoot, safeRel);
        if (!this.isPathInsideRoot(resolved, canonicalRoot)) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path '${relativePath}' escapes project root`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        if (!fs.existsSync(resolved)) {
            const err = new Error(`FILE_NOT_FOUND: Path '${relativePath}' does not exist in project`);
            err.code = 'FILE_NOT_FOUND';
            throw err;
        }
        let realTarget;
        try {
            realTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
        }
        catch (e) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for '${relativePath}': ${e.message}`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        if (!this.isPathInsideRoot(realTarget, canonicalRoot)) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Target '${relativePath}' resolves via symlink/junction outside project root to '${realTarget}'`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        return realTarget;
    }
    /**
     * Safely resolves a relative path within a project root for writing, checking nearest existing parent realpath.
     */
    static resolveWritePath(canonicalRoot, relativePath) {
        const safeRel = this.validateRelativePath(relativePath);
        const resolved = path.resolve(canonicalRoot, safeRel);
        if (!this.isPathInsideRoot(resolved, canonicalRoot)) {
            const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path '${relativePath}' escapes project root`);
            err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
            throw err;
        }
        // If file already exists, check its realpath directly
        if (fs.existsSync(resolved)) {
            let realTarget;
            try {
                realTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
            }
            catch (e) {
                const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for '${relativePath}': ${e.message}`);
                err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                throw err;
            }
            if (!this.isPathInsideRoot(realTarget, canonicalRoot)) {
                const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Target file '${relativePath}' resolves via symlink/junction outside project root`);
                err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                throw err;
            }
            return realTarget;
        }
        // If file does not exist, find nearest existing parent directory and check its realpath
        let parent = path.dirname(resolved);
        while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
            parent = path.dirname(parent);
        }
        if (fs.existsSync(parent)) {
            let realParent;
            try {
                realParent = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
            }
            catch (e) {
                const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for parent '${parent}': ${e.message}`);
                err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                throw err;
            }
            if (!this.isPathInsideRoot(realParent, canonicalRoot)) {
                const err = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Parent directory resolves via symlink/junction outside project root`);
                err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
                throw err;
            }
        }
        return resolved;
    }
}
exports.ProjectPathSecurity = ProjectPathSecurity;
class ProjectRegistry {
    projects = new Map();
    configFilePath;
    constructor(options) {
        if (options?.configFilePath) {
            this.configFilePath = path.resolve(options.configFilePath);
            this.loadFromFileAtomic();
        }
        if (options?.initialProjects) {
            for (const item of options.initialProjects) {
                this.registerProject(item);
            }
        }
        if (options?.initialLegacyWorkspaces) {
            for (const rawWorkspace of options.initialLegacyWorkspaces) {
                const normRoot = path.resolve(rawWorkspace);
                const baseName = ProjectPathSecurity.normalizeProjectId(path.basename(normRoot) || 'default-workspace');
                // Detect collision on same basename from different roots
                if (this.projects.has(baseName)) {
                    const existing = this.projects.get(baseName);
                    const canonical = ProjectPathSecurity.getCanonicalRoot(normRoot);
                    if (!ProjectPathSecurity.isPathInsideRoot(canonical, existing.canonicalRoot) || !ProjectPathSecurity.isPathInsideRoot(existing.canonicalRoot, canonical)) {
                        const err = new Error(`LOCAL_PROJECT_ID_CONFLICT: Multiple legacy workspace roots share the same basename '${baseName}'. Use explicit named project configuration with unique projectIds.`);
                        err.code = 'LOCAL_PROJECT_ID_CONFLICT';
                        throw err;
                    }
                }
                else {
                    // Legacy migration path grants full permissions for backwards compatibility
                    this.registerLegacyWorkspace(baseName, normRoot);
                }
            }
        }
    }
    /**
     * Registers a named project definition with fail-safe defaults (least privilege).
     * Omitted sensitive permissions (write, test, build, hostExecution) default to false.
     */
    registerProject(def) {
        const normalizedId = ProjectPathSecurity.normalizeProjectId(def.projectId);
        const resolvedRoot = path.resolve(def.root);
        const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(resolvedRoot);
        if (this.projects.has(normalizedId)) {
            const existing = this.projects.get(normalizedId);
            if (existing.canonicalRoot !== canonicalRoot) {
                const err = new Error(`LOCAL_PROJECT_ID_CONFLICT: Project ID '${normalizedId}' is already registered with a different root`);
                err.code = 'LOCAL_PROJECT_ID_CONFLICT';
                throw err;
            }
        }
        // Fail-safe defaults: read defaults to true; write, test, build, hostExecution default to false
        const permissions = {
            read: def.permissions?.read !== false,
            write: def.permissions?.write === true,
            test: def.permissions?.test === true,
            build: def.permissions?.build === true,
            hostExecution: def.permissions?.hostExecution === true
        };
        this.projects.set(normalizedId, {
            projectId: normalizedId,
            displayName: def.displayName || def.projectId,
            root: resolvedRoot,
            canonicalRoot,
            enabled: def.enabled !== false,
            permissions,
            commands: def.commands
        });
    }
    /**
     * Explicit legacy workspace registration (preserves historical full permissions for legacy strings).
     */
    registerLegacyWorkspace(projectId, root) {
        const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
        const resolvedRoot = path.resolve(root);
        const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(resolvedRoot);
        this.projects.set(normalizedId, {
            projectId: normalizedId,
            displayName: projectId,
            root: resolvedRoot,
            canonicalRoot,
            enabled: true,
            permissions: { read: true, write: true, test: true, build: true, hostExecution: true }
        });
    }
    unregisterProject(projectId) {
        const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
        return this.projects.delete(normalizedId);
    }
    getProject(projectId) {
        const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
        const proj = this.projects.get(normalizedId);
        if (!proj) {
            const err = new Error(`LOCAL_PROJECT_NOT_FOUND: Project '${projectId}' is not registered in the local Project Registry`);
            err.code = 'LOCAL_PROJECT_NOT_FOUND';
            throw err;
        }
        if (!proj.enabled) {
            const err = new Error(`LOCAL_PROJECT_DISABLED: Project '${projectId}' is currently disabled`);
            err.code = 'LOCAL_PROJECT_DISABLED';
            throw err;
        }
        return proj;
    }
    hasProject(projectId) {
        const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
        return this.projects.has(normalizedId);
    }
    listProjects() {
        const list = [];
        for (const p of this.projects.values()) {
            const gitDetected = fs.existsSync(path.join(p.canonicalRoot, '.git'));
            const availableCapabilities = ['local:project_status'];
            if (p.permissions.read) {
                availableCapabilities.push('local:read_file');
                if (gitDetected)
                    availableCapabilities.push('local:git_status');
            }
            if (p.permissions.write) {
                availableCapabilities.push('local:write_file', 'local:patch_file');
            }
            if (p.permissions.test && p.permissions.hostExecution) {
                availableCapabilities.push('local:run_tests');
            }
            if (p.permissions.build && p.permissions.hostExecution) {
                availableCapabilities.push('local:build_project');
            }
            list.push({
                projectId: p.projectId,
                displayName: p.displayName,
                enabled: p.enabled,
                permissions: { ...p.permissions },
                hostExecutionEnabled: p.permissions.hostExecution,
                securityModel: {
                    fileOperations: 'PROJECT_ROOT_CONFINED',
                    processExecution: 'HOST_EXECUTION_NOT_OS_SANDBOXED'
                },
                gitDetected,
                availableCapabilities,
                configuredTestRunners: p.commands?.test ? Object.keys(p.commands.test) : undefined,
                configuredBuildCommands: p.commands?.build ? Object.keys(p.commands.build) : undefined
            });
        }
        return list;
    }
    /**
     * Deprecated legacy resolution helper: matches an absolute path against registered project roots.
     */
    resolveLegacyPath(targetPath) {
        const resolved = path.resolve(targetPath);
        for (const p of this.projects.values()) {
            if (!p.enabled)
                continue;
            if (ProjectPathSecurity.isPathInsideRoot(resolved, p.canonicalRoot)) {
                const rel = path.relative(p.canonicalRoot, resolved);
                return { project: p, relativePath: rel };
            }
        }
        return undefined;
    }
    /**
     * Atomic, fail-closed configuration loader.
     * If configuration file is missing or invalid, throws LOCAL_PROJECT_CONFIG_INVALID
     * and leaves live registry untouched (zero partial registration).
     */
    loadFromFileAtomic() {
        if (!this.configFilePath)
            return;
        if (!fs.existsSync(this.configFilePath)) {
            const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project configuration file does not exist: ${this.configFilePath}`);
            err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
            throw err;
        }
        let parsed;
        try {
            const raw = fs.readFileSync(this.configFilePath, 'utf-8');
            parsed = JSON.parse(raw);
        }
        catch (e) {
            const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Failed to parse JSON configuration file '${this.configFilePath}': ${e.message}`);
            err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
            throw err;
        }
        const items = Array.isArray(parsed) ? parsed : (parsed?.projects || []);
        if (!Array.isArray(items)) {
            const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: projects configuration must be an array or { projects: [...] }`);
            err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
            throw err;
        }
        // Temporary staging structure to validate all entries before committing
        const staging = [];
        const seenIds = new Set();
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item || typeof item !== 'object') {
                const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project at index ${i} is not a valid object`);
                err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                throw err;
            }
            if (!item.projectId || typeof item.projectId !== 'string') {
                const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project at index ${i} is missing required 'projectId'`);
                err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                throw err;
            }
            const normalizedId = ProjectPathSecurity.normalizeProjectId(item.projectId);
            if (seenIds.has(normalizedId)) {
                const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Duplicate projectId '${normalizedId}' in configuration file`);
                err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                throw err;
            }
            seenIds.add(normalizedId);
            if (!item.root || typeof item.root !== 'string') {
                const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project '${item.projectId}' is missing required 'root' path`);
                err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                throw err;
            }
            const resolvedRoot = path.resolve(item.root);
            const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(resolvedRoot);
            // Validate commands if present
            if (item.commands) {
                if (typeof item.commands !== 'object') {
                    const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project '${item.projectId}' commands must be an object`);
                    err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                    throw err;
                }
                for (const [type, group] of Object.entries(item.commands)) {
                    if (group && typeof group === 'object') {
                        for (const [cmdId, cmdDef] of Object.entries(group)) {
                            const def = cmdDef;
                            if (!def || typeof def.executable !== 'string' || !Array.isArray(def.args)) {
                                const err = new Error(`LOCAL_PROJECT_CONFIG_INVALID: Project '${item.projectId}' command '${type}.${cmdId}' must have string executable and string[] args`);
                                err.code = 'LOCAL_PROJECT_CONFIG_INVALID';
                                throw err;
                            }
                        }
                    }
                }
            }
            const permissions = {
                read: item.permissions?.read !== false,
                write: item.permissions?.write === true,
                test: item.permissions?.test === true,
                build: item.permissions?.build === true,
                hostExecution: item.permissions?.hostExecution === true
            };
            staging.push({
                projectId: normalizedId,
                displayName: item.displayName || item.projectId,
                root: resolvedRoot,
                canonicalRoot,
                enabled: item.enabled !== false,
                permissions,
                commands: item.commands
            });
        }
        // All validated -> atomic commit into live registry
        for (const project of staging) {
            this.projects.set(project.projectId, project);
        }
    }
    saveToFile() {
        if (!this.configFilePath)
            return;
        const items = Array.from(this.projects.values()).map(p => ({
            projectId: p.projectId,
            displayName: p.displayName,
            root: p.root,
            enabled: p.enabled,
            permissions: p.permissions,
            commands: p.commands
        }));
        fs.writeFileSync(this.configFilePath, JSON.stringify({ projects: items }, null, 2), 'utf-8');
    }
}
exports.ProjectRegistry = ProjectRegistry;
