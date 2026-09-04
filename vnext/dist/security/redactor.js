"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactText = redactText;
exports.redactObject = redactObject;
const SECRET_PATTERNS = [
    /(?:kaggle[_\s-]?key|api[_\s-]?key|bearer|token|secret|password|passwd|authorization)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{8,})["']?/gi,
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
    /sk-[A-Za-z0-9]{32,}/g,
    /AIza[0-9A-Za-z-_]{35}/g,
    /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, // JWTs
];
function redactText(text) {
    if (!text || typeof text !== 'string')
        return text;
    let redacted = text;
    // Redact known patterns
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, (match, p1) => {
            if (p1) {
                return match.replace(p1, '[REDACTED_SECRET]');
            }
            return '[REDACTED_SECRET]';
        });
    }
    // Common basic auth strings
    redacted = redacted.replace(/basic\s+[A-Za-z0-9+/=]{10,}/gi, 'Basic [REDACTED_AUTH]');
    redacted = redacted.replace(/bearer\s+[A-Za-z0-9_\-\.]{10,}/gi, 'Bearer [REDACTED_TOKEN]');
    return redacted;
}
function redactObject(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (typeof obj === 'string') {
        return redactText(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => redactObject(item));
    }
    if (typeof obj === 'object') {
        const clean = {};
        for (const [key, value] of Object.entries(obj)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('secret') ||
                lowerKey.includes('token') ||
                lowerKey.includes('password') ||
                lowerKey.includes('key') ||
                lowerKey.includes('auth')) {
                if (typeof value === 'string' && value.length > 0) {
                    clean[key] = '[REDACTED]';
                    continue;
                }
            }
            clean[key] = redactObject(value);
        }
        return clean;
    }
    return obj;
}
