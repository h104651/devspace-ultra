"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScopeChecker = void 0;
const SCOPE_HIERARCHY = {
    admin: ['admin:*'],
    'admin:*': [
        'admin:health', 'admin:killswitch', 'mcp:access', 'tasks:submit', 'tasks:read', 'artifacts:read',
        'kaggle:submit', 'kaggle:read', 'local:read', 'local:write', 'local:test', 'local:exec', 'browser:run',
        'swarm:dispatch', 'raw_shell:run'
    ],
    'tasks:submit': ['tasks:read'],
    'tasks:read': ['artifacts:read'],
    'local:exec': ['local:test', 'local:read'],
    'local:write': ['local:read'],
    'local:test': ['local:read'],
    'kaggle:submit': ['kaggle:read'],
    'swarm:dispatch': ['browser:run']
};
class ScopeChecker {
    static hasScope(grantedScopes, requiredScope) {
        if (!requiredScope)
            return true;
        if (!grantedScopes || grantedScopes.length === 0)
            return false;
        if (grantedScopes.includes('admin') || grantedScopes.includes('admin:*'))
            return true;
        if (grantedScopes.includes(requiredScope))
            return true;
        for (const granted of grantedScopes) {
            if (granted.endsWith(':*')) {
                const prefix = granted.slice(0, -1);
                if (requiredScope.startsWith(prefix))
                    return true;
            }
            const implied = SCOPE_HIERARCHY[granted] || [];
            if (implied.includes(requiredScope))
                return true;
            for (const child of implied) {
                if (child.endsWith(':*') && requiredScope.startsWith(child.slice(0, -1)))
                    return true;
                if ((SCOPE_HIERARCHY[child] || []).includes(requiredScope))
                    return true;
            }
        }
        return false;
    }
    static getRequiredScopeForCapability(capability) {
        if (capability.startsWith('kaggle:')) {
            if (capability.includes('status') || capability.includes('logs') || capability.includes('result') || capability.includes('artifacts') || capability.includes('read')) {
                return 'kaggle:read';
            }
            return 'kaggle:submit';
        }
        if (capability.startsWith('local:')) {
            if (capability === 'local:raw_shell')
                return 'raw_shell:run';
            if (capability.includes('write') || capability.includes('patch') || capability.includes('create') || capability.includes('delete')) {
                return 'local:write';
            }
            if (capability.includes('test') || capability.includes('build'))
                return 'local:test';
            return 'local:read';
        }
        if (capability.startsWith('browser:'))
            return 'browser:run';
        if (capability.startsWith('swarm:'))
            return 'swarm:dispatch';
        if (capability.startsWith('tasks:'))
            return capability.includes('submit') ? 'tasks:submit' : 'tasks:read';
        return 'admin:*';
    }
}
exports.ScopeChecker = ScopeChecker;
