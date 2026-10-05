import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AuditEvent } from '../types/audit';
import { redactObject } from './redactor';

export class AuditLogger {
  private logFilePath?: string;

  constructor(storageDir?: string) {
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
          const line = JSON.stringify(fullEvent) + '\n';
          fs.appendFileSync(this.logFilePath, line, 'utf-8');
        }
      } catch (err) {
        // Silently ignore if storage dir was cleaned up during test teardown
      }
    }

    return fullEvent;
  }

  public getRecentLogs(limit = 100): AuditEvent[] {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const events: AuditEvent[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
      return events.reverse();
    } catch {
      return [];
    }
  }
}
