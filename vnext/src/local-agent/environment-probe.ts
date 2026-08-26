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

export class EnvironmentProbe {
  static probe(): LocalEnvironmentReport {
    const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'darwin' : 'linux';
    const capabilities: string[] = ['local:read', 'local:write', 'local:test', 'local:git_status'];

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

    if (tools['git']?.available) {
      capabilities.push('local:git_diff', 'local:git_log');
    }
    if (tools['flutter']?.available || tools['node']?.available || tools['python']?.available) {
      capabilities.push('local:build_project');
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
