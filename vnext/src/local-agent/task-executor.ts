import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { DurableTask } from '../types/task';

export interface TaskExecutorConfig {
  allowedWorkspaces: string[];
  allowRawShell?: boolean;
}

export class TaskExecutor {
  private config: TaskExecutorConfig;

  constructor(config: TaskExecutorConfig) {
    this.config = {
      allowedWorkspaces: config.allowedWorkspaces.map(w => path.resolve(w)),
      allowRawShell: !!config.allowRawShell
    };
  }

  private validateWorkspace(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const resolvedNorm = resolved.toLowerCase();

    const isAllowed = this.config.allowedWorkspaces.some(w => {
      const wNorm = w.toLowerCase();
      return resolvedNorm === wNorm || resolvedNorm.startsWith(wNorm + path.sep) || resolvedNorm.startsWith(wNorm + '/');
    });

    if (!isAllowed) {
      throw new Error(`WORKSPACE_ACCESS_DENIED: Path '${targetPath}' is outside authorized workspaces`);
    }
    return resolved;
  }

  public async executeTask(
    task: DurableTask,
    onLog: (line: string) => void
  ): Promise<any> {
    onLog(`[EXECUTOR] Starting capability: ${task.capability}`);

    switch (task.capability) {
      case 'local:git_status': {
        const repoPath = this.validateWorkspace(task.payload.workspace || process.cwd());
        return this.runGitStatus(repoPath);
      }

      case 'local:read_file': {
        const filePath = this.validateWorkspace(task.payload.filePath);
        if (!fs.existsSync(filePath)) {
          throw new Error(`FILE_NOT_FOUND: ${filePath}`);
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
          filePath,
          sizeBytes: Buffer.byteLength(content),
          content: task.payload.limit ? content.substring(0, task.payload.limit) : content
        };
      }

      case 'local:write_file':
      case 'local:patch_file': {
        const filePath = this.validateWorkspace(task.payload.filePath);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, task.payload.content, 'utf-8');
        onLog(`[EXECUTOR] Successfully wrote ${Buffer.byteLength(task.payload.content)} bytes to ${filePath}`);
        return { filePath, status: 'written', sizeBytes: Buffer.byteLength(task.payload.content) };
      }

      case 'local:run_tests': {
        const workspace = this.validateWorkspace(task.payload.workspace || process.cwd());
        const runner = task.payload.runner || 'npm';
        let cmd = 'npm test';
        if (runner === 'pytest') cmd = 'pytest';
        if (runner === 'flutter') cmd = 'flutter test';
        if (task.payload.customCommand) {
          cmd = task.payload.customCommand;
        }

        onLog(`[EXECUTOR] Running tests via command: ${cmd}`);
        return this.runCommandAsync(cmd, workspace, onLog);
      }

      case 'local:build_project': {
        const workspace = this.validateWorkspace(task.payload.workspace || process.cwd());
        const cmd = task.payload.command || 'npm run build';
        onLog(`[EXECUTOR] Building project via: ${cmd}`);
        return this.runCommandAsync(cmd, workspace, onLog);
      }

      case 'local:raw_shell': {
        if (!this.config.allowRawShell) {
          throw new Error('RAW_SHELL_DENIED: Raw shell execution is disabled on this agent');
        }
        const workspace = this.validateWorkspace(task.payload.workspace || process.cwd());
        const cmd = task.payload.command;
        if (!cmd) {
          throw new Error('MISSING_COMMAND: No command provided for raw shell');
        }
        onLog(`[AUDIT_SHELL] Executing raw command: ${cmd}`);
        return this.runCommandAsync(cmd, workspace, onLog);
      }

      default:
        throw new Error(`UNSUPPORTED_CAPABILITY: Agent cannot execute '${task.capability}'`);
    }
  }

  private runGitStatus(repoPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      exec('git status --porcelain', { cwd: repoPath }, (err, stdout) => {
        if (err) return reject(err);

        exec('git branch --show-current', { cwd: repoPath }, (errBranch, branchOut) => {
          const branch = (branchOut || 'HEAD').trim();

          exec('git rev-parse HEAD', { cwd: repoPath }, (_errCommit, commitOut) => {
            const headCommit = (commitOut || '').trim();
            const isClean = stdout.trim().length === 0;

            resolve({
              branch: branch || 'main',
              headCommit,
              isClean,
              changes: stdout.trim().split('\n').filter(Boolean)
            });
          });
        });
      });
    });
  }

  private runCommandAsync(command: string, cwd: string, onLog: (line: string) => void): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 });
      let stdoutAcc = '';

      child.stdout?.on('data', (data) => {
        const text = data.toString();
        stdoutAcc += text;
        onLog(text.trim());
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString();
        stdoutAcc += text;
        onLog(`[STDERR] ${text.trim()}`);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdoutAcc, exitCode: 0 });
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stdoutAcc.slice(-500)}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }
}
