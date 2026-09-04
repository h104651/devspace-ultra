"use strict";
/**
 * DevSpace Ultra vNext — Kaggle Workspace Manager
 *
 * Manages Large Project Workspace Mode backed by Kaggle Datasets and thin runner kernels.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeWorkspaceFingerprint = computeWorkspaceFingerprint;
exports.validateProjectManifest = validateProjectManifest;
exports.validateWorkspaceRelativePath = validateWorkspaceRelativePath;
exports.buildKaggleUploadTree = buildKaggleUploadTree;
const crypto = __importStar(require("crypto"));
/**
 * Computes canonical workspace fingerprint from project manifest file mappings.
 */
function computeWorkspaceFingerprint(manifest) {
    const sortedKeys = Object.keys(manifest.files || {}).sort();
    const canonicalEntries = sortedKeys.map(k => ({
        path: k,
        size: manifest.files[k].size,
        sha256: manifest.files[k].sha256
    }));
    const payload = {
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        entrypoint: manifest.entrypoint,
        runnerKernelRef: manifest.runnerKernelRef,
        files: canonicalEntries
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
/**
 * Validates project manifest schema integrity.
 */
function validateProjectManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest is not a valid object');
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
        throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required string field "name"');
    }
    if (!manifest.slug || typeof manifest.slug !== 'string') {
        throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required string field "slug"');
    }
    if (typeof manifest.version !== 'number') {
        throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required number field "version"');
    }
    if (!manifest.files || typeof manifest.files !== 'object') {
        throw new Error('INVALID_WORKSPACE_MANIFEST: Manifest missing required object field "files"');
    }
    return manifest;
}
/**
 * Validates and normalizes relative POSIX workspace path.
 * Rejects absolute paths, .., path traversal, empty paths, backslashes, and control characters.
 */
function validateWorkspaceRelativePath(relPath) {
    if (!relPath || typeof relPath !== 'string') {
        throw new Error('INVALID_WORKSPACE_PATH: Path must be a non-empty string');
    }
    // Reject backslashes to enforce POSIX relative paths
    if (relPath.includes('\\')) {
        throw new Error(`INVALID_WORKSPACE_PATH: Backslashes are not permitted in workspace paths: "${relPath}"`);
    }
    // Reject absolute paths
    if (relPath.startsWith('/')) {
        throw new Error(`INVALID_WORKSPACE_PATH: Absolute paths are not permitted: "${relPath}"`);
    }
    // Reject control characters or null bytes
    if (/[\x00-\x1f\x7f]/.test(relPath)) {
        throw new Error(`INVALID_WORKSPACE_PATH: Path contains illegal control characters: "${relPath}"`);
    }
    const parts = relPath.split('/');
    for (const part of parts) {
        if (!part || part === '.' || part === '..') {
            throw new Error(`INVALID_WORKSPACE_PATH: Path contains invalid traversal segment "${part}" in "${relPath}"`);
        }
    }
    return relPath;
}
/**
 * Builds hierarchical Kaggle ApiUploadDirectoryInfo tree from flat list of relative paths and tokens.
 */
function buildKaggleUploadTree(fileEntries) {
    const rootFiles = [];
    const rootDirs = new Map();
    function getOrCreateDirNode(parentMap, dirName) {
        if (!parentMap.has(dirName)) {
            parentMap.set(dirName, {
                name: dirName,
                subDirs: new Map(),
                files: []
            });
        }
        return parentMap.get(dirName);
    }
    for (const entry of fileEntries) {
        const validPath = validateWorkspaceRelativePath(entry.relPath);
        const parts = validPath.split('/');
        const fileName = parts.pop();
        if (parts.length === 0) {
            rootFiles.push({
                token: entry.token,
                description: fileName
            });
        }
        else {
            let currentMap = rootDirs;
            let currentDirNode = null;
            for (const seg of parts) {
                currentDirNode = getOrCreateDirNode(currentMap, seg);
                currentMap = currentDirNode.subDirs;
            }
            currentDirNode.files.push({
                token: entry.token,
                description: fileName
            });
        }
    }
    function serializeDir(node) {
        const subDirs = Array.from(node.subDirs.values()).map(serializeDir);
        return {
            name: node.name,
            directories: subDirs,
            files: node.files
        };
    }
    const directories = Array.from(rootDirs.values()).map(serializeDir);
    return {
        files: rootFiles,
        directories
    };
}
