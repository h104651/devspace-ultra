"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_EXECUTABLE_CAPABILITIES = void 0;
exports.isLocalExecutableCapability = isLocalExecutableCapability;
exports.getRequiredScopeForLocalCapability = getRequiredScopeForLocalCapability;
exports.isCapabilityAuthorized = isCapabilityAuthorized;
const scope_checker_1 = require("../security/scope-checker");
exports.LOCAL_EXECUTABLE_CAPABILITIES = [
    'local:list_projects',
    'local:project_status',
    'local:git_status',
    'local:read_file',
    'local:write_file',
    'local:patch_file',
    'local:list_directory',
    'local:find_files',
    'local:search_text',
    'local:find_repositories',
    'local:create_directory',
    'local:run_tests',
    'local:build_project',
    'local:raw_shell'
];
function isLocalExecutableCapability(capability) {
    return exports.LOCAL_EXECUTABLE_CAPABILITIES.includes(capability);
}
function getRequiredScopeForLocalCapability(capability) {
    return scope_checker_1.ScopeChecker.getRequiredScopeForCapability(capability);
}
function isCapabilityAuthorized(tokenScopes, capability) {
    if (!isLocalExecutableCapability(capability))
        return false;
    const requiredScope = getRequiredScopeForLocalCapability(capability);
    return scope_checker_1.ScopeChecker.hasScope(tokenScopes, requiredScope);
}
