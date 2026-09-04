export interface AuditEvent {
  id: string;
  timestamp: number;
  actor: string; // clientId, deviceId, or 'system'
  actorType: 'client' | 'device' | 'admin' | 'system';
  action: string;
  taskId?: string;
  resource?: string;
  scopeUsed?: string;
  result: 'ALLOW' | 'DENY' | 'SUCCESS' | 'FAILURE' | 'ERROR';
  details?: Record<string, any>;
  ip?: string;
}
