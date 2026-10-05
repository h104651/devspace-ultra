import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { KaggleExecutionStatus, KaggleTaskPayload, KaggleTaskResult } from '../types/kaggle';
import { NotebookBuilder } from './notebook-builder';

export interface KaggleCredentials {
  username: string;
  key: string;
}

export class KaggleClient {
  private credentials?: KaggleCredentials;
  private isMockMode: boolean;

  constructor(credentials?: KaggleCredentials, isMockMode = false) {
    this.credentials = credentials || this.detectCredentials();
    this.isMockMode = isMockMode || !this.credentials;
  }

  private detectCredentials(): KaggleCredentials | undefined {
    if (process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY) {
      return {
        username: process.env.KAGGLE_USERNAME,
        key: process.env.KAGGLE_KEY
      };
    }

    const homeKaggle = path.join(os.homedir(), '.kaggle', 'kaggle.json');
    if (fs.existsSync(homeKaggle)) {
      try {
        const data = JSON.parse(fs.readFileSync(homeKaggle, 'utf-8'));
        if (data.username && data.key) {
          return { username: data.username, key: data.key };
        }
      } catch {}
    }

    return undefined;
  }

  public hasCredentials(): boolean {
    return !!this.credentials;
  }

  public getUsername(): string {
    return this.credentials?.username || 'kaggle_user';
  }

  public setMockMode(mock: boolean): void {
    this.isMockMode = mock;
  }

  /**
   * Pushes a new kernel to Kaggle.
   */
  public async pushKernel(
    workDir: string,
    payload: KaggleTaskPayload
  ): Promise<{ success: boolean; kernelUrl: string; error?: string }> {
    if (this.isMockMode) {
      return {
        success: true,
        kernelUrl: `https://www.kaggle.com/code/${this.getUsername()}/${payload.kernelSlug}`
      };
    }

    const username = this.getUsername();
    const metadata = NotebookBuilder.buildMetadata(username, payload);

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    fs.writeFileSync(path.join(workDir, 'kernel-metadata.json'), JSON.stringify(metadata, null, 2));

    const codeFileName = metadata.code_file;
    if (metadata.kernel_type === 'notebook' && !payload.code.trim().startsWith('{')) {
      const ipynb = NotebookBuilder.codeToIpynb(payload.code);
      fs.writeFileSync(path.join(workDir, codeFileName), ipynb);
    } else {
      fs.writeFileSync(path.join(workDir, codeFileName), payload.code);
    }

    return new Promise((resolve) => {
      const env = {
        ...process.env,
        KAGGLE_USERNAME: this.credentials?.username,
        KAGGLE_KEY: this.credentials?.key
      };

      exec(`kaggle kernels push -p "${workDir}"`, { env }, (error, stdout, stderr) => {
        const out = `${stdout} ${stderr}`;
        if (error || out.toLowerCase().includes('error') || out.toLowerCase().includes('403') || out.toLowerCase().includes('401')) {
          if (out.includes('quota') || out.includes('GPU limit') || out.includes('exceeded')) {
            resolve({ success: false, kernelUrl: '', error: 'RESOURCE_QUOTA_EXCEEDED: Kaggle GPU quota limit reached' });
          } else if (out.includes('401') || out.includes('Unauthorized') || out.includes('credentials')) {
            resolve({ success: false, kernelUrl: '', error: 'KAGGLE_AUTH_FAILED: Invalid Kaggle API credentials' });
          } else {
            resolve({ success: false, kernelUrl: '', error: `KAGGLE_PUSH_FAILED: ${out.trim() || error?.message}` });
          }
        } else {
          resolve({
            success: true,
            kernelUrl: `https://www.kaggle.com/code/${username}/${payload.kernelSlug}`
          });
        }
      });
    });
  }

  /**
   * Checks current execution status of a kernel.
   */
  public async getKernelStatus(kernelSlug: string): Promise<{ status: KaggleExecutionStatus; rawMessage?: string }> {
    if (this.isMockMode) {
      return { status: 'complete', rawMessage: 'Mock execution finished successfully' };
    }

    const username = this.getUsername();
    const fullSlug = `${username}/${kernelSlug}`;

    return new Promise((resolve) => {
      const env = {
        ...process.env,
        KAGGLE_USERNAME: this.credentials?.username,
        KAGGLE_KEY: this.credentials?.key
      };

      exec(`kaggle kernels status ${fullSlug}`, { env }, (error, stdout, stderr) => {
        const out = `${stdout} ${stderr}`.trim();
        const lower = out.toLowerCase();

        if (lower.includes('running')) {
          resolve({ status: 'running', rawMessage: out });
        } else if (lower.includes('queued')) {
          resolve({ status: 'queued', rawMessage: out });
        } else if (lower.includes('complete') || lower.includes('finished')) {
          resolve({ status: 'complete', rawMessage: out });
        } else if (lower.includes('error') || lower.includes('failed')) {
          resolve({ status: 'error', rawMessage: out });
        } else if (lower.includes('quota') || lower.includes('limit')) {
          resolve({ status: 'quotaExceeded', rawMessage: out });
        } else if (lower.includes('cancel')) {
          resolve({ status: 'cancelled', rawMessage: out });
        } else {
          resolve({ status: 'unknown', rawMessage: out });
        }
      });
    });
  }

  /**
   * Fetches kernel outputs and log files into a local output directory.
   */
  public async downloadKernelOutput(
    kernelSlug: string,
    outputDir: string
  ): Promise<{ success: boolean; files: string[]; error?: string }> {
    if (this.isMockMode) {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(path.join(outputDir, 'stdout.log'), 'Mock Kaggle output stdout: Execution success\nEpoch 1/1 - loss: 0.042');
      fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ metrics: { accuracy: 0.985, val_loss: 0.042 } }, null, 2));
      return {
        success: true,
        files: [path.join(outputDir, 'stdout.log'), path.join(outputDir, 'result.json')]
      };
    }

    const username = this.getUsername();
    const fullSlug = `${username}/${kernelSlug}`;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve) => {
      const env = {
        ...process.env,
        KAGGLE_USERNAME: this.credentials?.username,
        KAGGLE_KEY: this.credentials?.key
      };

      exec(`kaggle kernels output ${fullSlug} -p "${outputDir}"`, { env }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, files: [], error: `KAGGLE_OUTPUT_ERROR: ${stderr || error.message}` });
        } else {
          try {
            const files = fs.readdirSync(outputDir).map(f => path.join(outputDir, f));
            resolve({ success: true, files });
          } catch (e: any) {
            resolve({ success: false, files: [], error: e.message });
          }
        }
      });
    });
  }
}
