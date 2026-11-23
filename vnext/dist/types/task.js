"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_TASK_STATUSES = exports.ACTIVE_TASK_STATUSES = void 0;
exports.ACTIVE_TASK_STATUSES = new Set([
    'queued',
    'claimed',
    'acknowledged',
    'running',
    'retrying'
]);
exports.TERMINAL_TASK_STATUSES = new Set([
    'succeeded',
    'failed',
    'cancelled',
    'stale'
]);
