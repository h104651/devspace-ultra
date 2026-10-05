import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArtifactMetadata } from '../types/artifacts';
import { PathSanitizer } from '../security/path-sanitizer';

export class ArtifactStore {
  private baseDir?: string;
  private metadataFile?: string;
  private artifacts: Map<string, ArtifactMetadata> = new Map();
  private maxSizeBytes: number;

  constructor(storageDir?: string, maxSizeBytes = 50 * 1024 * 1024) {
    this.maxSizeBytes = maxSizeBytes;
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
    content: string | Buffer,
    type: ArtifactMetadata['type'] = 'log',
    mimeType = 'text/plain'
  ): ArtifactMetadata {
    const sanitizedName = PathSanitizer.sanitizeArtifactFilename(name);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');

    if (buffer.length > this.maxSizeBytes) {
      throw new Error(`ARTIFACT_SIZE_EXCEEDED: Artifact ${name} (${buffer.length} bytes) exceeds limit of ${this.maxSizeBytes} bytes`);
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const id = `art-${crypto.randomBytes(6).toString('hex')}`;
    const storedFileName = `${id}_${sanitizedName}`;
    let storedPath = storedFileName;
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
      preview = text.length > 2000 ? text.substring(0, 2000) + '... [TRUNCATED]' : text;
    }

    const metadata: ArtifactMetadata = {
      id,
      taskId,
      name: sanitizedName,
      type,
      mimeType,
      sizeBytes: buffer.length,
      storedPath,
      sha256,
      preview,
      createdAt: Date.now()
    };

    this.artifacts.set(id, metadata);
    this.save();
    return metadata;
  }

  public getArtifactMetadata(artifactId: string): ArtifactMetadata | undefined {
    return this.artifacts.get(artifactId);
  }

  public getTaskArtifacts(taskId: string): ArtifactMetadata[] {
    const list: ArtifactMetadata[] = [];
    for (const art of this.artifacts.values()) {
      if (art.taskId === taskId) {
        list.push(art);
      }
    }
    return list;
  }

  public readArtifactContent(artifactId: string): Buffer | undefined {
    const meta = this.artifacts.get(artifactId);
    if (!meta || !fs.existsSync(meta.storedPath)) {
      return undefined;
    }
    return fs.readFileSync(meta.storedPath);
  }
}
