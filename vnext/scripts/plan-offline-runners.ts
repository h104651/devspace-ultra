/**
 * Local, read-only configuration planner. Never starts tools, writes projects.json,
 * enables execution, resolves credentials or grants ACLs. The operator must review
 * paths, staged dependencies, signing policy and execution identity separately.
 */
import * as fs from 'fs';
import { ConfiguredCommand, LocalProjectCommands } from '../src/local-agent/project-registry';

const PROFILES = {
  flutter_analyze: { tool: 'flutter', group: 'test', args: ['analyze', '--no-pub'], timeoutMs: 600000 },
  flutter_test: { tool: 'flutter', group: 'test', args: ['test', '--no-pub'], timeoutMs: 1800000 },
  flutter_build_apk_debug: { tool: 'flutter', group: 'build', args: ['build', 'apk', '--debug', '--no-pub'], timeoutMs: 3600000 },
  flutter_pub_get_offline: { tool: 'flutter', group: 'build', args: ['pub', 'get', '--offline'], timeoutMs: 600000, dependencyMutation: true },
  dart_analyze: { tool: 'dart', group: 'test', args: ['analyze'], timeoutMs: 600000 },
  dart_test: { tool: 'dart', group: 'test', args: ['test'], timeoutMs: 1800000 },
  dart_format_check: { tool: 'dart', group: 'test', args: ['format', '--output=none', '--set-exit-if-changed', '.'], timeoutMs: 600000 },
  gradle_test: { tool: 'gradle', group: 'test', args: ['--offline', '--no-daemon', 'test'], timeoutMs: 3600000 },
  gradle_assemble_debug: { tool: 'gradle', group: 'build', args: ['--offline', '--no-daemon', 'assembleDebug'], timeoutMs: 3600000 },
  npm_test: { tool: 'npm', group: 'test', args: ['--offline', '--ignore-scripts', 'test'], timeoutMs: 1800000 },
  npm_build: { tool: 'npm', group: 'build', args: ['--offline', '--ignore-scripts', 'run', 'build'], timeoutMs: 1800000 },
  npm_ci_offline: { tool: 'npm', group: 'build', args: ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 1800000, dependencyMutation: true },
  node_version: { tool: 'node', group: 'test', args: ['--version'], timeoutMs: 10000 },
  python_pytest: { tool: 'python', group: 'test', args: ['-I', '-m', 'pytest'], timeoutMs: 1800000 },
  python_version: { tool: 'python', group: 'test', args: ['--version'], timeoutMs: 10000 },
  java_version: { tool: 'java', group: 'test', args: ['-version'], timeoutMs: 10000 },
  adb_version: { tool: 'adb', group: 'test', args: ['version'], timeoutMs: 10000 }
} as const;

const NAMES: Record<string, RegExp> = {
  flutter: /^flutter\.bat$/i, dart: /^dart\.(bat|exe)$/i, gradle: /^gradlew\.bat$/i,
  npm: /^npm\.cmd$/i, node: /^node\.exe$/i, python: /^python(?:3)?\.exe$/i,
  java: /^java\.exe$/i, adb: /^adb\.exe$/i
};

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function onlyKeys(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected planner field');
}
function own(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function checkedWorkdir(value: unknown): string {
  if (value === undefined || value === '.') return '.';
  if (typeof value !== 'string' || value.length > 240 ||
      !/^[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/.test(value) ||
      value.split('/').some(part => part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error('Use a normalized project-relative directory with slash separators');
  }
  return value;
}
function checkedTool(tool: string, value: unknown): string {
  if (typeof value !== 'string' || value.length > 260 ||
      !/^[A-Za-z]:\\[A-Za-z0-9_ .()~\\/-]+$/.test(value) ||
      value.slice(3).split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')) ||
      !NAMES[tool].test(value.split(/[\\/]/).pop() || '')) {
    throw new Error('Expected explicit local Windows tool path for ' + tool);
  }
  return value;
}

export function planOfflineRunners(input: unknown): {
  commands: LocalProjectCommands;
  selections: Array<{ id: string; group: 'test' | 'build'; dependencyMutation: boolean }>;
  activationAuthorized: false;
} {
  if (!object(input)) throw new Error('Planner input must be an object');
  onlyKeys(input, ['tools', 'profiles', 'workingRelativePath', 'allowDependencyMutation']);
  if (!object(input.tools) || !Array.isArray(input.profiles) || input.profiles.length === 0 ||
      input.profiles.length > Object.keys(PROFILES).length) throw new Error('Explicit tools and profiles required');
  onlyKeys(input.tools, Object.keys(NAMES));
  if (input.allowDependencyMutation !== undefined && typeof input.allowDependencyMutation !== 'boolean') {
    throw new Error('allowDependencyMutation must be boolean');
  }
  const workdir = checkedWorkdir(input.workingRelativePath);
  const commands: LocalProjectCommands = { test: {}, build: {} };
  const selections: Array<{ id: string; group: 'test' | 'build'; dependencyMutation: boolean }> = [];
  const selected = new Set<string>();
  for (const id of input.profiles) {
    if (typeof id !== 'string' || !own(PROFILES,id) || selected.has(id)) throw new Error('Unknown or duplicate fixed profile');
    selected.add(id);
    const spec = PROFILES[id as keyof typeof PROFILES];
    const mutation = 'dependencyMutation' in spec && spec.dependencyMutation === true;
    if (mutation && input.allowDependencyMutation !== true) throw new Error('Dependency mutation requires explicit local approval');
    if (!own(input.tools,spec.tool)) throw new Error('Missing explicit tool path for ' + spec.tool);
    const command: ConfiguredCommand = {
      executable: checkedTool(spec.tool,input.tools[spec.tool]),
      args: [...spec.args], workingRelativePath: workdir, timeoutMs: spec.timeoutMs
    };
    commands[spec.group][id] = command;
    selections.push({ id, group: spec.group, dependencyMutation: mutation });
  }
  return { commands, selections, activationAuthorized: false };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npx ts-node scripts/plan-offline-runners.ts <local-plan.json>');
    const file = process.argv[2];
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 65536) throw new Error('Expected a small local plan file');
    console.log(JSON.stringify(planOfflineRunners(JSON.parse(fs.readFileSync(file,'utf8'))), null, 2));
  } catch (err: any) {
    console.error('Runner plan rejected: ' + (err?.message || 'unknown error'));
    process.exitCode = 1;
  }
}
