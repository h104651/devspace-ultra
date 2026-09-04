import * as assert from 'assert';
import { MCP_2026_VERSION, MCP_HEADER_MISMATCH, MCP_UNSUPPORTED_PROTOCOL_VERSION, decodeMcpHeaderValue, modernCacheableResult, modernResult, validateMcpRequest } from '../../src/mcp/protocol';

function modernBody(method: string, id = 1, extraParams: any = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...extraParams,
      _meta: {
        ...(extraParams._meta || {}),
        'io.modelcontextprotocol/protocolVersion': MCP_2026_VERSION,
        'io.modelcontextprotocol/clientCapabilities': { tools: {} }
      }
    }
  };
}

function headers(method: string, name?: string) {
  const h = new Headers({ 'MCP-Protocol-Version': MCP_2026_VERSION, 'Mcp-Method': method });
  if (name) h.set('Mcp-Name', name);
  return h;
}

export async function runMcp2026Tests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  try {
    const discover = validateMcpRequest(headers('server/discover'), modernBody('server/discover'));
    assert.strictEqual('status' in discover, false);
    assert.strictEqual((discover as any).modern, true);
    passed++;

    const list = validateMcpRequest(headers('tools/list'), modernBody('tools/list'));
    assert.strictEqual('status' in list, false);
    passed++;

    const callBody = modernBody('tools/call', 2, { name: 'kaggle_run', arguments: {} });
    const call = validateMcpRequest(headers('tools/call', 'kaggle_run'), callBody);
    assert.strictEqual('status' in call, false);
    passed++;

    const encodedName = `=?base64?${Buffer.from('工具/測試', 'utf8').toString('base64')}?=`;
    assert.strictEqual(decodeMcpHeaderValue(encodedName), '工具/測試');
    passed++;

    const mismatch = validateMcpRequest(headers('tools/list'), modernBody('ping')) as any;
    assert.strictEqual(mismatch.status, 400);
    assert.strictEqual(mismatch.body.error.code, MCP_HEADER_MISMATCH);
    passed++;

    const missingName = validateMcpRequest(headers('tools/call'), callBody) as any;
    assert.strictEqual(missingName.body.error.code, MCP_HEADER_MISMATCH);
    passed++;

    const unsupportedHeaders = new Headers({ 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' });
    const unsupported = validateMcpRequest(unsupportedHeaders, modernBody('tools/list')) as any;
    assert.strictEqual(unsupported.body.error.code, MCP_UNSUPPORTED_PROTOCOL_VERSION);
    passed++;

    const legacy = validateMcpRequest(new Headers(), { method: 'tools/list' }) as any;
    assert.strictEqual(legacy.modern, false);
    passed++;

    const cacheable = modernCacheableResult({ tools: [] }, { ttlMs: 300000, cacheScope: 'private' });
    assert.strictEqual(cacheable.resultType, 'complete');
    assert.strictEqual(cacheable.ttlMs, 300000);
    assert.strictEqual(cacheable.cacheScope, 'private');
    passed++;

    const toolResult = modernResult({ content: [] });
    assert.strictEqual(toolResult.resultType, 'complete');
    passed++;

    // Regression: Tool surface integrity and uniqueness
    const canonicalTools = (await import('../../src/mcp/tools')).getCanonicalToolsList();
    const toolNames = canonicalTools.map(t => t.name);
    const uniqueNames = new Set(toolNames);
    assert.strictEqual(uniqueNames.size, toolNames.length, 'No duplicate tool names allowed in canonical tools list');
    assert.ok(toolNames.includes('kaggle_workspace_get'), 'kaggle_workspace_get must be present in canonical tools');
    assert.ok(toolNames.includes('kaggle_workspace_file'), 'kaggle_workspace_file must be present in canonical tools');
    assert.ok(toolNames.includes('kaggle_workspace_continue'), 'kaggle_workspace_continue must be present in canonical tools');

    const toolsModule = await import('../../src/mcp/tools');
    assert.ok(toolsModule.KAGGLE_WORKSPACE_GET_SCHEMA, 'KAGGLE_WORKSPACE_GET_SCHEMA must exist');
    assert.ok(toolsModule.KAGGLE_WORKSPACE_FILE_SCHEMA, 'KAGGLE_WORKSPACE_FILE_SCHEMA must exist');
    assert.ok(toolsModule.KAGGLE_WORKSPACE_CONTINUE_SCHEMA, 'KAGGLE_WORKSPACE_CONTINUE_SCHEMA must exist');

    for (const t of canonicalTools) {
      assert.ok(t.inputSchema, `Tool ${t.name} must have inputSchema`);
      assert.strictEqual(t.inputSchema.type, 'object', `Tool ${t.name} inputSchema must have type object`);
    }
    passed++;
  } catch (err: any) {
    console.error('MCP 2026 protocol test failed:', err);
    failed++;
  }
  return { passed, failed };
}
