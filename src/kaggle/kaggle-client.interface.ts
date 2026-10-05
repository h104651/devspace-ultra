import { KaggleExecutionStatus, KaggleTaskPayload, KaggleTaskResult } from '../types/kaggle';

export interface KagglePushResult {
  success: boolean;
  kernelUrl: string;
  error?: string;
}

export interface KaggleStatusResult {
  status: KaggleExecutionStatus;
  rawMessage?: string;
}

export interface KaggleOutputResult {
  success: boolean;
  files: Array<{ name: string; content?: Buffer | string; sizeBytes?: number; r2Key?: string }>;
  error?: string;
}

export interface IKaggleClient {
  hasCredentials(): boolean;
  getUsername(): string;
  pushKernel(payload: KaggleTaskPayload, workDirOrCode?: string): Promise<KagglePushResult>;
  getKernelStatus(kernelSlug: string): Promise<KaggleStatusResult>;
  downloadKernelOutput(kernelSlug: string, targetDirOrR2Bucket?: any): Promise<KaggleOutputResult>;
}
