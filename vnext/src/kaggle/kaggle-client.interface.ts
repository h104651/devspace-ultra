import { KaggleExecutionStatus, KaggleTaskPayload } from '../types/kaggle';
import { KaggleProjectSummary, KaggleOutputFile } from './project-manager';

export interface KagglePushResult {
  success: boolean;
  kernelUrl: string;
  kernelSlug?: string;
  versionNumber?: number;
  error?: string;
}

export interface KaggleStatusResult {
  status: KaggleExecutionStatus;
  rawMessage?: string;
}

export interface KaggleOutputResult {
  success: boolean;
  files: Array<{ name: string; content?: Buffer | string; sizeBytes?: number; r2Key?: string }>;
  log?: string;
  error?: string;
}

export interface KaggleDatasetMetadata {
  id?: number;
  ref: string;
  title?: string;
  currentVersionNumber: number;
  totalBytes?: number;
  isPrivate?: boolean;
  licenseName?: string;
  description?: string;
}

export interface KaggleDatasetFileEntry {
  name: string;
  totalBytes: number;
}

export interface IKaggleClient {
  hasCredentials(): boolean;
  getUsername(): string;
  setMockMode?(mock: boolean): void;
  pushKernel(payload: KaggleTaskPayload, workDirOrCode?: string): Promise<KagglePushResult>;
  getKernelStatus(kernelSlug: string): Promise<KaggleStatusResult>;
  downloadKernelOutput(kernelSlug: string, targetDirOrR2Bucket?: any): Promise<KaggleOutputResult>;
  listProjects?(params: { search?: string; mine?: boolean; user?: string; kernelType?: string; language?: string; sortBy?: string; pageSize?: number; pageToken?: string }): Promise<KaggleProjectSummary[]>;
  pullProject?(owner: string, slug: string, version?: number): Promise<{ metadata: any; source: string }>;
  getProjectOutputFiles?(owner: string, slug: string): Promise<{ files: KaggleOutputFile[]; log?: string }>;
  getProjectLogs?(owner: string, slug: string): Promise<{ logs: string[]; available: boolean }>;
  downloadSingleOutputFile?(owner: string, slug: string, fileName?: string): Promise<{ file?: { name: string; content?: string | Buffer; sizeBytes?: number; url?: string }; totalFiles: number; allFileNames: string[]; log?: string; error?: string }>;

  // Dataset Control Plane methods
  getDataset?(owner: string, slug: string): Promise<KaggleDatasetMetadata>;
  listDatasetFiles?(owner: string, slug: string, version?: number, pageSize?: number, pageToken?: string): Promise<{ datasetFiles: KaggleDatasetFileEntry[]; nextPageToken?: string }>;
  downloadDatasetFile?(owner: string, slug: string, fileName: string, version?: number): Promise<{ content: Buffer; sizeBytes: number }>;
  uploadBlob?(fileName: string, content: Buffer | string): Promise<string>;
  createDataset?(slug: string, title: string, files: Array<{ token: string; description?: string }>, directories?: any[], isPrivate?: boolean): Promise<{ success: boolean; url?: string; ref?: string; error?: string }>;
  createDatasetVersion?(slug: string, versionNotes: string, files: Array<{ token: string; description?: string }>, directories?: any[]): Promise<{ success: boolean; url?: string; ref?: string; error?: string }>;
  getDatasetStatus?(slug: string, owner?: string): Promise<{ status: string; isReady: boolean }>;
}
