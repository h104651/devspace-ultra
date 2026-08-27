import { StandardScope } from '../types/auth';
import { ScopeChecker } from '../security/scope-checker';

export const LOCAL_EXECUTABLE_CAPABILITIES = [
  'local:git_status',
  'local:read_file',
  'local:write_file',
  'local:patch_file',
  'local:run_tests',
  'local:build_project',
  'local:raw_shell'
] as const;

export type LocalExecutableCapability = typeof LOCAL_EXECUTABLE_CAPABILITIES[number];

export function isLocalExecutableCapability(capability: string): capability is LocalExecutableCapability {
  return (LOCAL_EXECUTABLE_CAPABILITIES as readonly string[]).includes(capability);
}

export function getRequiredScopeForLocalCapability(capability: string): StandardScope {
  return ScopeChecker.getRequiredScopeForCapability(capability);
}

export function isCapabilityAuthorized(tokenScopes: string[], capability: string): boolean {
  if (!isLocalExecutableCapability(capability)) return false;
  const requiredScope = getRequiredScopeForLocalCapability(capability);
  return ScopeChecker.hasScope(tokenScopes, requiredScope);
}
