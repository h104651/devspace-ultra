import * as fs from 'fs';
import * as path from 'path';

export interface LocalProjectPermissions {
  read: boolean;
  write: boolean;
  test: boolean;
  build: boolean;
}

export interface LocalProjectDefinition {
  projectId: string;
  displayName?: string;
  root: string;
  enabled?: boolean;
  permissions?: Partial<LocalProjectPermissions>;
}

export interface LocalProjectMetadata {
  projectId: string;
  displayName: string;
  enabled: boolean;
  permissions: LocalProjectPermissions;
  gitDetected: boolean;
  availableCapabilities: string[];
}

export class ProjectPathSecurity {
  /**
   * Normalizes projectId (lowercase, trimmed).
   */
  static normalizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      const err: any = new Error('INVALID_PROJECT_ID: Project ID must be a non-empty string');
      err.code = 'INVALID_PROJECT_ID';
      throw err;
    }
    const normalized = projectId.trim().toLowerCase();
    if (!/^[a-z0-9-_.]+$/.test(normalized)) {
      const err: any = new Error(`INVALID_PROJECT_ID: Project ID '${projectId}' contains invalid characters. Use letters, numbers, hyphens, dots, or underscores.`);
      err.code = 'INVALID_PROJECT_ID';
      throw err;
    }
    return normalized;
  }

  /**
   * Platform-aware canonical root resolution.
   */
  static getCanonicalRoot(rawRoot: string): string {
    const resolved = path.resolve(rawRoot);
    if (fs.existsSync(resolved)) {
      try {
        return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    }
    return resolved;
  }

  /**
   * Validates that relativePath is strictly relative and does not contain drive letters, UNC paths, or dotdot escapes.
   */
  static validateRelativePath(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
      const err: any = new Error('LOCAL_PROJECT_PATH_ESCAPE: relativePath must be a non-empty string');
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    // Check for backslashes or slashes mixed traversal
    const slashUnified = relativePath.replace(/\\/g, '/');

    // Reject absolute paths, drive letters (e.g. C:, D:), UNC (\\ or //), or leading slash
    if (
      path.isAbsolute(relativePath) ||
      /^[a-zA-Z]:/.test(relativePath) ||
      /^(\\|\/){2}/.test(relativePath) ||
      relativePath.startsWith('/') ||
      relativePath.startsWith('\\') ||
      slashUnified.startsWith('/')
    ) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Absolute, drive-qualified, or UNC path is forbidden: '${relativePath}'`);
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
          const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path traversal escaping project root is forbidden: '${relativePath}'`);
          err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
          throw err;
        }
      } else if (seg !== '' && seg !== '.') {
        depth++;
      }
    }

    // Normalize path separators for local platform
    const normalized = path.normalize(process.platform === 'win32' ? relativePath : slashUnified);

    // Reject traversal escaping root
    if (
      normalized === '..' ||
      normalized.startsWith('..' + path.sep) ||
      normalized.startsWith('../') ||
      normalized.startsWith('..\\')
    ) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path traversal escaping project root is forbidden: '${relativePath}'`);
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    return normalized;
  }

  /**
   * Checks if targetPath is inside canonicalRoot using platform-appropriate comparison.
   */
  static isPathInsideRoot(targetPath: string, canonicalRoot: string): boolean {
    const isWindows = process.platform === 'win32';
    const normTarget = isWindows ? path.normalize(targetPath).toLowerCase() : path.normalize(targetPath);
    const normRoot = isWindows ? path.normalize(canonicalRoot).toLowerCase() : path.normalize(canonicalRoot);

    if (normTarget === normRoot) return true;
    if (normTarget.startsWith(normRoot + path.sep) || normTarget.startsWith(normRoot + '/')) return true;
    return false;
  }

  /**
   * Safely resolves a relative path within a project root for reading, checking realpath/symlinks/junctions.
   */
  static resolveReadPath(canonicalRoot: string, relativePath: string): string {
    const safeRel = this.validateRelativePath(relativePath);
    const resolved = path.resolve(canonicalRoot, safeRel);

    if (!this.isPathInsideRoot(resolved, canonicalRoot)) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path '${relativePath}' escapes project root`);
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    if (!fs.existsSync(resolved)) {
      const err: any = new Error(`FILE_NOT_FOUND: Path '${relativePath}' does not exist in project`);
      err.code = 'FILE_NOT_FOUND';
      throw err;
    }

    let realTarget: string;
    try {
      realTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } catch (e: any) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for '${relativePath}': ${e.message}`);
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    if (!this.isPathInsideRoot(realTarget, canonicalRoot)) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Target '${relativePath}' resolves via symlink/junction outside project root to '${realTarget}'`);
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    return realTarget;
  }

  /**
   * Safely resolves a relative path within a project root for writing, checking nearest existing parent realpath.
   */
  static resolveWritePath(canonicalRoot: string, relativePath: string): string {
    const safeRel = this.validateRelativePath(relativePath);
    const resolved = path.resolve(canonicalRoot, safeRel);

    if (!this.isPathInsideRoot(resolved, canonicalRoot)) {
      const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Path '${relativePath}' escapes project root`);
      err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
      throw err;
    }

    // If file already exists, check its realpath directly
    if (fs.existsSync(resolved)) {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      } catch (e: any) {
        const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for '${relativePath}': ${e.message}`);
        err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
        throw err;
      }
      if (!this.isPathInsideRoot(realTarget, canonicalRoot)) {
        const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Target file '${relativePath}' resolves via symlink/junction outside project root`);
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
      let realParent: string;
      try {
        realParent = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
      } catch (e: any) {
        const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Failed to resolve realpath for parent '${parent}': ${e.message}`);
        err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
        throw err;
      }
      if (!this.isPathInsideRoot(realParent, canonicalRoot)) {
        const err: any = new Error(`LOCAL_PROJECT_PATH_ESCAPE: Parent directory resolves via symlink/junction outside project root`);
        err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
        throw err;
      }
    }

    return resolved;
  }
}

export class ProjectRegistry {
  private projects: Map<string, {
    projectId: string;
    displayName: string;
    root: string;
    canonicalRoot: string;
    enabled: boolean;
    permissions: LocalProjectPermissions;
  }> = new Map();

  private configFilePath?: string;

  constructor(options?: { configFilePath?: string; initialProjects?: (LocalProjectDefinition | string)[] }) {
    if (options?.configFilePath) {
      this.configFilePath = path.resolve(options.configFilePath);
      this.loadFromFile();
    }
    if (options?.initialProjects) {
      for (const item of options.initialProjects) {
        if (typeof item === 'string') {
          const normRoot = path.resolve(item);
          const baseName = path.basename(normRoot) || 'default-project';
          this.registerProject({
            projectId: baseName,
            displayName: baseName,
            root: normRoot,
            enabled: true,
            permissions: { read: true, write: true, test: true, build: true }
          });
        } else {
          this.registerProject(item);
        }
      }
    }
  }

  public registerProject(def: LocalProjectDefinition): void {
    const normalizedId = ProjectPathSecurity.normalizeProjectId(def.projectId);
    const resolvedRoot = path.resolve(def.root);
    const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(resolvedRoot);

    const permissions: LocalProjectPermissions = {
      read: def.permissions?.read !== false,
      write: def.permissions?.write !== false,
      test: def.permissions?.test !== false,
      build: def.permissions?.build !== false
    };

    this.projects.set(normalizedId, {
      projectId: normalizedId,
      displayName: def.displayName || def.projectId,
      root: resolvedRoot,
      canonicalRoot,
      enabled: def.enabled !== false,
      permissions
    });
  }

  public unregisterProject(projectId: string): boolean {
    const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
    return this.projects.delete(normalizedId);
  }

  public getProject(projectId: string): {
    projectId: string;
    displayName: string;
    root: string;
    canonicalRoot: string;
    enabled: boolean;
    permissions: LocalProjectPermissions;
  } {
    const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
    const proj = this.projects.get(normalizedId);
    if (!proj) {
      const err: any = new Error(`LOCAL_PROJECT_NOT_FOUND: Project '${projectId}' is not registered in the local Project Registry`);
      err.code = 'LOCAL_PROJECT_NOT_FOUND';
      throw err;
    }
    if (!proj.enabled) {
      const err: any = new Error(`LOCAL_PROJECT_DISABLED: Project '${projectId}' is currently disabled`);
      err.code = 'LOCAL_PROJECT_DISABLED';
      throw err;
    }
    return proj;
  }

  public hasProject(projectId: string): boolean {
    const normalizedId = ProjectPathSecurity.normalizeProjectId(projectId);
    return this.projects.has(normalizedId);
  }

  public listProjects(): LocalProjectMetadata[] {
    const list: LocalProjectMetadata[] = [];
    for (const p of this.projects.values()) {
      const gitDetected = fs.existsSync(path.join(p.canonicalRoot, '.git'));
      const availableCapabilities = ['local:project_status'];
      if (p.permissions.read) {
        availableCapabilities.push('local:read_file');
        if (gitDetected) availableCapabilities.push('local:git_status');
      }
      if (p.permissions.write) {
        availableCapabilities.push('local:write_file', 'local:patch_file');
      }
      if (p.permissions.test) {
        availableCapabilities.push('local:run_tests');
      }
      if (p.permissions.build) {
        availableCapabilities.push('local:build_project');
      }
      list.push({
        projectId: p.projectId,
        displayName: p.displayName,
        enabled: p.enabled,
        permissions: { ...p.permissions },
        gitDetected,
        availableCapabilities
      });
    }
    return list;
  }

  /**
   * Legacy resolution helper: matches an absolute path against registered project roots.
   */
  public resolveLegacyPath(targetPath: string): { project: any; relativePath: string } | undefined {
    const resolved = path.resolve(targetPath);
    for (const p of this.projects.values()) {
      if (!p.enabled) continue;
      if (ProjectPathSecurity.isPathInsideRoot(resolved, p.canonicalRoot)) {
        const rel = path.relative(p.canonicalRoot, resolved);
        return { project: p, relativePath: rel };
      }
    }
    return undefined;
  }

  private loadFromFile(): void {
    if (!this.configFilePath || !fs.existsSync(this.configFilePath)) return;
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8');
      const data = JSON.parse(raw);
      const items: LocalProjectDefinition[] = Array.isArray(data) ? data : data.projects || [];
      for (const item of items) {
        this.registerProject(item);
      }
    } catch (e: any) {
      console.error(`Failed to load projects from ${this.configFilePath}:`, e.message);
    }
  }

  public saveToFile(): void {
    if (!this.configFilePath) return;
    const items = Array.from(this.projects.values()).map(p => ({
      projectId: p.projectId,
      displayName: p.displayName,
      root: p.root,
      enabled: p.enabled,
      permissions: p.permissions
    }));
    fs.writeFileSync(this.configFilePath, JSON.stringify({ projects: items }, null, 2), 'utf-8');
  }
}
