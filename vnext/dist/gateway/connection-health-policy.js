"use strict";
/**
 * Connection Health Policy & Session Definitions
 *
 * Centralized connection lifecycle rules, health thresholds, and session abstractions
 * shared across Gateway Durable Object, ConnectionManager, TaskRouter, and MCP handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEARTBEAT_TTL_MS = exports.HEARTBEAT_INTERVAL_MS = void 0;
exports.isSessionHealthy = isSessionHealthy;
exports.getSessionLifecycleState = getSessionLifecycleState;
exports.HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds agent heartbeat frequency
exports.HEARTBEAT_TTL_MS = 45_000; // 45 seconds timeout (3x interval, accommodates network jitter and 2 missed heartbeats)
/**
 * Determines whether an agent session is healthy based on physical connection and heartbeat freshness.
 * Accurately handles the initial registration phase where connectedAt serves as initial heartbeat.
 */
function isSessionHealthy(session, now = Date.now(), ttlMs = exports.HEARTBEAT_TTL_MS) {
    if (!session || !session.deviceId)
        return false;
    const heartbeatTime = (typeof session.lastHeartbeatAt === 'number' && session.lastHeartbeatAt > 0)
        ? session.lastHeartbeatAt
        : ((typeof session.connectedAt === 'number' && session.connectedAt > 0) ? session.connectedAt : 0);
    if (heartbeatTime <= 0)
        return false;
    return (now - heartbeatTime) <= ttlMs;
}
/**
 * Evaluates the full connection lifecycle state for a given session.
 */
function getSessionLifecycleState(session, isRevoked, now = Date.now(), ttlMs = exports.HEARTBEAT_TTL_MS) {
    if (isRevoked)
        return 'revoked';
    if (!session || !session.sessionId)
        return 'registered';
    if (isSessionHealthy(session, now, ttlMs))
        return 'healthy';
    return 'stale';
}
