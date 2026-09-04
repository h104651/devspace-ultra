import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArtifactMetadata } from '../types/artifacts';
import { PathSanitizer } from '../security/path-sanitizer';
import { IStorageAdapter } from './storage-adapter.interface';

export type ArtifactPayloadSink = (metadata: ArtifactMetadata, bytes: Uint8Array) => void | Promise<void>;

export class ArtifactStore {
  private baseDir?: string;
  private metadataFile?: string;
  private artifacts: Map<string, ArtifactMetadata> = new Map();
  private hydratedTaskIds: Set<string> = new Set();
  private maxSizeBytes: number;
  private storageAdapter?: IStorageAdapter;
  private payloadSink?: ArtifactPayloadSink;

  constructor(
    storageDir?: string,
    maxSizeBytes = 50 * 1024 * 1024,
    storageAdapter?: IStorageAdapter,
    payloadSink?: ArtifactPayloadSink
  ) {
    this.maxSizeBytes = maxSizeBytes;
    this.storageAdapter = storageAdapter;
    this.payloadSink = payloadSink;
    if (storageDir && storageDir !== ':memory:') {
      this.baseDir = path.join(storageDir, 'artifacts');
      this.metadataFile = path.join(storageDir, 'artifacts_metadata.json');
      try {
        if (!fs.existsSync(this.baseDir)) {
          fs.mkdirSync(this.baseDir, { recursive: true });
        }
        this.load();
      } catch {}
    }
  }

  public hydrate(artifacts: ArtifactMetadata[]): void {
    for (const meta of artifacts || []) {
      if (meta?.id) this.artifacts.set(meta.id, meta);
    }
  }

  private load() {
    if (this.metadataFile && fs.existsSync(this.metadataFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.metadataFile, 'utf-8'));
        for (const meta of data) {
          this.artifacts.set(meta.id, meta);
        }
      } catch (err) {
        console.error('Failed to load artifact metadata:', err);
      }
    }
  }

  private save() {
    if (!this.metadataFile) return;
    try {
      const list = Array.from(this.artifacts.values());
      fs.writeFileSync(this.metadataFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save artifact metadata:', err);
    }
  }

  public saveArtifact(
    taskId: string,
    name: string,
    content: string | Buffer | Uint8Array | ArrayBuffer,
    type: ArtifactMetadata['type'] = 'log',
    mimeType = 'text/plain'
  ): ArtifactMetadata {
    const sanitizedName = PathSanitizer.sanitizeArtifactFilename(name);
    const buffer = Buffer.isBuffer(content)
      ? content
      : content instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(content))
        : content instanceof Uint8Array
          ? Buffer.from(content)
          : Buffer.from(content, 'utf-8');

    if (buffer.length > this.maxSizeBytes) {
      throw new Error(`ARTIFACT_SIZE_EXCEEDED: Artifact ${name} (${buffer.length} bytes) exceeds limit of ${this.maxSizeBytes} bytes`);
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const id = `art-${crypto.randomBytes(6).toString('hex')}`;
    const storedFileName = `${id}_${sanitizedName}`;
    let storedPath: string | undefined;

    if (this.baseDir) {
      const taskDir = path.join(this.baseDir, taskId);
      try {
        if (!fs.existsSync(taskDir)) {
          fs.mkdirSync(taskDir, { recursive: true });
        }
        storedPath = path.join(taskDir, storedFileName);
        fs.writeFileSync(storedPath, buffer);
      } catch {}
    }

    let preview: string | undefined;
    if (type === 'log' || type === 'stdout' || type === 'stderr' || type === 'json' || type === 'csv') {
      const text = buffer.toString('utf-8');
      preview = text.length > 5000 ? text.substring(0, 5000) + '... [TRUNCATED]' : text;
    }

    const metadata: ArtifactMetadata = {
      id,
      taskId,
      name: sanitizedName,
      type,
      mimeType,
      sizeBytes: buffer.length,
      ...(storedPath ? { storedPath } : {}),
      sha256,
      preview,
      createdAt: Date.now()
    };

    this.artifacts.set(id, metadata);
    this.save();

    if (this.storageAdapter) {
      void this.storageAdapter.saveArtifactMetadata(metadata).catch(err => {
        console.error(`Failed to persist artifact metadata ${id}:`, err);
      });
    }

    if (this.payloadSink) {
      const bytes = Uint8Array.from(buffer);
      try {
        const pending = this.payloadSink(metadata, bytes);
        if (pending && typeof (pending as Promise<void>).catch === 'function') {
          void (pending as Promise<void>).catch(err => console.error(`Failed to persist artifact payload ${id}:`, err));
        }
      } catch (err) {
        console.error(`Failed to persist artifact payload ${id}:`, err);
      }
    }

    return metadata;
  }

  public getArtifactMetadata(artifact: string | { id: string }): ArtifactMetadata | undefined {
    const artifactId = typeof artifact === 'string' ? artifact : artifact?.id;
    if (!artifactId) return undefined;
    const cached = this.artifacts.get(artifactId);
    if (cached) return cached;
    const durable = this.storageAdapter?.getArtifactMetadataSync?.(artifactId);
    if (durable) this.artifacts.set(durable.id, durable);
    return durable;
  }

  public getTaskArtifacts(taskId: string): ArtifactMetadata[] {
    if (!this.hydratedTaskIds.has(taskId) && this.storageAdapter?.listTaskArtifactsSync) {
      const durable = this.storageAdapter.listTaskArtifactsSync(taskId);
      for (const meta of durable) this.artifacts.set(meta.id, meta);
      this.hydratedTaskIds.add(taskId);
    }

    const list: ArtifactMetadata[] = [];
    for (const art of this.artifacts.values()) {
      if (art.taskId === taskId) list.push(art);
    }
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  public listArtifacts(): ArtifactMetadata[] {
    return Array.from(this.artifacts.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public readArtifactContent(artifactId: string): Buffer | undefined {
    const meta = this.artifacts.get(artifactId);
    if (!meta?.storedPath || !fs.existsSync(meta.storedPath)) {
      return undefined;
    }
    return fs.readFileSync(meta.storedPath);
  }

  // Compatibility alias retained for the legacy/local Express gateway. The
  // Cloudflare path reads payloads from R2 directly, while local file-backed
  // runtimes historically called getArtifactContent().
  public getArtifactContent(artifactId: string): Buffer | undefined {
    return this.readArtifactContent(artifactId);
  }
}
