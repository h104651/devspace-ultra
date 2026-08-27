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
exports.computeProjectFingerprint = computeProjectFingerprint;
exports.parseNotebookCells = parseNotebookCells;
exports.appendCellsToNotebook = appendCellsToNotebook;
exports.parseKernelRef = parseKernelRef;
const crypto = __importStar(require("crypto"));
/**
 * Computes deterministic SHA-256 fingerprint over canonical source + metadata.
 */
function computeProjectFingerprint(params) {
    const canonical = {
        sourceSha256: params.sourceSha256,
        kernelType: (params.kernelType || 'script').toLowerCase(),
        language: (params.language || 'python').toLowerCase(),
        isPrivate: !!params.isPrivate,
        enableGpu: !!params.enableGpu,
        enableInternet: params.enableInternet !== false,
        machineShape: params.machineShape || '',
        datasetSources: [...(params.datasetSources || [])].sort(),
        competitionSources: [...(params.competitionSources || [])].sort(),
        kernelSources: [...(params.kernelSources || [])].sort(),
        modelSources: [...(params.modelSources || [])].sort()
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
/**
 * Parses notebook cells from raw JSON string if valid .ipynb format.
 */
function parseNotebookCells(rawSource) {
    try {
        const nb = JSON.parse(rawSource);
        if (!nb || !Array.isArray(nb.cells))
            return undefined;
        return nb.cells.map((c, index) => ({
            index,
            cellType: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code',
            source: Array.isArray(c.source) ? c.source.join('') : String(c.source || '')
        }));
    }
    catch {
        return undefined;
    }
}
/**
 * Appends new cells to an existing Jupyter notebook JSON string while preserving metadata and existing cells.
 */
function appendCellsToNotebook(existingSource, newCells) {
    let nb;
    try {
        nb = JSON.parse(existingSource);
    }
    catch {
        nb = {
            cells: [],
            metadata: {
                language_info: { name: 'python' },
                kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
            },
            nbformat: 4,
            nbformat_minor: 5
        };
    }
    if (!Array.isArray(nb.cells)) {
        nb.cells = [];
    }
    for (const item of newCells) {
        const isMarkdown = item.cellType === 'markdown';
        const cellSource = item.source.endsWith('\n') ? item.source : item.source + '\n';
        if (isMarkdown) {
            nb.cells.push({
                cell_type: 'markdown',
                metadata: {},
                source: [cellSource]
            });
        }
        else {
            nb.cells.push({
                cell_type: 'code',
                execution_count: null,
                metadata: {},
                outputs: [],
                source: [cellSource]
            });
        }
    }
    return JSON.stringify(nb, null, 1);
}
/**
 * Parses kernelRef into owner and slug.
 */
function parseKernelRef(kernelRef, defaultOwner) {
    const trimmed = (kernelRef || '').trim();
    if (trimmed.includes('/')) {
        const parts = trimmed.split('/');
        return {
            owner: parts[0],
            slug: parts.slice(1).join('/'),
            ref: `${parts[0]}/${parts.slice(1).join('/')}`
        };
    }
    return {
        owner: defaultOwner,
        slug: trimmed,
        ref: `${defaultOwner}/${trimmed}`
    };
}
