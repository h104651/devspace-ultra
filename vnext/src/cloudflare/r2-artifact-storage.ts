import { ArtifactMetadata } from '../types/artifacts';

export interface R2Bucket {
  put(key: string, value: any, options?: any): Promise<any>;
  get(key: string): Promise<any>;
  delete(key: string): Promise<void>;
}

export const INLINE_SIZE_THRESHOLD_BYTES = 256 * 1024; // 256 KB

export class CloudflareR2ArtifactStorage {
  private r2?: R2Bucket;

  constructor(r2Bucket?: R2Bucket) {
    this.r2 = r2Bucket;
  }

  /**
   * Saves an artifact either in R2 (if large or binary) and generates metadata.
   */
  public async saveArtifact(
    taskId: string,
    filename: string,
    content: string | ArrayBuffer | Uint8Array,
    type: 'log' | 'json' | 'image' | 'binary' = 'binary'
  ): Promise<{ metadata: ArtifactMetadata; r2Key?: string }> {
    const id = `art-${crypto.randomUUID()}`;
    const rawBuffer = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    const sizeBytes = rawBuffer.byteLength;

    // Calculate SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    let preview: string | undefined;
    let r2Key: string | undefined;

    // Generate preview for text/json
    if (type === 'log' || type === 'json') {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(rawBuffer);
      preview = text.length > 5000 ? text.substring(0, 5000) + '... [truncated]' : text;
    }

    // If >= 256 KB or R2 is available, write full payload to R2
    if (this.r2 && sizeBytes >= INLINE_SIZE_THRESHOLD_BYTES) {
      r2Key = `tasks/${taskId}/${id}_${filename}`;
      await this.r2.put(r2Key, rawBuffer, {
        customMetadata: {
          taskId,
          sha256,
          originalName: filename
        }
      });
    }

    const metadata: ArtifactMetadata = {
      id,
      taskId,
      name: filename,
      type,
      sizeBytes,
      sha256,
      preview,
      createdAt: Date.now()
    };

    return { metadata, r2Key };
  }

  public async getArtifactContent(r2Key: string): Promise<ArrayBuffer | null> {
    if (!this.r2) return null;
    const obj = await this.r2.get(r2Key);
    if (!obj) return null;
    return obj.arrayBuffer();
  }
}
