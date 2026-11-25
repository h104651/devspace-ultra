"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_AGENT_ENV_VARS = exports.ALLOWED_SYSTEM_ENV_VARS = exports.SENSITIVE_ENV_DENYLIST = exports.NON_RETRYABLE_EXIT_CODES = exports.AGENT_EXIT_CODES = void 0;
exports.classifyAgentExitCode = classifyAgentExitCode;
exports.buildSanitizedAgentEnv = buildSanitizedAgentEnv;
exports.stripSensitiveEnvInPlace = stripSensitiveEnvInPlace;
exports.redactSensitiveLogLine = redactSensitiveLogLine;
exports.AGENT_EXIT_CODES = {
    CLEAN: 0,
    TRANSIENT_FAILURE: 1,
    CONFIG_ERROR: 10,
    LOCK_CONFLICT: 11,
    POLICY_REJECTED: 12,
    SHUTDOWN_TIMEOUT: 13
};
exports.NON_RETRYABLE_EXIT_CODES = new Set([
    exports.AGENT_EXIT_CODES.CLEAN,
    exports.AGENT_EXIT_CODES.CONFIG_ERROR,
    exports.AGENT_EXIT_CODES.LOCK_CONFLICT,
    exports.AGENT_EXIT_CODES.POLICY_REJECTED,
    exports.AGENT_EXIT_CODES.SHUTDOWN_TIMEOUT
]);
function classifyAgentExitCode(code) {
    switch (code) {
        case exports.AGENT_EXIT_CODES.CLEAN:
            return 'CLEAN_STOP';
        case exports.AGENT_EXIT_CODES.CONFIG_ERROR:
            return 'CONFIG_ERROR';
        case exports.AGENT_EXIT_CODES.LOCK_CONFLICT:
            return 'LOCK_CONFLICT';
        case exports.AGENT_EXIT_CODES.POLICY_REJECTED:
            return 'POLICY_REJECTED';
        case exports.AGENT_EXIT_CODES.SHUTDOWN_TIMEOUT:
            return 'SHUTDOWN_TIMEOUT_LOCK_RETAINED';
        default:
            return 'TRANSIENT_FAILURE';
    }
}
exports.SENSITIVE_ENV_DENYLIST = new Set([
    'ADMIN_SECRET',
    'MASTER_SECRET',
    'CLIENT_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'KAGGLE_KEY',
    'KAGGLE_API_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN'
]);
exports.ALLOWED_SYSTEM_ENV_VARS = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PATH',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'COMPUTERNAME',
    'USERNAME',
    'USERDOMAIN',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'TEMP',
    'TMP',
    'SYSTEMDRIVE',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'LANG',
    'LC_ALL',
    'TZ'
]);
exports.ALLOWED_AGENT_ENV_VARS = new Set([
    'GATEWAY_URL',
    'AGENT_ID',
    'AGENT_TOKEN',
    'AGENT_NAME',
    'LOCAL_PROJECTS_CONFIG',
    'PROJECTS_CONFIG',
    'ALLOWED_WORKSPACES',
    'ALLOW_RAW_SHELL',
    'DEVSPACE_ENV_FILE',
    'DEVSPACE_CONFIG_DIR',
    'DEVSPACE_RELEASE_DIR',
    'DEVSPACE_LOG_DIR',
    'DEVSPACE_SHUTDOWN_TIMEOUT_MS',
    'DEVSPACE_AGENT_LOCK_DIR'
]);
/**
 * Constructs a minimal, least-privilege environment for the Agent child process.
 * Never passes arbitrary parent environment variables or unrelated admin/cloud secrets.
 */
function buildSanitizedAgentEnv(parentEnv, fileEnv = {}) {
    const sanitized = {};
    const stripped = new Set();
    const dropped = new Set();
    for (const [rawKey, rawVal] of Object.entries(parentEnv)) {
        if (rawVal === undefined)
            continue;
        const upper = rawKey.toUpperCase();
        if (exports.SENSITIVE_ENV_DENYLIST.has(upper)) {
            stripped.add(rawKey);
            continue;
        }
        if (exports.ALLOWED_SYSTEM_ENV_VARS.has(upper) || exports.ALLOWED_AGENT_ENV_VARS.has(upper)) {
            sanitized[rawKey] = rawVal;
        }
        else {
            dropped.add(rawKey);
        }
    }
    for (const [rawKey, rawVal] of Object.entries(fileEnv)) {
        if (rawVal === undefined)
            continue;
        const upper = rawKey.toUpperCase();
        if (exports.SENSITIVE_ENV_DENYLIST.has(upper)) {
            stripped.add(rawKey);
            continue;
        }
        if (exports.ALLOWED_AGENT_ENV_VARS.has(upper)) {
            sanitized[rawKey] = rawVal;
        }
        else {
            dropped.add(rawKey);
        }
    }
    return {
        env: sanitized,
        strippedSensitiveKeys: Array.from(stripped).sort(),
        droppedUnlistedKeys: Array.from(dropped).sort()
    };
}
function stripSensitiveEnvInPlace(targetEnv) {
    const removed = [];
    for (const key of Object.keys(targetEnv)) {
        if (exports.SENSITIVE_ENV_DENYLIST.has(key.toUpperCase())) {
            delete targetEnv[key];
            removed.push(key);
        }
    }
    return removed.sort();
}
function redactSensitiveLogLine(line) {
    return line
        .replace(/dsu_(?:device|client)_[A-Za-z0-9._-]+/g, '<REDACTED_TOKEN>')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <REDACTED>')
        .replace(/\b(AGENT_TOKEN|ADMIN_SECRET|MASTER_SECRET|CLIENT_TOKEN|CLOUDFLARE_API_TOKEN|KAGGLE_KEY|KAGGLE_API_TOKEN|ipcSecret|token)\b(\s*[:=]\s*)(["']?)[^"',;\s}]+(\3)/gi, '$1$2$3<REDACTED>$4');
}
