import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AuditEvent } from '../types/audit';
import { redactObject } from './redactor';
import { IStorageAdapter } from '../storage/storage-adapter.interface';

export class AuditLogger {
  private logFilePath?: string;
  private storageAdapter?: IStorageAdapter;

  constructor(storageDir?: string, storageAdapter?: IStorageAdapter) {
    this.storageAdapter = storageAdapter;
    if (storageDir) {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.logFilePath = path.join(storageDir, 'audit_log.jsonl');
    }
  }

  public log(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const fullEvent: AuditEvent = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...event,
      details: redactObject(event.details)
    };

    if (this.logFilePath) {
      try {
        const dir = path.dirname(this.logFilePath);
        if (fs.existsSync(dir)) {
          fs.appendFileSync(this.logFilePath, JSON.stringify(fullEvent) + '\n', 'utf-8');
        }
      } catch {}
    }

    if (this.storageAdapter) {
      void this.storageAdapter.appendAuditLog(fullEvent).catch(err => {
        console.error(`Failed to persist audit event ${fullEvent.id}:`, err);
      });
    }

    return fullEvent;
  }

  public getRecentLogs(limit = 100): AuditEvent[] {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) return [];

    try {
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const events: AuditEvent[] = [];
      for (const line of lines.slice(-limit)) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      return events.reverse();
    } catch {
      return [];
    }
  }
}
