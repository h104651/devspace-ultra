import { GatewayDurableObject as BaseGatewayDurableObject, Env } from './gateway-durable-object';

const LOCAL_TOOL_SECURITY_SCOPES: Record<string, string[]> = {
  local_project_list: ['mcp:access', 'tasks:submit', 'local:read'],
  local_project_status: ['mcp:access', 'tasks:submit', 'local:read'],
  local_read_file: ['mcp:access', 'tasks:submit', 'local:read'],
  local_list_directory: ['mcp:access', 'tasks:submit', 'local:read'],
  local_find_files: ['mcp:access', 'tasks:submit', 'local:read'],
  local_search_text: ['mcp:access', 'tasks:submit', 'local:read'],
  local_find_repositories: ['mcp:access', 'tasks:submit', 'local:read'],
  local_git_status: ['mcp:access', 'tasks:submit', 'local:read'],
  local_write_file: ['mcp:access', 'tasks:submit', 'local:write'],
  local_patch_file: ['mcp:access', 'tasks:submit', 'local:write'],
  local_create_directory: ['mcp:access', 'tasks:submit', 'local:write']
};

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

function addToolSecuritySchemes(body: any): boolean {
  if (!Array.isArray(body?.result?.tools)) return false;
  let changed = false;

  body.result.tools = body.result.tools.map((tool: any) => {
    const scopes = LOCAL_TOOL_SECURITY_SCOPES[tool?.name];
    if (!scopes) return tool;
    changed = true;
    return {
      ...tool,
      securitySchemes: [{ type: 'oauth2', scopes: [...scopes] }]
    };
  });

  return changed;
}

async function applyMcpOAuthMetadata(request: Request, response: Response): Promise<Response> {
  if (!isMcpPost(request)) return response;
  if (!(response.headers.get('Content-Type') || '').includes('application/json')) return response;

  let body: any;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);
  const changed = addToolSecuritySchemes(body);

  if (response.status === 200) {
    const message = getMcpToolErrorMessage(body);
    const missingScopes = message ? extractMissingScopes(message) : [];

    if (missingScopes.length > 0) {
      const resourceMetadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp`;
      const challenge = `Bearer error="insufficient_scope", scope="${missingScopes.join(' ')}", resource_metadata="${resourceMetadata}"`;
      headers.set('WWW-Authenticate', challenge);
      headers.set('Cache-Control', 'no-store');
      body.result = {
        ...body.result,
        _meta: {
          ...(body.result?._meta || {}),
          'mcp/www_authenticate': [challenge]
        }
      };
      return Response.json(body, { status: 403, headers });
    }
  }

  if (!changed) return response;
  return Response.json(body, { status: response.status, headers });
}

// Keep the Durable Object export name stable for the existing Cloudflare migration,
// while adapting ChatGPT-facing OAuth metadata at the public HTTP transport boundary.
export class GatewayDurableObject extends BaseGatewayDurableObject {
  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    return applyMcpOAuthMetadata(request, response);
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
