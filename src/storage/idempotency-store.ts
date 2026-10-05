import * as fs from 'fs';
import * as path from 'path';

export interface IdempotencyRecord {
  key: string;
  result: any;
  createdAt: number;
  expiresAt: number;
}

export class IdempotencyStore {
  private records: Map<string, IdempotencyRecord> = new Map();
  private filePath?: string;
  private defaultTtlMs: number;

  constructor(storageDir?: string, defaultTtlMs = 24 * 3600 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
    if (storageDir) {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.filePath = path.join(storageDir, 'idempotency_store.json');
      this.load();
    }
  }

  private load() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw);
        const now = Date.now();
        for (const [k, v] of Object.entries<IdempotencyRecord>(data)) {
          if (v.expiresAt > now) {
            this.records.set(k, v);
          }
        }
      } catch (err) {
        console.error('Failed to load idempotency store:', err);
      }
    }
  }

  private save() {
    if (this.filePath) {
      try {
        const obj: Record<string, IdempotencyRecord> = {};
        for (const [k, v] of this.records.entries()) {
          obj[k] = v;
        }
        fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to save idempotency store:', err);
      }
    }
  }

  public get(key: string): any | undefined {
    if (!key) return undefined;
    const record = this.records.get(key);
    if (!record) return undefined;

    if (Date.now() > record.expiresAt) {
      this.records.delete(key);
      this.save();
      return undefined;
    }

    return record.result;
  }

  public set(key: string, result: any, ttlMs?: number): void {
    if (!key) return;
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);

    this.records.set(key, {
      key,
      result,
      createdAt: now,
      expiresAt
    });

    this.save();
  }
}
