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

export interface KaggleNotebookCell {
  index: number;
  cellType: 'code' | 'markdown' | 'raw';
  source: string;
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
  cells?: KaggleNotebookCell[];
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
  artifactId?: string;
  downloadUrl?: string;
  isTruncated?: boolean;
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
 * Parses notebook cells from raw JSON string if valid .ipynb format.
 */
export function parseNotebookCells(rawSource: string): KaggleNotebookCell[] | undefined {
  try {
    const nb = JSON.parse(rawSource);
    if (!nb || !Array.isArray(nb.cells)) return undefined;
    return nb.cells.map((c: any, index: number) => ({
      index,
      cellType: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code',
      source: Array.isArray(c.source) ? c.source.join('') : String(c.source || '')
    }));
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
