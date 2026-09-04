import * as crypto from 'crypto';

export interface KaggleProjectSummary {
  ref: string;
  slug: string;
  owner: string;
  title: string;
  kernelType: string;
  language: string;
  lastRunTime?: string;
  status?: string;
  isPrivate?: boolean;
}

export interface KaggleProjectMetadata {
  kernelRef: string;
  title: string;
  owner: string;
  slug: string;
  kernelType: string;
  language: string;
  isPrivate: boolean;
  enableGpu: boolean;
  enableInternet: boolean;
  machineShape?: string;
  datasetSources: string[];
  competitionSources: string[];
  kernelSources: string[];
  modelSources: string[];
  latestStatus?: string;
  codeFile?: string;
  sourceSize: number;
  sourceSha256: string;
  metadataSha256: string;
  projectFingerprint: string;
}

export interface KaggleNotebookCellSummary {
  index: number;
  cellType: 'code' | 'markdown' | 'raw';
  sourceLength: number;
  sourceSha256: string;
  source?: string;
  sourceTruncated?: boolean;
}

export interface KaggleProjectSourceResult {
  kernelRef: string;
  requestedVersion?: number;
  kernelType: string;
  sourceFormat: 'ipynb' | 'script';
  sourceSha256: string;
  projectFingerprint: string;
  totalLength: number;
  offset: number;
  content: string;
  nextOffset?: number;
  totalCells?: number;
  cellOffset?: number;
  cellLimit?: number;
  nextCellOffset?: number;
  cells?: KaggleNotebookCellSummary[];
}

export interface KaggleOutputFile {
  name: string;
  size: number;
  creationTime?: string;
  url?: string;
}

export interface KaggleProjectFilesResult {
  kernelRef: string;
  files: KaggleOutputFile[];
  nextPageToken?: string;
}

export interface KaggleProjectOutputResult {
  kernelRef: string;
  fileName?: string;
  content?: string;
  sizeBytes: number;
  sha256?: string;
  artifactId?: string;
  downloadUrl?: string;
  isTruncated?: boolean;
  totalFiles?: number;
  allFileNames?: string[];
  message?: string;
}

export interface KaggleProjectLogsResult {
  kernelRef: string;
  logs: string[];
  available: boolean;
  message?: string;
}

export interface KaggleProjectContinueInput {
  kernelRef: string;
  expectedProjectFingerprint: string;
  mutation: {
    type: 'append_notebook_cells' | 'append_script' | 'replace_source';
    cells?: Array<{ cellType?: 'code' | 'markdown'; source: string }>;
    code?: string;
    source?: string;
  };
  clientRequestId?: string;
}

export interface KaggleProjectContinueResult {
  taskId: string;
  kernelRef: string;
  submittedVersionNumber?: number;
  status: string;
  previousProjectFingerprint: string;
  submittedSourceSha256: string;
  isReplay?: boolean;
  message?: string;
}

/**
 * Computes deterministic SHA-256 fingerprint over canonical source + metadata.
 */
export function computeProjectFingerprint(params: {
  sourceSha256: string;
  kernelType: string;
  language: string;
  isPrivate: boolean;
  enableGpu: boolean;
  enableInternet: boolean;
  machineShape?: string;
  datasetSources?: string[];
  competitionSources?: string[];
  kernelSources?: string[];
  modelSources?: string[];
}): string {
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
export function parseNotebookCells(
  rawSource: string,
  options: {
    includeCells?: boolean;
    cellOffset?: number;
    cellLimit?: number;
    includeCellSource?: boolean;
    maxCellSourceChars?: number;
  } = {}
): { totalCells: number; cells?: KaggleNotebookCellSummary[]; nextCellOffset?: number } | undefined {
  try {
    const nb = JSON.parse(rawSource);
    if (!nb || !Array.isArray(nb.cells)) return undefined;

    const totalCells = nb.cells.length;
    if (!options.includeCells) {
      return { totalCells };
    }

    const cellOffset = Math.max(0, Number(options.cellOffset) || 0);
    const cellLimit = Math.min(Math.max(1, Number(options.cellLimit) || 20), 100);
    const maxChars = Math.min(Math.max(1, Number(options.maxCellSourceChars) || 20000), 50000);
    const selectedCells = nb.cells.slice(cellOffset, cellOffset + cellLimit);

    const cellSummaries: KaggleNotebookCellSummary[] = selectedCells.map((c: any, relIndex: number) => {
      const absIndex = cellOffset + relIndex;
      const fullSource = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
      const sourceLength = fullSource.length;
      const sourceSha256 = crypto.createHash('sha256').update(fullSource).digest('hex');

      const item: KaggleNotebookCellSummary = {
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
  } catch {
    return undefined;
  }
}

/**
 * Appends new cells to an existing Jupyter notebook JSON string while preserving metadata and existing cells.
 */
export function appendCellsToNotebook(
  existingSource: string,
  newCells: Array<{ cellType?: 'code' | 'markdown'; source: string }>
): string {
  let nb: any;
  try {
    nb = JSON.parse(existingSource);
  } catch {
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
    } else {
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
export function parseKernelRef(kernelRef: string, defaultOwner: string): { owner: string; slug: string; ref: string } {
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

export interface NotebookValidationResult {
  valid: boolean;
  nbformat?: number;
  nbformatMinor?: number;
  cellsCount?: number;
  error?: string;
}

/**
 * Validates that a string is a well-formed Jupyter Notebook document with valid integer nbformat >= 4 and a cells array.
 */
export function validateNotebookDocument(source: string): NotebookValidationResult {
  if (!source || typeof source !== 'string' || source.trim().length === 0) {
    return { valid: false, error: 'Notebook source is empty' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(source);
  } catch (err: any) {
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
