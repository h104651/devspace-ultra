"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_UNSUPPORTED_PROTOCOL_VERSION = exports.MCP_HEADER_MISMATCH = exports.MCP_SUPPORTED_LEGACY_VERSIONS = exports.MCP_SUPPORTED_MODERN_VERSIONS = exports.MCP_LEGACY_DEFAULT_VERSION = exports.MCP_2026_VERSION = void 0;
exports.getRequestMeta = getRequestMeta;
exports.getBodyProtocolVersion = getBodyProtocolVersion;
exports.isModernMcpRequest = isModernMcpRequest;
exports.decodeMcpHeaderValue = decodeMcpHeaderValue;
exports.validateMcpRequest = validateMcpRequest;
exports.modernResult = modernResult;
exports.modernCacheableResult = modernCacheableResult;
exports.mcpResponseHeaders = mcpResponseHeaders;
exports.MCP_2026_VERSION = '2026-07-28';
exports.MCP_LEGACY_DEFAULT_VERSION = '2025-03-26';
exports.MCP_SUPPORTED_MODERN_VERSIONS = [exports.MCP_2026_VERSION];
exports.MCP_SUPPORTED_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', exports.MCP_LEGACY_DEFAULT_VERSION];
exports.MCP_HEADER_MISMATCH = -32020;
exports.MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
function requestId(body) {
    return body?.id !== undefined ? body.id : null;
}
function getRequestMeta(body) {
    const meta = body?.params?._meta;
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}
function getBodyProtocolVersion(body) {
    const version = getRequestMeta(body)['io.modelcontextprotocol/protocolVersion'];
    return typeof version === 'string' && version.length > 0 ? version : undefined;
}
function isModernMcpRequest(headers, body) {
    const headerVersion = headers.get('MCP-Protocol-Version') || undefined;
    const bodyVersion = getBodyProtocolVersion(body);
    return headerVersion === exports.MCP_2026_VERSION || bodyVersion === exports.MCP_2026_VERSION || body?.method === 'server/discover';
}
function decodeMcpHeaderValue(value) {
    if (!value.startsWith('=?base64?') || !value.endsWith('?=')) {
        return value;
    }
    const encoded = value.slice('=?base64?'.length, -2);
    if (!encoded)
        return undefined;
    try {
        if (typeof atob === 'function') {
            const binary = atob(encoded);
            const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
            return new TextDecoder().decode(bytes);
        }
        const BufferCtor = globalThis.Buffer;
        if (BufferCtor) {
            return BufferCtor.from(encoded, 'base64').toString('utf8');
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function headerMismatch(body, message) {
    return {
        status: 400,
        body: {
            jsonrpc: '2.0',
            id: requestId(body),
            error: {
                code: exports.MCP_HEADER_MISMATCH,
                message
            }
        }
    };
}
function unsupportedVersion(body, requested) {
    return {
        status: 400,
        body: {
            jsonrpc: '2.0',
            id: requestId(body),
            error: {
                code: exports.MCP_UNSUPPORTED_PROTOCOL_VERSION,
                message: `Unsupported MCP protocol version '${requested}'`,
                data: {
                    requested,
                    supported: [...exports.MCP_SUPPORTED_MODERN_VERSIONS]
                }
            }
        }
    };
}
function getExpectedMcpName(body) {
    if (body?.method === 'tools/call' || body?.method === 'prompts/get') {
        return typeof body?.params?.name === 'string' ? body.params.name : undefined;
    }
    if (body?.method === 'resources/read') {
        return typeof body?.params?.uri === 'string' ? body.params.uri : undefined;
    }
    return undefined;
}
function validateMcpRequest(headers, body) {
    const headerVersion = headers.get('MCP-Protocol-Version') || undefined;
    const bodyVersion = getBodyProtocolVersion(body);
    // Backward compatibility: versions before 2025-06-18 could omit the version header.
    if (!headerVersion && !bodyVersion && body?.method !== 'server/discover') {
        return { modern: false, protocolVersion: exports.MCP_LEGACY_DEFAULT_VERSION };
    }
    const requestedVersion = headerVersion || bodyVersion || exports.MCP_2026_VERSION;
    if (exports.MCP_SUPPORTED_LEGACY_VERSIONS.includes(requestedVersion)) {
        return { modern: false, protocolVersion: requestedVersion };
    }
    if (requestedVersion !== exports.MCP_2026_VERSION) {
        return unsupportedVersion(body, requestedVersion);
    }
    if (!headerVersion) {
        return headerMismatch(body, 'Header mismatch: MCP-Protocol-Version header is required for protocol 2026-07-28');
    }
    if (headerVersion !== exports.MCP_2026_VERSION) {
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
    }
    else if (['tools/call', 'prompts/get', 'resources/read'].includes(body.method)) {
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
    return { modern: true, protocolVersion: exports.MCP_2026_VERSION };
}
function modernResult(result) {
    return { resultType: 'complete', ...result };
}
function modernCacheableResult(result, options = {}) {
    return {
        resultType: 'complete',
        ...result,
        ttlMs: options.ttlMs ?? 0,
        cacheScope: options.cacheScope ?? 'private'
    };
}
function mcpResponseHeaders(modern, protocolVersion) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'MCP-Protocol-Version, WWW-Authenticate',
        'Content-Type': 'application/json'
    };
    if (modern) {
        headers['MCP-Protocol-Version'] = protocolVersion;
    }
    return headers;
}
