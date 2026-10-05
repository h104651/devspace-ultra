import * as path from 'path';

export class PathSanitizer {
  /**
   * Validates and resolves a relative path against an allowed root directory.
   * Throws if path traversal (e.g. ../) tries to escape root.
   */
  static resolveSafePath(rootDir: string, relativePath: string): string {
    if (!rootDir) {
      throw new Error('PATH_ERROR: Root directory must be provided');
    }

    if (!relativePath || relativePath.includes('\0')) {
      throw new Error('PATH_ERROR: Invalid relative path');
    }

    const normalizedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(normalizedRoot, relativePath);

    if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
      throw new Error(`PATH_TRAVERSAL_DENIED: Attempted access outside root directory`);
    }

    return resolvedPath;
  }

  /**
   * Sanitizes artifact filenames to prevent malicious characters and directory escapes.
   */
  static sanitizeArtifactFilename(name: string): string {
    if (!name) return 'unnamed_artifact';
    const base = path.basename(name);
    return base.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  }
}
