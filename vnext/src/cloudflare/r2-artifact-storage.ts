import { ArtifactMetadata } from '../types/artifacts';
import { R2UsageGuard } from './r2-usage-guard';

export interface R2Bucket {
  put(key: string, value: any, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  delete(key: string): Promise<void>;
}

export const INLINE_SIZE_THRESHOLD_BYTES = 256 * 1024;

const ALWAYS_OBJECT_STORAGE = new Set<ArtifactMetadata['type']>([
  'binary', 'image', 'archive', 'notebook'
]);

function safeFilename(filename: string): string {
  return filename.replace(/[\\/\0]/g, '_').slice(0, 180) || 'artifact.bin';
}

export class CloudflareR2ArtifactStorage {
  private r2?: R2Bucket;
  private guard?: R2UsageGuard;

  constructor(r2Bucket?: R2Bucket, guard?: R2UsageGuard) {
    this.r2 = r2Bucket;
    this.guard = guard;
  }

  public getGuard(): R2UsageGuard | undefined {
    return this.guard;
  }

  public objectKey(metadata: Pick<ArtifactMetadata, 'taskId' | 'id' | 'name'>): string {
    return `tasks/${metadata.taskId}/${metadata.id}_${safeFilename(metadata.name)}`;
  }

  public async saveArtifact(
    taskId: string,
    filename: string,
    content: string | ArrayBuffer | Uint8Array,
    type: ArtifactMetadata['type'] = 'binary',
    mimeType?: string
  ): Promise<{ metadata: ArtifactMetadata; r2Key?: string }> {
    const id = `art-${crypto.randomUUID()}`;
    const rawBuffer = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    let preview: string | undefined;
    if (['log', 'stdout', 'stderr', 'json', 'csv'].includes(type)) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(rawBuffer);
      preview = text.length > 5000 ? text.substring(0, 5000) + '... [truncated]' : text;
    }

    const metadata: ArtifactMetadata = {
      id,
      taskId,
      name: safeFilename(filename),
      type,
      mimeType,
      sizeBytes: rawBuffer.byteLength,
      sha256,
      preview,
      createdAt: Date.now()
    };

    const r2Key = await this.saveArtifactPayload(metadata, rawBuffer);
    return { metadata, r2Key };
  }

  public async saveArtifactPayload(
    metadata: ArtifactMetadata,
    content: string | ArrayBuffer | Uint8Array
  ): Promise<string | undefined> {
    if (!this.r2) return undefined;

    const rawBuffer = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    const shouldStore = rawBuffer.byteLength >= INLINE_SIZE_THRESHOLD_BYTES || ALWAYS_OBJECT_STORAGE.has(metadata.type);
    if (!shouldStore) return undefined;

    // Hard cost guard check BEFORE performing R2 network operation
    if (this.guard) {
      await this.guard.checkAndValidatePut(rawBuffer.byteLength);
    }

    const key = this.objectKey(metadata);
    await this.r2.put(key, rawBuffer, {
      httpMetadata: metadata.mimeType ? { contentType: metadata.mimeType } : undefined,
      customMetadata: {
        taskId: metadata.taskId,
        artifactId: metadata.id,
        sha256: metadata.sha256,
        originalName: metadata.name
      }
    });

    if (this.guard) {
      await this.guard.recordPutSuccess(rawBuffer.byteLength);
    }

    return key;
  }

  public async getArtifactContent(r2Key: string): Promise<ArrayBuffer | null> {
    if (!this.r2) return null;

    if (this.guard) {
      await this.guard.checkAndValidateGet();
    }

    const obj = await this.r2.get(r2Key);
    if (!obj) return null;

    if (this.guard) {
      await this.guard.recordGetSuccess();
    }

    return obj.arrayBuffer();
  }

  public async getArtifact(metadata: ArtifactMetadata): Promise<ArrayBuffer | null> {
    return this.getArtifactContent(this.objectKey(metadata));
  }

  public async deleteArtifact(r2Key: string, sizeBytes?: number): Promise<void> {
    if (!this.r2) return;

    if (this.guard) {
      await this.guard.checkAndValidateDelete();
    }

    await this.r2.delete(r2Key);

    if (this.guard) {
      await this.guard.recordDeleteSuccess(sizeBytes);
    }
  }
}
