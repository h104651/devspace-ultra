import { LocalAgentClient } from '../local-agent/client';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:4000/ws/agent';
  const deviceId = process.env.AGENT_ID;
  const token = process.env.AGENT_TOKEN;
  const allowRawShell = process.env.ALLOW_RAW_SHELL === 'true';

  // Parse CLI args for --projects-config or --config
  let projectsConfigFile = process.env.LOCAL_PROJECTS_CONFIG || process.env.PROJECTS_CONFIG;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--projects-config' || args[i] === '--config') && args[i + 1]) {
      projectsConfigFile = args[i + 1];
      i++;
    }
  }

  // If not explicitly specified, check for default ./projects.json
  if (!projectsConfigFile && fs.existsSync(path.resolve('projects.json'))) {
    projectsConfigFile = path.resolve('projects.json');
  }

  const allowedWorkspaces = process.env.ALLOWED_WORKSPACES
    ? process.env.ALLOWED_WORKSPACES.split(',').map(s => s.trim())
    : (projectsConfigFile ? undefined : [process.cwd()]);

  if (!deviceId || !token) {
    console.error('ERROR: AGENT_ID and AGENT_TOKEN must be specified in .env or environment variables');
    process.exit(1);
  }

  console.log('====================================================');
  console.log('       DevSpace Ultra - Local Outbound Agent        ');
  console.log('====================================================');
  console.log(`Gateway URL        : ${gatewayUrl}`);
  console.log(`Device ID          : ${deviceId}`);
  if (projectsConfigFile) {
    console.log(`Projects Config    : ${projectsConfigFile}`);
  }
  if (allowedWorkspaces) {
    console.log(`Legacy Workspaces  : ${allowedWorkspaces.join(', ')}`);
  }
  console.log(`Allow Raw Shell    : ${allowRawShell}`);
  console.log('----------------------------------------------------');

  const agent = new LocalAgentClient({
    gatewayUrl,
    deviceId,
    token,
    projectsConfigFile: projectsConfigFile ? path.resolve(projectsConfigFile) : undefined,
    allowedWorkspaces,
    allowRawShell
  });

  agent.start();
  console.log('[AGENT] Local Agent connected outbound. Waiting for tasks...');

  process.on('SIGINT', () => {
    console.log('\n[AGENT] Stopping Local Agent...');
    agent.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error starting Agent:', err);
  process.exit(1);
});
