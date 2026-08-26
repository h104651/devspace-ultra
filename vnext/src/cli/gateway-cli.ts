import { GatewayServer } from '../gateway/server';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const port = parseInt(process.env.PORT || '4000', 10);
  const host = process.env.GATEWAY_HOST || '0.0.0.0';
  const storageDir = process.env.STORAGE_DIR || '.devspace-storage';
  const masterSecret = process.env.MASTER_SECRET;

  console.log('====================================================');
  console.log('       DevSpace Ultra - Secure Remote Gateway       ');
  console.log('====================================================');

  const server = new GatewayServer({
    port,
    host,
    storageDir,
    masterSecret
  });

  // Ensure default admin client exists if empty
  const clients = server.authManager.listClients();
  if (clients.length === 0) {
    const { clientId, token } = server.authManager.registerClient('Default Admin Client', ['admin']);
    console.log('\n[AUTH] Generated Initial Admin Client Token:');
    console.log(`  Client ID : ${clientId}`);
    console.log(`  Token     : ${token}`);
    console.log('  Save this token securely for ChatGPT / Remote API access.\n');
  }

  // Ensure default desktop agent device token exists if empty
  const devices = server.authManager.listDevices();
  if (devices.length === 0) {
    const { deviceId, token } = server.authManager.registerDevice('Windows Desktop Primary', 'windows');
    console.log('[AUTH] Generated Initial Desktop Agent Token:');
    console.log(`  Device ID : ${deviceId}`);
    console.log(`  Token     : ${token}`);
    console.log('  Configure your local agent with this token.\n');
  }

  await server.start();
  console.log(`[GATEWAY] Gateway running at http://${host}:${port}`);
  console.log(`[GATEWAY] WebSocket agent endpoint: ws://${host}:${port}/ws/agent`);
  console.log(`[GATEWAY] Health endpoint: http://${host}:${port}/health`);
}

main().catch((err) => {
  console.error('Fatal error starting Gateway:', err);
  process.exit(1);
});
