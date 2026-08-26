export type StandardScope =
  | 'kaggle:submit'
  | 'kaggle:read'
  | 'local:read'
  | 'local:write'
  | 'local:test'
  | 'browser:run'
  | 'swarm:dispatch'
  | 'raw_shell:run'
  | 'admin';

export type TokenType = 'client' | 'device' | 'session';

export interface TokenPayload {
  tokenId: string;
  type: TokenType;
  subjectId: string; // clientId or deviceId
  scopes: string[];
  issuedAt: number;
  expiresAt: number; // timestamp ms
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
