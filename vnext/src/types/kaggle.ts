export type KaggleAccelerator = 'none' | 'gpu' | 'tpu';

export interface KaggleTaskPayload {
  kernelSlug: string; // e.g. "my-training-run-001"
  title?: string;
  code: string; // Python code or Jupyter notebook json
  language?: 'python' | 'r';
  kernelType?: 'script' | 'notebook';
  isPrivate?: boolean;
  enableGpu?: boolean;
  enableInternet?: boolean;
  datasetDataSources?: string[];
  competitionDataSources?: string[];
  kernelDataSources?: string[];
  modelDataSources?: string[];
  machineShape?: string;
  timeoutSeconds?: number;
  environmentVariables?: Record<string, string>;
}

export type KaggleExecutionStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'error'
  | 'cancelAcknowledged'
  | 'cancelled'
  | 'quotaExceeded'
  | 'unknown';

export interface KaggleTaskResult {
  kernelSlug: string;
  status: KaggleExecutionStatus;
  kernelUrl?: string;
  executionDurationMs?: number;
  stdout?: string;
  stderr?: string;
  outputArtifacts?: string[];
  outputFiles?: any[];
  metrics?: Record<string, any>;
  rawResponse?: any;
}
