import * as os from 'os';
import { execSync } from 'child_process';

export interface LocalEnvironmentReport {
  platform: 'windows' | 'linux' | 'darwin';
  osVersion: string;
  architecture: string;
  hostname: string;
  capabilities: string[];
  tools: Record<string, { available: boolean; version?: string }>;
  timestamp: number;
}

export interface ProbeOptions {
  allowRawShell?: boolean;
}

export class EnvironmentProbe {
  static probe(options?: ProbeOptions): LocalEnvironmentReport {
    const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'darwin' : 'linux';
    const capabilities: string[] = [
      'local:list_projects',
      'local:project_status',
      'local:git_status',
      'local:read_file',
      'local:write_file',
      'local:patch_file',
      'local:list_directory',
      'local:find_files',
      'local:search_text',
      'local:find_repositories',
      'local:create_directory',
      'local:run_tests'
    ];

    const tools: Record<string, { available: boolean; version?: string }> = {};

    const checkTool = (name: string, cmd: string) => {
      try {
        const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).trim();
        tools[name] = { available: true, version: out.split('\n')[0] };
      } catch {
        tools[name] = { available: false };
      }
    };

    checkTool('git', 'git --version');
    checkTool('node', 'node --version');
    checkTool('python', 'python --version');
    checkTool('flutter', 'flutter --version');

    if (tools['flutter']?.available || tools['node']?.available || tools['python']?.available || tools['git']?.available) {
      capabilities.push('local:build_project');
    }

    if (options?.allowRawShell) {
      capabilities.push('local:raw_shell');
    }

    return {
      platform,
      osVersion: os.release(),
      architecture: os.arch(),
      hostname: os.hostname(),
      capabilities,
      tools,
      timestamp: Date.now()
    };
  }
}
