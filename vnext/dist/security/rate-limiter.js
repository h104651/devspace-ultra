"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
class RateLimiter {
    requests = new Map();
    maxRequestsPerWindow;
    windowMs;
    constructor(maxRequestsPerWindow = 60, windowMs = 60000) {
        this.maxRequestsPerWindow = maxRequestsPerWindow;
        this.windowMs = windowMs;
    }
    isAllowed(key) {
        const now = Date.now();
        const timestamps = this.requests.get(key) || [];
        const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
        if (validTimestamps.length >= this.maxRequestsPerWindow) {
            const oldest = validTimestamps[0];
            const retryAfterMs = this.windowMs - (now - oldest);
            return { allowed: false, retryAfterMs, remaining: 0 };
        }
        validTimestamps.push(now);
        this.requests.set(key, validTimestamps);
        return {
            allowed: true,
            remaining: this.maxRequestsPerWindow - validTimestamps.length
        };
    }
    reset(key) {
        if (key) {
            this.requests.delete(key);
        }
        else {
            this.requests.clear();
        }
    }
}
exports.RateLimiter = RateLimiter;
