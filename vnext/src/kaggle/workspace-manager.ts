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
