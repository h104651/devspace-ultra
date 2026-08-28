import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { DurableTask } from '../types/task';
import {
  ProjectRegistry,
  ProjectPathSecurity,
  LocalProjectDefinition
} from './project-registry';

export interface TaskExecutorConfig {
  allowedWorkspaces?: string[];
  projects?: (LocalProjectDefinition | string)[];
  projectRegistry?: ProjectRegistry;
  projectsConfigFile?: string;
  allowRawShell?: boolean;
}

export class TaskExecutor {
  private projectRegistry: ProjectRegistry;
  private allowRawShell: boolean;

  constructor(config: TaskExecutorConfig) {
    this.allowRawShell = !!config.allowRawShell;
    if (config.projectRegistry) {
      this.projectRegistry = config.projectRegistry;
    } else {
      this.projectRegistry = new ProjectRegistry({
        configFilePath: config.projectsConfigFile,
        initialProjects: config.projects || config.allowedWorkspaces
      });
    }
  }

  public getRegistry(): ProjectRegistry {
    return this.projectRegistry;
  }

  private resolveProjectForTask(payload: any): {
    project: ReturnType<ProjectRegistry['getProject']>;
    relativePath?: string;
    isLegacy: boolean;
  } {
    if (payload.projectId) {
      const project = this.projectRegistry.getProject(payload.projectId);
      return { project, relativePath: payload.relativePath, isLegacy: false };
    }

    // Deprecated legacy compatibility fallback: resolve absolute workspace or filePath
    const legacyPath = payload.workspace || payload.filePath;
    if (!legacyPath) {
      const err: any = new Error('MISSING_PROJECT_ID: Target projectId is required for local task routing');
      err.code = 'MISSING_PROJECT_ID';
      throw err;
    }

    const match = this.projectRegistry.resolveLegacyPath(legacyPath);
    if (!match) {
      const err: any = new Error(`WORKSPACE_ACCESS_DENIED: Path '${legacyPath}' is outside authorized registered project workspaces`);
      err.code = 'WORKSPACE_ACCESS_DENIED';
      throw err;
    }

    return { project: match.project, relativePath: match.relativePath, isLegacy: true };
  }

  public async executeTask(
    task: DurableTask,
    onLog: (line: string) => void
  ): Promise<any> {
    onLog(`[EXECUTOR] Starting capability: ${task.capability}`);

    switch (task.capability) {
      case 'local:list_projects': {
        const projects = this.projectRegistry.listProjects();
        return {
          count: projects.length,
          projects
        };
      }

      case 'local:project_status': {
        const { project } = this.resolveProjectForTask(task.payload);
        const gitDetected = fs.existsSync(path.join(project.canonicalRoot, '.git'));
        let gitInfo: any;
        if (gitDetected && project.permissions.read) {
          try {
            gitInfo = await this.runGitStatus(project.canonicalRoot);
          } catch (e: any) {
            onLog(`[EXECUTOR] Git status warning: ${e.message}`);
          }
        }

        return {
          projectId: project.projectId,
          displayName: project.displayName,
          exists: fs.existsSync(project.canonicalRoot),
          gitDetected,
          branch: gitInfo?.branch,
          headCommit: gitInfo?.headCommit,
          isClean: gitInfo?.isClean,
          permissions: { ...project.permissions }
        };
      }

      case 'local:git_status': {
        const { project } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.read) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        const gitResult = await this.runGitStatus(project.canonicalRoot);
        return {
          projectId: project.projectId,
          ...gitResult
        };
      }

      case 'local:read_file': {
        const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.read) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Read permission is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
        const targetPath = ProjectPathSecurity.resolveReadPath(project.canonicalRoot, effectiveRelPath);
        const content = fs.readFileSync(targetPath, 'utf-8');

        return {
          projectId: project.projectId,
          relativePath: effectiveRelPath,
          sizeBytes: Buffer.byteLength(content),
          content: task.payload.limit ? content.substring(0, task.payload.limit) : content
        };
      }

      case 'local:write_file':
      case 'local:patch_file': {
        const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.write) {
          const err: any = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
          throw err;
        }

        const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
        const targetPath = ProjectPathSecurity.resolveWritePath(project.canonicalRoot, effectiveRelPath);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const content = typeof task.payload.content === 'string' ? task.payload.content : '';
        fs.writeFileSync(targetPath, content, 'utf-8');
        onLog(`[EXECUTOR] Successfully wrote ${Buffer.byteLength(content)} bytes to ${effectiveRelPath}`);

        return {
          projectId: project.projectId,
          relativePath: effectiveRelPath,
          status: 'written',
          sizeBytes: Buffer.byteLength(content)
        };
      }

      case 'local:run_tests': {
        const { project } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.test) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Test execution is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        const runner = task.payload.runner || 'npm';
        let cmd = 'npm test';
        if (runner === 'pytest') cmd = 'pytest';
        if (runner === 'flutter') cmd = 'flutter test';
        if (task.payload.customCommand) {
          cmd = task.payload.customCommand;
        }

        onLog(`[EXECUTOR] Running tests in project '${project.projectId}' via command: ${cmd}`);
        return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
      }

      case 'local:build_project': {
        const { project } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.build) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Build execution is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        const cmd = task.payload.command || 'npm run build';
        onLog(`[EXECUTOR] Building project '${project.projectId}' via: ${cmd}`);
        return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
      }

      case 'local:raw_shell': {
        if (!this.allowRawShell) {
          const err: any = new Error('RAW_SHELL_DENIED: Raw shell execution is disabled on this agent');
          err.code = 'RAW_SHELL_DENIED';
          throw err;
        }
        const { project } = this.resolveProjectForTask(task.payload);
        const cmd = task.payload.command;
        if (!cmd) {
          const err: any = new Error('MISSING_COMMAND: No command provided for raw shell');
          err.code = 'MISSING_COMMAND';
          throw err;
        }
        onLog(`[AUDIT_SHELL] Executing raw command in '${project.projectId}': ${cmd}`);
        return this.runCommandAsync(cmd, project.canonicalRoot, onLog);
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
