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
exports.validateNotebookDocument = validateNotebookDocument;
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
 * Parses notebook cells from raw JSON string with pagination and safe source capping.
 */
function parseNotebookCells(rawSource, options = {}) {
    try {
        const nb = JSON.parse(rawSource);
        if (!nb || !Array.isArray(nb.cells))
            return undefined;
        const totalCells = nb.cells.length;
        if (!options.includeCells) {
            return { totalCells };
        }
        const cellOffset = Math.max(0, Number(options.cellOffset) || 0);
        const cellLimit = Math.min(Math.max(1, Number(options.cellLimit) || 20), 100);
        const maxChars = Math.min(Math.max(1, Number(options.maxCellSourceChars) || 20000), 50000);
        const selectedCells = nb.cells.slice(cellOffset, cellOffset + cellLimit);
        const cellSummaries = selectedCells.map((c, relIndex) => {
            const absIndex = cellOffset + relIndex;
            const fullSource = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
            const sourceLength = fullSource.length;
            const sourceSha256 = crypto.createHash('sha256').update(fullSource).digest('hex');
            const item = {
                index: absIndex,
                cellType: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code',
                sourceLength,
                sourceSha256
            };
            if (options.includeCellSource) {
                const isTruncated = fullSource.length > maxChars;
                item.source = isTruncated ? fullSource.substring(0, maxChars) : fullSource;
                item.sourceTruncated = isTruncated;
            }
            return item;
        });
        const nextCellOffset = (cellOffset + cellLimit < totalCells) ? (cellOffset + cellLimit) : undefined;
        return {
            totalCells,
            cells: cellSummaries,
            nextCellOffset
        };
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
/**
 * Validates that a string is a well-formed Jupyter Notebook document with valid integer nbformat >= 4 and a cells array.
 */
function validateNotebookDocument(source) {
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
        return { valid: false, error: 'Notebook source is empty' };
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (err) {
        return { valid: false, error: `Invalid JSON syntax: ${err.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false, error: 'Root document must be a JSON object' };
    }
    if (parsed.nbformat === undefined || parsed.nbformat === null) {
        return { valid: false, error: 'Missing required field: nbformat' };
    }
    if (typeof parsed.nbformat !== 'number' || !Number.isInteger(parsed.nbformat)) {
        return { valid: false, error: `nbformat must be an integer (received ${typeof parsed.nbformat}: ${parsed.nbformat})` };
    }
    if (parsed.nbformat < 4) {
        return { valid: false, error: `Unsupported nbformat version ${parsed.nbformat} (minimum supported is 4)` };
    }
    if (!Array.isArray(parsed.cells)) {
        return { valid: false, error: 'Missing or invalid cells array' };
    }
    for (let i = 0; i < parsed.cells.length; i++) {
        const cell = parsed.cells[i];
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
            return { valid: false, error: `Cell at index ${i} is not a valid object` };
        }
        if (typeof cell.cell_type !== 'string' || !['code', 'markdown', 'raw'].includes(cell.cell_type)) {
            return { valid: false, error: `Cell at index ${i} has invalid cell_type '${cell.cell_type}'` };
        }
    }
    return {
        valid: true,
        nbformat: parsed.nbformat,
        nbformatMinor: parsed.nbformat_minor,
        cellsCount: parsed.cells.length
    };
}
