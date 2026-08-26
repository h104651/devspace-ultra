import { StandardScope } from '../types/auth';

const SCOPE_HIERARCHY: Record<string, string[]> = {
  admin: [
    'kaggle:submit',
    'kaggle:read',
    'local:read',
    'local:write',
    'local:test',
    'browser:run',
    'swarm:dispatch',
    'raw_shell:run'
  ],
  'local:write': ['local:read'],
  'kaggle:submit': ['kaggle:read'],
  'swarm:dispatch': ['browser:run']
};

export class ScopeChecker {
  /**
   * Checks if user/client scopes satisfy the required scope.
   */
  static hasScope(grantedScopes: string[], requiredScope: string): boolean {
    if (!grantedScopes || grantedScopes.length === 0) return false;
    if (!requiredScope) return true;

    // Admin has everything
    if (grantedScopes.includes('admin')) return true;

    // Exact match
    if (grantedScopes.includes(requiredScope)) return true;

    // Check hierarchy expansion
    for (const granted of grantedScopes) {
      const implied = SCOPE_HIERARCHY[granted];
      if (implied && implied.includes(requiredScope)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine required scope for a task capability.
   */
  static getRequiredScopeForCapability(capability: string): StandardScope {
    if (capability.startsWith('kaggle:')) {
      if (capability.includes('status') || capability.includes('logs') || capability.includes('artifacts')) {
        return 'kaggle:read';
      }
      return 'kaggle:submit';
    }

    if (capability.startsWith('local:')) {
      if (capability === 'local:raw_shell') {
        return 'raw_shell:run';
      }
      if (capability.includes('write') || capability.includes('patch') || capability.includes('create')) {
        return 'local:write';
      }
      if (capability.includes('test') || capability.includes('build')) {
        return 'local:test';
      }
      return 'local:read';
    }

    if (capability.startsWith('browser:')) {
      return 'browser:run';
    }

    if (capability.startsWith('swarm:')) {
      return 'swarm:dispatch';
    }

    return 'admin';
  }
}
