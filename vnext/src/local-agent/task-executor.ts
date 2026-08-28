import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { DurableTask } from '../types/task';
import {
  ProjectRegistry,
  ProjectPathSecurity,
  LocalProjectDefinition,
  ConfiguredCommand
} from './project-registry';

export interface TaskExecutorConfig {
  allowedWorkspaces?: string[];
  projects?: LocalProjectDefinition[];
  projectRegistry?: ProjectRegistry;
  projectsConfigFile?: string;
  allowRawShell?: boolean;
}

export interface StructuredPatch {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        initialProjects: config.projects,
        initialLegacyWorkspaces: config.allowedWorkspaces
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
    if (payload?.projectId) {
      const project = this.projectRegistry.getProject(payload.projectId);
      return { project, relativePath: payload.relativePath, isLegacy: false };
    }

    // Deprecated legacy compatibility fallback: resolve absolute workspace or filePath
    const legacyPath = payload?.workspace || payload?.filePath;
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
          permissions: { ...project.permissions },
          configuredTestRunners: project.commands?.test ? Object.keys(project.commands.test) : undefined,
          configuredBuildCommands: project.commands?.build ? Object.keys(project.commands.build) : undefined
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

      case 'local:write_file': {
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
        const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, targetPath);

        onLog(`[EXECUTOR] Successfully wrote ${Buffer.byteLength(content)} bytes to ${effectiveRelPath}`);

        return {
          projectId: project.projectId,
          relativePath: effectiveRelPath,
          status: 'written',
          sizeBytes: Buffer.byteLength(content)
        };
      }

      case 'local:patch_file': {
        const { project, relativePath, isLegacy } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.write) {
          const err: any = new Error(`LOCAL_PROJECT_WRITE_FORBIDDEN: Write permission is forbidden on read-only project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_WRITE_FORBIDDEN';
          throw err;
        }

        const effectiveRelPath = relativePath || (isLegacy ? '' : task.payload.relativePath);
        if (!effectiveRelPath) {
          const err: any = new Error('LOCAL_PROJECT_PATH_ESCAPE: relativePath is required for patch_file');
          err.code = 'LOCAL_PROJECT_PATH_ESCAPE';
          throw err;
        }

        const expectedSha256 = task.payload.expectedSha256;
        if (!expectedSha256 || typeof expectedSha256 !== 'string') {
          const err: any = new Error('LOCAL_PATCH_INVALID: expectedSha256 is required for deterministic patch execution');
          err.code = 'LOCAL_PATCH_INVALID';
          throw err;
        }

        const rawPatches: StructuredPatch[] = Array.isArray(task.payload.patches)
          ? task.payload.patches
          : (task.payload.patch ? [task.payload.patch] : []);

        if (rawPatches.length === 0) {
          const err: any = new Error('LOCAL_PATCH_INVALID: patches array must contain at least one patch block');
          err.code = 'LOCAL_PATCH_INVALID';
          throw err;
        }

        // 1. Resolve read path and verify realpath/symlink boundaries
        const targetPath = ProjectPathSecurity.resolveReadPath(project.canonicalRoot, effectiveRelPath);
        const currentContent = fs.readFileSync(targetPath, 'utf-8');

        // 2. Compute current SHA256 and verify expectedSha256
        const currentSha256 = crypto.createHash('sha256').update(currentContent, 'utf-8').digest('hex');
        if (currentSha256.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
          const err: any = new Error(`LOCAL_FILE_CONFLICT: Expected SHA256 '${expectedSha256}' does not match current file SHA256 '${currentSha256}'`);
          err.code = 'LOCAL_FILE_CONFLICT';
          throw err;
        }

        // 3. Apply patches in memory
        let patchedContent = currentContent;
        for (let i = 0; i < rawPatches.length; i++) {
          const patch = rawPatches[i];
          if (typeof patch.oldText !== 'string' || typeof patch.newText !== 'string') {
            const err: any = new Error(`LOCAL_PATCH_INVALID: Patch at index ${i} must have string oldText and newText`);
            err.code = 'LOCAL_PATCH_INVALID';
            throw err;
          }

          const expectedOccurrences = patch.expectedOccurrences !== undefined ? patch.expectedOccurrences : 1;
          const matchCount = (patchedContent.match(new RegExp(escapeRegExp(patch.oldText), 'g')) || []).length;

          if (matchCount !== expectedOccurrences) {
            const err: any = new Error(`LOCAL_PATCH_FAILED: Patch at index ${i} expected ${expectedOccurrences} occurrence(s) of target text, but found ${matchCount}`);
            err.code = 'LOCAL_PATCH_FAILED';
            throw err;
          }

          patchedContent = patchedContent.replaceAll(patch.oldText, patch.newText);
        }

        // 4. Verify write path and nearest parent boundaries
        const writeTargetPath = ProjectPathSecurity.resolveWritePath(project.canonicalRoot, effectiveRelPath);

        // 5. Atomic disk replacement
        const dir = path.dirname(writeTargetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${writeTargetPath}.patch-tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        fs.writeFileSync(tmpPath, patchedContent, 'utf-8');
        fs.renameSync(tmpPath, writeTargetPath);

        // 6. Read back and compute new SHA256
        const newReadback = fs.readFileSync(writeTargetPath, 'utf-8');
        const newSha256 = crypto.createHash('sha256').update(newReadback, 'utf-8').digest('hex');

        onLog(`[EXECUTOR] Successfully patched ${effectiveRelPath} (previous: ${currentSha256.substring(0, 8)}, new: ${newSha256.substring(0, 8)})`);

        return {
          projectId: project.projectId,
          relativePath: effectiveRelPath,
          status: 'patched',
          previousSha256: currentSha256,
          newSha256,
          sizeBytes: Buffer.byteLength(newReadback)
        };
      }

      case 'local:run_tests': {
        const { project } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.test) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Test execution is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        // Reject arbitrary shell command execution in normal test capability
        if (task.payload.customCommand || task.payload.command) {
          const err: any = new Error('LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN: Arbitrary shell command execution is forbidden on local:run_tests. Use configured runnerId or local:raw_shell with raw_shell:run scope.');
          err.code = 'LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN';
          throw err;
        }

        const runnerId = task.payload.runnerId || task.payload.runner || 'npm';
        const cmdConfig = this.resolveTestCommand(project, runnerId);

        onLog(`[EXECUTOR] Running tests in project '${project.projectId}' via runner '${runnerId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
        return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, project.canonicalRoot, cmdConfig.env, onLog);
      }

      case 'local:build_project': {
        const { project } = this.resolveProjectForTask(task.payload);
        if (!project.permissions.build) {
          const err: any = new Error(`LOCAL_PROJECT_PERMISSION_DENIED: Build execution is forbidden on project '${project.projectId}'`);
          err.code = 'LOCAL_PROJECT_PERMISSION_DENIED';
          throw err;
        }

        // Reject arbitrary shell command execution in normal build capability
        if (task.payload.command || task.payload.customCommand) {
          const err: any = new Error('LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN: Arbitrary shell command execution is forbidden on local:build_project. Use configured commandId or local:raw_shell with raw_shell:run scope.');
          err.code = 'LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN';
          throw err;
        }

        const commandId = task.payload.commandId || 'npm';
        const cmdConfig = this.resolveBuildCommand(project, commandId);

        onLog(`[EXECUTOR] Building project '${project.projectId}' via command '${commandId}': ${cmdConfig.executable} ${cmdConfig.args.join(' ')}`);
        return this.executeProcessWithoutShell(cmdConfig.executable, cmdConfig.args, project.canonicalRoot, cmdConfig.env, onLog);
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
        return this.executeRawShell(cmd, project.canonicalRoot, onLog);
      }

      default:
        throw new Error(`UNSUPPORTED_CAPABILITY: Agent cannot execute '${task.capability}'`);
    }
  }

  private resolveTestCommand(project: any, runnerId: string): ConfiguredCommand {
    // 1. Check custom configured project commands
    if (project.commands?.test?.[runnerId]) {
      return project.commands.test[runnerId];
    }

    // 2. Standard built-in runners
    const isWindows = process.platform === 'win32';
    switch (runnerId.toLowerCase()) {
      case 'npm':
      case 'npm_test':
        return {
          executable: isWindows ? 'npm.cmd' : 'npm',
          args: ['test']
        };
      case 'pytest':
        return {
          executable: isWindows ? 'pytest.exe' : 'pytest',
          args: []
        };
      case 'flutter':
      case 'flutter_test':
        return {
          executable: isWindows ? 'flutter.bat' : 'flutter',
          args: ['test']
        };
      default: {
        const err: any = new Error(`LOCAL_RUNNER_NOT_FOUND: Unknown test runnerId '${runnerId}' for project '${project.projectId}'. Configure it in project.commands.test or use standard runners (npm, pytest, flutter).`);
        err.code = 'LOCAL_RUNNER_NOT_FOUND';
        throw err;
      }
    }
  }

  private resolveBuildCommand(project: any, commandId: string): ConfiguredCommand {
    // 1. Check custom configured project commands
    if (project.commands?.build?.[commandId]) {
      return project.commands.build[commandId];
    }

    // 2. Standard built-in build commands
    const isWindows = process.platform === 'win32';
    switch (commandId.toLowerCase()) {
      case 'npm':
      case 'npm_build':
        return {
          executable: isWindows ? 'npm.cmd' : 'npm',
          args: ['run', 'build']
        };
      case 'flutter':
      case 'flutter_apk':
        return {
          executable: isWindows ? 'flutter.bat' : 'flutter',
          args: ['build', 'apk']
        };
      default: {
        const err: any = new Error(`LOCAL_COMMAND_NOT_FOUND: Unknown build commandId '${commandId}' for project '${project.projectId}'. Configure it in project.commands.build or use standard commands (npm, flutter).`);
        err.code = 'LOCAL_COMMAND_NOT_FOUND';
        throw err;
      }
    }
  }

  private executeProcessWithoutShell(
    executable: string,
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> | undefined,
    onLog: (line: string) => void
  ): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, ...extraEnv },
        shell: false,
        windowsHide: true
      });

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
          const err: any = new Error(`Process failed with exit code ${code}: ${stdoutAcc.slice(-500)}`);
          err.code = 'LOCAL_PROCESS_FAILED';
          err.exitCode = code;
          reject(err);
        }
      });

      child.on('error', (err: any) => {
        reject(err);
      });
    });
  }

  private executeRawShell(
    command: string,
    cwd: string,
    onLog: (line: string) => void
  ): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const shellExecutable = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];

      const child = spawn(shellExecutable, shellArgs, {
        cwd,
        env: process.env,
        shell: false,
        windowsHide: true
      });

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
          const err: any = new Error(`Raw shell command failed with exit code ${code}: ${stdoutAcc.slice(-500)}`);
          err.code = 'RAW_SHELL_FAILED';
          err.exitCode = code;
          reject(err);
        }
      });

      child.on('error', (err: any) => {
        reject(err);
      });
    });
  }

  private runGitStatus(repoPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      const gitExe = isWindows ? 'git.exe' : 'git';

      const child = spawn(gitExe, ['status', '--porcelain'], { cwd: repoPath, shell: false });
      let statusOut = '';
      child.stdout?.on('data', d => { statusOut += d.toString(); });
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`git status failed with exit code ${code}`));

        const branchChild = spawn(gitExe, ['branch', '--show-current'], { cwd: repoPath, shell: false });
        let branchOut = '';
        branchChild.stdout?.on('data', d => { branchOut += d.toString(); });
        branchChild.on('close', () => {
          const branch = (branchOut || 'HEAD').trim();

          const commitChild = spawn(gitExe, ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false });
          let commitOut = '';
          commitChild.stdout?.on('data', d => { commitOut += d.toString(); });
          commitChild.on('close', () => {
            const headCommit = (commitOut || '').trim();
            const isClean = statusOut.trim().length === 0;

            resolve({
              branch: branch || 'main',
              headCommit,
              isClean,
              changes: statusOut.trim().split('\n').filter(Boolean)
            });
          });
        });
      });
      child.on('error', err => reject(err));
    });
  }
}
