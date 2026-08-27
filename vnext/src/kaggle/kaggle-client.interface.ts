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
}
