import { LocalAgentClient } from '../local-agent/client';
import dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:4000/ws/agent';
  const deviceId = process.env.AGENT_ID;
  const token = process.env.AGENT_TOKEN;
  const allowRawShell = process.env.ALLOW_RAW_SHELL === 'true';
  const allowedWorkspaces = (process.env.ALLOWED_WORKSPACES || process.cwd()).split(',').map(s => s.trim());

  if (!deviceId || !token) {
    console.error('ERROR: AGENT_ID and AGENT_TOKEN must be specified in .env or environment variables');
    process.exit(1);
  }

  console.log('====================================================');
  console.log('       DevSpace Ultra - Local Outbound Agent        ');
  console.log('====================================================');
  console.log(`Gateway URL        : ${gatewayUrl}`);
  console.log(`Device ID          : ${deviceId}`);
  console.log(`Allowed Workspaces : ${allowedWorkspaces.join(', ')}`);
  console.log(`Allow Raw Shell    : ${allowRawShell}`);
  console.log('----------------------------------------------------');

  const agent = new LocalAgentClient({
    gatewayUrl,
    deviceId,
    token,
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
