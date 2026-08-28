export type StandardScope =
  | 'offline_access'
  | 'mcp:access'
  | 'tasks:submit'
  | 'tasks:read'
  | 'artifacts:read'
  | 'kaggle:submit'
  | 'kaggle:read'
  | 'local:read'
  | 'local:write'
  | 'local:test'
  | 'local:exec'
  | 'browser:run'
  | 'swarm:dispatch'
  | 'raw_shell:run'
  | 'admin:health'
  | 'admin:killswitch'
  | 'admin:*'
  | 'admin';

export type TokenType = 'client' | 'device' | 'session';

export interface TokenPayload {
  tokenId: string;
  type: TokenType;
  subjectId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  metadata?: Record<string, any>;
}

export interface DeviceRecord {
  deviceId: string;
  name: string;
  platform: 'windows' | 'linux' | 'darwin' | 'cloud';
  status: 'online' | 'offline' | 'revoked';
  capabilities: string[];
  lastConnectedAt?: number;
  lastHeartbeatAt?: number;
  registeredAt: number;
  tokenHash: string;
  revokedAt?: number;
  revocationReason?: string;
  ip?: string;
}

export interface ClientRecord {
  clientId: string;
  name: string;
  scopes: string[];
  status: 'active' | 'revoked';
  createdAt: number;
  tokenHash: string;
  revokedAt?: number;
}
