"use strict";
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
exports.PathSanitizer = void 0;
const path = __importStar(require("path"));
class PathSanitizer {
    /**
     * Validates and resolves a relative path against an allowed root directory.
     * Throws if path traversal (e.g. ../) tries to escape root.
     */
    static resolveSafePath(rootDir, relativePath) {
        if (!rootDir) {
            throw new Error('PATH_ERROR: Root directory must be provided');
        }
        if (!relativePath || relativePath.includes('\0')) {
            throw new Error('PATH_ERROR: Invalid relative path');
        }
        const normalizedRoot = path.resolve(rootDir);
        const resolvedPath = path.resolve(normalizedRoot, relativePath);
        if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
            throw new Error(`PATH_TRAVERSAL_DENIED: Attempted access outside root directory`);
        }
        return resolvedPath;
    }
    /**
     * Sanitizes artifact filenames to prevent malicious characters and directory escapes.
     */
    static sanitizeArtifactFilename(name) {
        if (!name)
            return 'unnamed_artifact';
        const base = path.basename(name);
        return base.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    }
}
exports.PathSanitizer = PathSanitizer;
