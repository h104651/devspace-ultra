/**
 * Connection Health Policy & Session Definitions
 *
 * Centralized connection lifecycle rules, health thresholds, and session abstractions
 * shared across Gateway Durable Object, ConnectionManager, TaskRouter, and MCP handlers.
 */

import { createHash, timingSafeEqual } from 'crypto';

export const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds agent heartbeat frequency
export const HEARTBEAT_TTL_MS = 45_000;      // 45 seconds timeout (3x interval, accommodates network jitter and 2 missed heartbeats)

export interface AgentSessionAttachment {
  sessionId: string;
  supportsAttemptFencing?: boolean;
  executionPolicyRevision?: string;
  reconnectProofHash?: string;
  reconnectSequence?: number;
  deviceId: string;
  name: string;
  platform: 'windows' | 'linux' | 'darwin';
  capabilities: string[];
  connectedAt: number;
  lastHeartbeatAt: number;
}

export interface AgentSessionInfo {
  sessionId: string;
  supportsAttemptFencing?: boolean;
  executionPolicyRevision?: string;
  reconnectProofHash?: string;
  reconnectSequence?: number;
  deviceId: string;
  name: string;
  platform: string;
  capabilities: string[];
  connectedAt: number;
  lastHeartbeatAt: number;
  socket?: any;
}

export type ConnectionLifecycleState =
  | 'registered' // Registered in database/auth
  | 'connected'  // Physical WebSocket open
  | 'healthy'    // Physical WebSocket open + heartbeat fresh (< TTL)
  | 'stale'      // Physical WebSocket open + heartbeat expired (>= TTL)
  | 'revoked';   // Device token or device revoked

/**
 * Determines whether an agent session is healthy based on physical connection and heartbeat freshness.
 * Accurately handles the initial registration phase where connectedAt serves as initial heartbeat.
 */
export function isSessionHealthy(
  session?: { sessionId?: string; deviceId?: string; lastHeartbeatAt?: number; connectedAt?: number },
  now = Date.now(),
  ttlMs = HEARTBEAT_TTL_MS
): boolean {
  if (!session || !session.deviceId) return false;
  const heartbeatTime = (typeof session.lastHeartbeatAt === 'number' && session.lastHeartbeatAt > 0)
    ? session.lastHeartbeatAt
    : ((typeof session.connectedAt === 'number' && session.connectedAt > 0) ? session.connectedAt : 0);
  if (heartbeatTime <= 0) return false;
  return (now - heartbeatTime) <= ttlMs;
}

/**
 * Evaluates the full connection lifecycle state for a given session.
 */
export function getSessionLifecycleState(
  session: { sessionId?: string; deviceId?: string; lastHeartbeatAt?: number },
  isRevoked: boolean,
  now = Date.now(),
  ttlMs = HEARTBEAT_TTL_MS
): ConnectionLifecycleState {
  if (isRevoked) return 'revoked';
  if (!session || !session.sessionId) return 'registered';
  if (isSessionHealthy(session, now, ttlMs)) return 'healthy';
  return 'stale';
}

export interface ReconnectIdentity {
  reconnectProofHash: string;
  reconnectSequence: number;
}

/** Validate the process-lifetime proof and retain only its digest. */
export function parseReconnectIdentity(message: { reconnectProof?: unknown; reconnectSequence?: unknown }): ReconnectIdentity | undefined {
  if (message.reconnectProof === undefined && message.reconnectSequence === undefined) return undefined;
  if (typeof message.reconnectProof !== 'string' || message.reconnectProof.length !== 64 || !/^[a-f0-9]{64}$/.test(message.reconnectProof) ||
      typeof message.reconnectSequence !== 'number' || !Number.isSafeInteger(message.reconnectSequence) || message.reconnectSequence < 1) {
    throw new Error('INVALID_RECONNECT_IDENTITY');
  }
  return {
    reconnectProofHash: createHash('sha256').update(message.reconnectProof, 'ascii').digest('hex'),
    reconnectSequence: message.reconnectSequence
  };
}

export function isSameReconnectIdentity(previous: Partial<ReconnectIdentity> | undefined, next: ReconnectIdentity | undefined): boolean {
  if (!previous?.reconnectProofHash || !next || !/^[a-f0-9]{64}$/.test(previous.reconnectProofHash)) return false;
  return timingSafeEqual(Buffer.from(previous.reconnectProofHash, 'hex'), Buffer.from(next.reconnectProofHash, 'hex'));
}

export function canResumeSession(previous: Partial<ReconnectIdentity> | undefined, next: ReconnectIdentity | undefined): boolean {
  return isSameReconnectIdentity(previous, next) && Number.isSafeInteger(previous?.reconnectSequence) &&
    next!.reconnectSequence > previous!.reconnectSequence!;
}
