export const MCP_2026_VERSION = '2026-07-28';
export const MCP_LEGACY_DEFAULT_VERSION = '2025-03-26';
export const MCP_SUPPORTED_MODERN_VERSIONS = [MCP_2026_VERSION] as const;
export const MCP_SUPPORTED_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', MCP_LEGACY_DEFAULT_VERSION] as const;

export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface McpValidationError {
  status: number;
  body: {
    jsonrpc: '2.0';
    id: any;
    error: {
      code: number;
      message: string;
      data?: any;
    };
  };
}

export interface McpValidationSuccess {
  modern: boolean;
  protocolVersion: string;
}

function requestId(body: any): any {
  return body?.id !== undefined ? body.id : null;
}

export function getRequestMeta(body: any): Record<string, any> {
  const meta = body?.params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

export function getBodyProtocolVersion(body: any): string | undefined {
  const version = getRequestMeta(body)['io.modelcontextprotocol/protocolVersion'];
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

export function isModernMcpRequest(headers: Headers, body: any): boolean {
  const headerVersion = headers.get('MCP-Protocol-Version') || undefined;
  const bodyVersion = getBodyProtocolVersion(body);
  return headerVersion === MCP_2026_VERSION || bodyVersion === MCP_2026_VERSION || body?.method === 'server/discover';
}

export function decodeMcpHeaderValue(value: string): string | undefined {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) {
    return value;
  }

  const encoded = value.slice('=?base64?'.length, -2);
  if (!encoded) return undefined;

  try {
    if (typeof atob === 'function') {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    const BufferCtor = (globalThis as any).Buffer;
    if (BufferCtor) {
      return BufferCtor.from(encoded, 'base64').toString('utf8');
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function headerMismatch(body: any, message: string): McpValidationError {
  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: requestId(body),
      error: {
        code: MCP_HEADER_MISMATCH,
        message
      }
    }
  };
}

function unsupportedVersion(body: any, requested: string): McpValidationError {
  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: requestId(body),
      error: {
        code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
        message: `Unsupported MCP protocol version '${requested}'`,
        data: {
          requested,
          supported: [...MCP_SUPPORTED_MODERN_VERSIONS]
        }
      }
    }
  };
}

function getExpectedMcpName(body: any): string | undefined {
  if (body?.method === 'tools/call' || body?.method === 'prompts/get') {
    return typeof body?.params?.name === 'string' ? body.params.name : undefined;
  }
  if (body?.method === 'resources/read') {
    return typeof body?.params?.uri === 'string' ? body.params.uri : undefined;
  }
  return undefined;
}

export function validateMcpRequest(headers: Headers, body: any): McpValidationSuccess | McpValidationError {
  const headerVersion = headers.get('MCP-Protocol-Version') || undefined;
  const bodyVersion = getBodyProtocolVersion(body);

  // Backward compatibility: versions before 2025-06-18 could omit the version header.
  if (!headerVersion && !bodyVersion && body?.method !== 'server/discover') {
    return { modern: false, protocolVersion: MCP_LEGACY_DEFAULT_VERSION };
  }

  const requestedVersion = headerVersion || bodyVersion || MCP_2026_VERSION;

  if ((MCP_SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(requestedVersion)) {
    return { modern: false, protocolVersion: requestedVersion };
  }

  if (requestedVersion !== MCP_2026_VERSION) {
    return unsupportedVersion(body, requestedVersion);
  }

  if (!headerVersion) {
    return headerMismatch(body, 'Header mismatch: MCP-Protocol-Version header is required for protocol 2026-07-28');
  }
  if (headerVersion !== MCP_2026_VERSION) {
    return unsupportedVersion(body, headerVersion);
  }
  if (!bodyVersion) {
    return headerMismatch(body, 'Header mismatch: request params._meta must include io.modelcontextprotocol/protocolVersion');
  }
  if (bodyVersion !== headerVersion) {
    return headerMismatch(body, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body protocolVersion '${bodyVersion}'`);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return headerMismatch(body, 'Header mismatch: modern MCP HTTP requests must contain one JSON-RPC request object');
  }
  if (body.jsonrpc !== '2.0') {
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: requestId(body),
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' }
      }
    };
  }
  if (typeof body.method !== 'string' || body.method.length === 0) {
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: requestId(body),
        error: { code: -32600, message: 'Invalid Request: method is required' }
      }
    };
  }

  const methodHeader = headers.get('Mcp-Method');
  if (!methodHeader) {
    return headerMismatch(body, 'Header mismatch: Mcp-Method header is required');
  }
  if (methodHeader !== body.method) {
    return headerMismatch(body, `Header mismatch: Mcp-Method '${methodHeader}' does not match body method '${body.method}'`);
  }

  const expectedName = getExpectedMcpName(body);
  if (expectedName !== undefined) {
    const nameHeader = headers.get('Mcp-Name');
    if (!nameHeader) {
      return headerMismatch(body, `Header mismatch: Mcp-Name header is required for ${body.method}`);
    }
    const decodedName = decodeMcpHeaderValue(nameHeader);
    if (decodedName === undefined) {
      return headerMismatch(body, 'Header mismatch: Mcp-Name contains invalid Base64 sentinel encoding');
    }
    if (decodedName !== expectedName) {
      return headerMismatch(body, `Header mismatch: Mcp-Name '${decodedName}' does not match body value '${expectedName}'`);
    }
  } else if (['tools/call', 'prompts/get', 'resources/read'].includes(body.method)) {
    return headerMismatch(body, `Header mismatch: ${body.method} request body is missing the value mirrored by Mcp-Name`);
  }

  const capabilities = getRequestMeta(body)['io.modelcontextprotocol/clientCapabilities'];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return {
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: requestId(body),
        error: {
          code: -32021,
          message: 'Missing required client capability metadata: io.modelcontextprotocol/clientCapabilities'
        }
      }
    };
  }

  return { modern: true, protocolVersion: MCP_2026_VERSION };
}

export function modernResult<T extends Record<string, any>>(result: T): T & { resultType: 'complete' } {
  return { resultType: 'complete', ...result } as T & { resultType: 'complete' };
}

export function modernCacheableResult<T extends Record<string, any>>(
  result: T,
  options: { ttlMs?: number; cacheScope?: 'private' | 'public' } = {}
): T & { resultType: 'complete'; ttlMs: number; cacheScope: 'private' | 'public' } {
  return {
    resultType: 'complete',
    ...result,
    ttlMs: options.ttlMs ?? 0,
    cacheScope: options.cacheScope ?? 'private'
  } as T & { resultType: 'complete'; ttlMs: number; cacheScope: 'private' | 'public' };
}

export function mcpResponseHeaders(modern: boolean, protocolVersion: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version, WWW-Authenticate',
    'Content-Type': 'application/json'
  };
  if (modern) {
    headers['MCP-Protocol-Version'] = protocolVersion;
  }
  return headers;
}
