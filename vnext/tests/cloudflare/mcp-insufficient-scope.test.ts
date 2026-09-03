import * as assert from 'assert';
import { GatewayDurableObject } from '../../src/cloudflare/worker';
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

function modernToolCallRequest(baseUrl: string, token: string, argumentsValue: any): Request {
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
        arguments: argumentsValue,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_2026_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { tools: {} }
        }
      }
    })
  });
}

function modernToolsListRequest(baseUrl: string, token: string): Request {
  return new Request(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_2026_VERSION,
      'Mcp-Method': 'tools/list'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {
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
  const baseUrl = 'https://gateway.example.test';
  const masterSecret = 'mcp-insufficient-scope-test-master-secret-123456';
  const authManager = new AuthManager(masterSecret);

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`MCP insufficient-scope step-up test failed (${name}):`, err);
    }
  };

  await run('missing local:write emits HTTP and MCP Bearer insufficient_scope challenges', async () => {
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

    const response = await gateway.fetch(modernToolCallRequest(baseUrl, token, {
      projectId: 'sandbox',
      relativePath: 'chatgpt-local-write-validation.txt',
      content: 'local write validation PASS'
    }));
    assert.strictEqual(response.status, 403, 'missing local:write must be an HTTP 403 OAuth scope challenge');

    const challenge = response.headers.get('WWW-Authenticate') || '';
    assert.ok(challenge.startsWith('Bearer '), `expected Bearer challenge, got: ${challenge}`);
    assert.ok(challenge.includes('error="insufficient_scope"'), `challenge must identify insufficient_scope: ${challenge}`);
    assert.ok(challenge.includes('scope="local:write"'), `challenge must request only the missing local:write scope: ${challenge}`);
    assert.ok(
      challenge.includes(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`),
      `challenge must advertise protected-resource metadata: ${challenge}`
    );

    const body = await response.json() as any;
    assert.strictEqual(body?.result?.isError, true, '403 response must preserve the MCP tool error result');
    const mcpChallenges = body?.result?._meta?.['mcp/www_authenticate'];
    assert.deepStrictEqual(mcpChallenges, [challenge], 'MCP result metadata must mirror the HTTP Bearer challenge');
  });

  await run('local file tools advertise explicit OAuth securitySchemes', async () => {
    const token = authManager.generateToken(
      'chatgpt-metadata-client',
      'client',
      ['mcp:access'],
      60 * 60 * 1000,
      { purpose: 'access_token', resource: `${baseUrl}/mcp`, clientId: 'chatgpt-metadata-client' }
    ).token;

    const gateway = new GatewayDurableObject(createContext(), {
      GATEWAY_DO: {},
      MASTER_SECRET: masterSecret,
      PUBLIC_BASE_URL: baseUrl
    });

    const response = await gateway.fetch(modernToolsListRequest(baseUrl, token));
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    const tools = body?.result?.tools || [];
    const byName = (name: string) => tools.find((tool: any) => tool.name === name);

    for (const name of ['local_write_file', 'local_patch_file', 'local_create_directory']) {
      assert.deepStrictEqual(
        byName(name)?.securitySchemes,
        [{ type: 'oauth2', scopes: ['tasks:submit', 'local:write'] }],
        `${name} must advertise tasks:submit + local:write`
      );
    }

    assert.deepStrictEqual(
      byName('local_read_file')?.securitySchemes,
      [{ type: 'oauth2', scopes: ['tasks:submit', 'local:read'] }],
      'local_read_file must advertise tasks:submit + local:read'
    );
  });

  await run('ordinary non-auth tool failures remain HTTP 200 MCP isError results', async () => {
    const token = authManager.generateToken(
      'chatgpt-write-client',
      'client',
      ['mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test'],
      60 * 60 * 1000,
      { purpose: 'access_token', resource: `${baseUrl}/mcp`, clientId: 'chatgpt-write-client' }
    ).token;

    const gateway = new GatewayDurableObject(createContext(), {
      GATEWAY_DO: {},
      MASTER_SECRET: masterSecret,
      PUBLIC_BASE_URL: baseUrl
    });

    const response = await gateway.fetch(modernToolCallRequest(baseUrl, token, {}));
    assert.strictEqual(response.status, 200, 'non-auth tool validation errors must remain MCP tool results');
    assert.strictEqual(response.headers.get('WWW-Authenticate'), null);
    const body = await response.json() as any;
    assert.strictEqual(body?.result?.isError, true);
    assert.strictEqual(body?.result?._meta?.['mcp/www_authenticate'], undefined);
  });

  return { passed, failed };
}
