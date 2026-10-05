import * as assert from 'assert';
import * as fs from 'fs';
import http from 'http';
import { GatewayServer } from '../../src/gateway/server';

export async function runRemoteMcpHttpTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-mcp-http';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const port = 49300 + Math.floor(Math.random() * 1000);
  const server = new GatewayServer({
    port,
    storageDir: testDir,
    masterSecret: 'test-secret',
    kaggleMockMode: true,
    kagglePollIntervalMs: 50
  });

  const makeMcpRequest = (path: string, body: any, token?: string): Promise<{ statusCode: number; body: any }> => {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data).toString()
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers
        },
        (res) => {
          let responseBody = '';
          res.on('data', chunk => (responseBody += chunk));
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 200, body: JSON.parse(responseBody) });
            } catch {
              resolve({ statusCode: res.statusCode || 200, body: responseBody });
            }
          });
        }
      );

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };

  try {
    await server.start();

    const { token: clientToken } = server.authManager.registerClient('ChatGPT Remote Client', ['admin']);

    // Test 1: Anonymous request to /mcp rejected with 401
    const anonRes = await makeMcpRequest('/mcp', { method: 'tools/list' });
    assert.strictEqual(anonRes.statusCode, 401);
    assert.strictEqual(anonRes.body.error, 'AUTH_REQUIRED');
    passed++;

    // Test 2: Authenticated tools/list via Remote MCP
    const listRes = await makeMcpRequest('/mcp', { method: 'tools/list' }, clientToken);
    assert.strictEqual(listRes.statusCode, 200);
    assert.ok(listRes.body.result?.tools?.length >= 8);
    const toolNames = listRes.body.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('kaggle_run'));
    assert.ok(toolNames.includes('remote_task_submit'));
    assert.ok(toolNames.includes('remote_task_status'));
    passed++;

    // Test 3: Authenticated tools/call for remote_task_submit
    const callRes = await makeMcpRequest(
      '/mcp',
      {
        method: 'tools/call',
        params: {
          name: 'remote_task_submit',
          arguments: {
            backend: 'local',
            capability: 'local:git_status',
            payload: { workspace: process.cwd() }
          }
        }
      },
      clientToken
    );

    assert.strictEqual(callRes.statusCode, 200);
    const content = JSON.parse(callRes.body.result.content[0].text);
    assert.ok(content.taskId);
    assert.strictEqual(content.status, 'queued');
    passed++;

    // Test 4: Authenticated tools/call for kaggle_run
    const kaggleCall = await makeMcpRequest(
      '/api/mcp/v1',
      {
        method: 'tools/call',
        params: {
          name: 'kaggle_run',
          arguments: {
            kernelSlug: 'test-mcp-kernel',
            title: 'Test MCP Kernel',
            code: 'print("MCP Hello")'
          }
        }
      },
      clientToken
    );

    assert.strictEqual(kaggleCall.statusCode, 200);
    const kaggleResult = JSON.parse(kaggleCall.body.result.content[0].text);
    assert.ok(kaggleResult.taskId);
    assert.strictEqual(kaggleResult.status, 'running');
    passed++;
  } catch (err: any) {
    console.error('Remote MCP HTTP test failed:', err);
    failed++;
  } finally {
    await server.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
