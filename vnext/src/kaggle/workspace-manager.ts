/**
 * DevSpace Ultra vNext — Kaggle Workspace Manager
 * 
 * Manages Large Project Workspace Mode backed by Kaggle Datasets and thin runner kernels.
 */

import * as crypto from 'crypto';

export interface WorkspaceFileMetadata {
  size: number;
  sha256: string;
  category?: string;
  description?: string;
}

export interface DevSpaceProjectManifest {
  name: string;
  slug: string;
  owner?: string;
  version: number;
  type: 'workspace';
  entrypoint: string;
  runnerKernelRef: string;
  archiveMaster?: {
    filename: string;
    size: number;
    sha256: string;
    cellCount: number;
  };
  files: Record<string, WorkspaceFileMetadata>;
  updatedAt?: string;
  metadata?: Record<string, any>;
}

export interface DevSpaceExecutionResult {
  project: string;
  datasetVersion: number;
  workspaceFingerprint: string;
  entrypoint: string;
  workspaceValidation: 'PASS' | 'FAIL';
  experimentExecution: 'PASS' | 'FAIL';
  error?: string;
  timestamp?: number;
}

/**
 * Computes canonical workspace fingerprint from project manifest file mappings.
 */
export function computeWorkspaceFingerprint(manifest: DevSpaceProjectManifest): string {
  const sortedKeys = Object.keys(manifest.files || {}).sort();
  const canonicalEntries = sortedKeys.map(k => ({
    path: k,
    size: manifest.files[k].size,
    sha256: manifest.files[k].sha256
  }));

  const payload = {
    name: manifest.name,
    slug: manifest.slug,
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    runnerKernelRef: manifest.runnerKernelRef,
    files: canonicalEntries
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Validates project manifest schema integrity.
 */
export function validateProjectManifest(manifest: any): DevSpaceProjectManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest is not a valid object');
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required string field "name"');
  }
  if (!manifest.slug || typeof manifest.slug !== 'string') {
    throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required string field "slug"');
  }
  if (typeof manifest.version !== 'number') {
    throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required number field "version"');
  }
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required object field "files"');
  }
  return manifest as DevSpaceProjectManifest;
}

/**
 * Validates and normalizes relative POSIX workspace path.
 * Rejects absolute paths, .., path traversal, empty paths, backslashes, and control characters.
 */
export function validateWorkspaceRelativePath(relPath: string): string {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('INVALID_WORKSPACE_PATH: Path must be a non-empty string');
  }

  // Reject backslashes to enforce POSIX relative paths
  if (relPath.includes('\\')) {
    throw new Error(`INVALID_WORKSPACE_PATH: Backslashes are not permitted in workspace paths: "${relPath}"`);
  }

  // Reject absolute paths
  if (relPath.startsWith('/')) {
    throw new Error(`INVALID_WORKSPACE_PATH: Absolute paths are not permitted: "${relPath}"`);
  }

  // Reject control characters or null bytes
  if (/[\x00-\x1f\x7f]/.test(relPath)) {
    throw new Error(`INVALID_WORKSPACE_PATH: Path contains illegal control characters: "${relPath}"`);
  }

  const parts = relPath.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`INVALID_WORKSPACE_PATH: Path contains invalid traversal segment "${part}" in "${relPath}"`);
    }
  }

  return relPath;
}

export interface KaggleUploadTree {
  files: Array<{ token: string; description: string }>;
  directories: Array<{
    name: string;
    directories: any[];
    files: Array<{ token: string; description: string }>;
  }>;
}

/**
 * Builds hierarchical Kaggle ApiUploadDirectoryInfo tree from flat list of relative paths and tokens.
 */
export function buildKaggleUploadTree(fileEntries: Array<{ relPath: string; token: string }>): KaggleUploadTree {
  const rootFiles: Array<{ token: string; description: string }> = [];
  const rootDirs = new Map<string, any>();

  function getOrCreateDirNode(parentMap: Map<string, any>, dirName: string) {
    if (!parentMap.has(dirName)) {
      parentMap.set(dirName, {
        name: dirName,
        subDirs: new Map<string, any>(),
        files: [] as Array<{ token: string; description: string }>
      });
    }
    return parentMap.get(dirName);
  }

  for (const entry of fileEntries) {
    const validPath = validateWorkspaceRelativePath(entry.relPath);
    const parts = validPath.split('/');
    const fileName = parts.pop()!;

    if (parts.length === 0) {
      rootFiles.push({
        token: entry.token,
        description: fileName
      });
    } else {
      let currentMap = rootDirs;
      let currentDirNode: any = null;
      for (const seg of parts) {
        currentDirNode = getOrCreateDirNode(currentMap, seg);
        currentMap = currentDirNode.subDirs;
      }
      currentDirNode.files.push({
        token: entry.token,
        description: fileName
      });
    }
  }

  function serializeDir(node: any): any {
    const subDirs = Array.from(node.subDirs.values()).map(serializeDir);
    return {
      name: node.name,
      directories: subDirs,
      files: node.files
    };
  }

  const directories = Array.from(rootDirs.values()).map(serializeDir);

  return {
    files: rootFiles,
    directories
  };
}
