import { GatewayDurableObject as BaseGatewayDurableObject, Env } from './gateway-durable-object';

function extractMissingScopes(message: string): string[] {
  if (!message.startsWith('AUTH_FORBIDDEN')) return [];
  const missing = message.match(/\bMissing:\s*(.+)$/)?.[1];
  if (!missing) return [];

  return [...missing.matchAll(/'([A-Za-z0-9:._*-]+)'/g)]
    .map(match => match[1])
    .filter((scope, index, all) => all.indexOf(scope) === index);
}

function getMcpToolErrorMessage(body: any): string | undefined {
  if (!body?.result?.isError || !Array.isArray(body.result.content)) return undefined;

  for (const item of body.result.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (typeof parsed?.error === 'string') return parsed.error;
    } catch {
      if (item.text.startsWith('AUTH_FORBIDDEN')) return item.text;
    }
  }

  return undefined;
}

function isMcpPost(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const pathname = new URL(request.url).pathname;
  return pathname === '/mcp' || pathname === '/api/mcp/v1';
}

async function applyInsufficientScopeChallenge(request: Request, response: Response): Promise<Response> {
  if (!isMcpPost(request) || response.status !== 200) return response;
  if (!(response.headers.get('Content-Type') || '').includes('application/json')) return response;

  let body: any;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  const message = getMcpToolErrorMessage(body);
  if (!message) return response;

  const missingScopes = extractMissingScopes(message);
  if (missingScopes.length === 0) return response;

  const resourceMetadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp`;
  const headers = new Headers(response.headers);
  headers.set(
    'WWW-Authenticate',
    `Bearer error="insufficient_scope", scope="${missingScopes.join(' ')}", resource_metadata="${resourceMetadata}"`
  );
  headers.set('Cache-Control', 'no-store');

  return Response.json(
    {
      jsonrpc: body?.jsonrpc || '2.0',
      id: body?.id ?? null,
      error: {
        code: -32003,
        message: 'Insufficient OAuth scope',
        data: {
          error: 'insufficient_scope',
          requiredScopes: missingScopes
        }
      }
    },
    { status: 403, headers }
  );
}

// Keep the Durable Object export name stable for the existing Cloudflare migration,
// while adapting authorization failures at the public HTTP transport boundary.
export class GatewayDurableObject extends BaseGatewayDurableObject {
  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    return applyInsufficientScopeChallenge(request, response);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all traffic to a singleton Gateway Durable Object instance
    const id = env.GATEWAY_DO.idFromName('global-gateway-singleton');
    const stub = env.GATEWAY_DO.get(id);
    return stub.fetch(request);
  }
};