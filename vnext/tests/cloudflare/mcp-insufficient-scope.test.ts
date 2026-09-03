import * as assert from 'assert';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';
import { MCP_2026_VERSION } from '../../src/mcp/protocol';
import { SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';

class EmptySqlStorage implements SqlStorage {
  exec(_query: string, ..._params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    return {
      toArray: () => [],
      one: () => undefined,
      raw: () => []
    };
  }
}

function createContext() {
  const kv = new Map<string, any>();
  return {
    storage: {
      sql: new EmptySqlStorage(),
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: any) => { kv.set(key, structuredClone(value)); },
      setAlarm: async (_when: number) => {},
      deleteAlarm: async () => {}
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
  };
}

function modernToolCallRequest(baseUrl: string, token: string): Request {
  return new Request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_2026_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'local_write_file'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'local_write_file',
        arguments: {
          projectId: 'sandbox',
          relativePath: 'chatgpt-local-write-validation.txt',
          content: 'local write validation PASS'
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_2026_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { tools: {} }
        }
      }
    })
  });
}

export async function runMcpInsufficientScopeTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const baseUrl = 'https://gateway.example.test';
    const masterSecret = 'mcp-insufficient-scope-test-master-secret-123456';
    const authManager = new AuthManager(masterSecret);
    const token = authManager.generateToken(
      'chatgpt-existing-client',
      'client',
      ['mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:test'],
      60 * 60 * 1000,
      { purpose: 'access_token', resource: `${baseUrl}/mcp`, clientId: 'chatgpt-existing-client' }
    ).token;

    const gateway = new GatewayDurableObject(createContext(), {
      GATEWAY_DO: {},
      MASTER_SECRET: masterSecret,
      PUBLIC_BASE_URL: baseUrl
    });

    const response = await gateway.fetch(modernToolCallRequest(baseUrl, token));
    assert.strictEqual(response.status, 403, 'missing local:write must be an HTTP 403 OAuth scope challenge');

    const challenge = response.headers.get('WWW-Authenticate') || '';
    assert.ok(challenge.startsWith('Bearer '), `expected Bearer challenge, got: ${challenge}`);
    assert.ok(challenge.includes('error="insufficient_scope"'), `challenge must identify insufficient_scope: ${challenge}`);
    assert.ok(challenge.includes('scope="local:write"'), `challenge must request only the missing local:write scope: ${challenge}`);
    assert.ok(
      challenge.includes(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`),
      `challenge must advertise protected-resource metadata: ${challenge}`
    );

    passed++;
  } catch (err: any) {
    failed++;
    console.error('MCP insufficient-scope step-up test failed:', err);
  }

  return { passed, failed };
}
