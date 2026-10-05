export interface ArtifactMetadata {
  id: string;
  taskId: string;
  name: string;
  type: 'log' | 'stdout' | 'stderr' | 'json' | 'csv' | 'binary' | 'image' | 'archive' | 'notebook';
  mimeType?: string;
  sizeBytes: number;
  storedPath?: string;
  sha256: string;
  preview?: string;
  createdAt: number;
}

export interface ArtifactQuery {
  taskId: string;
  type?: string;
  limit?: number;
}
