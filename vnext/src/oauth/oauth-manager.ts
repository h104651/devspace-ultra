import crypto from 'crypto';
import { AuthManager } from '../security/auth-manager';
import { CloudflareSqliteStorageAdapter } from '../cloudflare/sqlite-storage-adapter';

export const CHATGPT_LEAST_PRIVILEGE_SCOPES = [
  'offline_access',
  'mcp:access',
  'tasks:submit',
  'tasks:read',
  'artifacts:read',
  'kaggle:submit',
  'kaggle:read',
  'local:read',
  'local:test',
  'swarm:dispatch'
];

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenAuthMethod: string;
  applicationType: 'web' | 'native';
  createdAt: number;
}

export interface OAuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  state?: string;
  resource: string;
  expiresAt: number;
}

type OAuthStorage = Pick<CloudflareSqliteStorageAdapter,
  'saveOAuthClient' | 'getOAuthClient' | 'saveOAuthCode' | 'getOAuthCode' | 'deleteOAuthCode' | 'isTokenRevoked' | 'revokeToken'>;

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function validateRedirectUri(raw: string, applicationType: 'web' | 'native'): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('INVALID_CLIENT_METADATA: redirect_uris must contain absolute URIs'); }
  if (url.username || url.password || url.hash) throw new Error('INVALID_CLIENT_METADATA: redirect URI must not contain credentials or fragment');

  if (applicationType === 'web') {
    if (url.protocol !== 'https:') throw new Error('INVALID_CLIENT_METADATA: web redirect URIs must use https');
  } else if (url.protocol === 'http:') {
    if (!isLoopbackHostname(url.hostname)) throw new Error('INVALID_CLIENT_METADATA: native http redirect URIs must be loopback only');
  } else if (url.protocol !== 'https:' && !url.protocol.endsWith(':')) {
    throw new Error('INVALID_CLIENT_METADATA: invalid native redirect URI scheme');
  }
}

export class OAuthManager {
  private issuerUrl: string;
  private expectedResource: string;

  constructor(
    issuerUrl: string,
    private authManager: AuthManager,
    private storage: OAuthStorage
  ) {
    this.issuerUrl = issuerUrl.replace(/\/+$/, '');
    this.expectedResource = `${this.issuerUrl}/mcp`;
  }

  public getAuthorizationServerMetadata() {
    return {
      issuer: this.issuerUrl,
      authorization_endpoint: `${this.issuerUrl}/oauth/authorize`,
      token_endpoint: `${this.issuerUrl}/oauth/token`,
      registration_endpoint: `${this.issuerUrl}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: CHATGPT_LEAST_PRIVILEGE_SCOPES,
      authorization_response_iss_parameter_supported: true
    };
  }

  public getProtectedResourceMetadata() {
    return {
      resource: this.expectedResource,
      authorization_servers: [this.issuerUrl],
      scopes_supported: CHATGPT_LEAST_PRIVILEGE_SCOPES,
      bearer_methods_supported: ['header']
    };
  }

  public async registerClient(body: any): Promise<any> {
    const clientName = typeof body?.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 200)
      : 'ChatGPT DevSpace Ultra Client';
    const applicationType: 'web' | 'native' = body?.application_type === 'native' ? 'native' : 'web';
    const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((v: any) => typeof v === 'string') : [];
    if (redirectUris.length === 0) throw new Error('INVALID_CLIENT_METADATA: redirect_uris is required');
    for (const uri of redirectUris) validateRedirectUri(uri, applicationType);

    const grantTypes = Array.isArray(body?.grant_types) && body.grant_types.length > 0 ? body.grant_types : ['authorization_code', 'refresh_token'];
    const responseTypes = Array.isArray(body?.response_types) && body.response_types.length > 0 ? body.response_types : ['code'];
    const tokenAuthMethod = body?.token_endpoint_auth_method || 'none';

    if (tokenAuthMethod !== 'none') throw new Error('INVALID_CLIENT_METADATA: only public PKCE clients (token_endpoint_auth_method=none) are supported');
    if (!grantTypes.includes('authorization_code') || grantTypes.some((g: string) => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new Error('INVALID_CLIENT_METADATA: unsupported grant_types');
    }
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') throw new Error('INVALID_CLIENT_METADATA: response_types must be ["code"]');

    const clientId = `chatgpt_client_${crypto.randomUUID()}`;
    const record: OAuthClientRegistration = {
      clientId,
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenAuthMethod,
      applicationType,
      createdAt: Date.now()
    };
    await this.storage.saveOAuthClient(record);

    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: tokenAuthMethod,
      application_type: applicationType
    };
  }

  private sanitizeScopes(scope?: string): string[] {
    if (!scope) return [...CHATGPT_LEAST_PRIVILEGE_SCOPES];
    const requested = scope.split(/[\s,]+/).filter(Boolean);
    const granted = [...new Set(requested.filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s)))];
    if (granted.length === 0) {
      throw new Error('INVALID_SCOPE: no requested OAuth scopes are supported');
    }
    return granted;
  }

  public async createAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope?: string;
    state?: string;
    resource?: string;
  }): Promise<string> {
    if (!params.clientId) throw new Error('INVALID_REQUEST: client_id is required');
    const client = await this.storage.getOAuthClient(params.clientId);
    if (!client) throw new Error('INVALID_REQUEST: unknown client_id');
    if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) throw new Error('INVALID_REQUEST: redirect_uri is not registered for this client');
    if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') throw new Error('INVALID_REQUEST: PKCE S256 code_challenge is required');

    const resource = params.resource || this.expectedResource;
    if (resource !== this.expectedResource) throw new Error('INVALID_TARGET: resource must identify this MCP protected resource');

    const code = `dsu_code_${crypto.randomUUID()}`;
    const record: OAuthCodeRecord = {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: this.sanitizeScopes(params.scope).join(' '),
      state: params.state,
      resource,
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    await this.storage.saveOAuthCode(record);
    return code;
  }

  public async exchangeCodeForTokens(params: {
    code: string;
    clientId?: string;
    redirectUri?: string;
    codeVerifier?: string;
    resource?: string;
  }): Promise<{ access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string }> {
    if (!params.code || !params.clientId || !params.redirectUri || !params.codeVerifier) throw new Error('INVALID_REQUEST: code, client_id, redirect_uri and code_verifier are required');
    const codeRecord = await this.storage.getOAuthCode(params.code);
    if (!codeRecord) throw new Error('INVALID_GRANT: Authorization code not found or expired');
    if (codeRecord.expiresAt < Date.now()) {
      await this.storage.deleteOAuthCode(params.code);
      throw new Error('INVALID_GRANT: Authorization code has expired');
    }
    if (codeRecord.clientId !== params.clientId) throw new Error('INVALID_GRANT: client_id mismatch');
    if (codeRecord.redirectUri !== params.redirectUri) throw new Error('INVALID_GRANT: redirect_uri mismatch');

    const client = await this.storage.getOAuthClient(params.clientId);
    if (!client || !client.redirectUris.includes(params.redirectUri)) throw new Error('INVALID_GRANT: client registration is invalid');

    const requestedResource = params.resource || codeRecord.resource;
    if (requestedResource !== codeRecord.resource || codeRecord.resource !== this.expectedResource) throw new Error('INVALID_TARGET: resource mismatch');

    const computed = crypto.createHash('sha256').update(params.codeVerifier).digest('base64url');
    if (computed !== codeRecord.codeChallenge) throw new Error('INVALID_GRANT: PKCE code_verifier challenge mismatch');

    await this.storage.deleteOAuthCode(params.code);
    const scopes = codeRecord.scope.split(' ').filter((s: string) => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));
    const granted = scopes.length > 0 ? scopes : [...CHATGPT_LEAST_PRIVILEGE_SCOPES];

    const access = this.authManager.generateToken(params.clientId, 'client', granted, 60 * 60 * 1000, {
      purpose: 'access_token', resource: codeRecord.resource, clientId: params.clientId
    });
    const refresh = this.authManager.generateToken(params.clientId, 'client', granted, 90 * 24 * 3600 * 1000, {
      purpose: 'refresh_token', resource: codeRecord.resource, clientId: params.clientId
    });

    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh.token,
      scope: granted.join(' ')
    };
  }

  public async refreshAccessToken(refreshToken: string, requestedResource?: string): Promise<{ access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string }> {
    const val = this.authManager.validateToken(refreshToken);
    if (!val.valid || !val.payload) throw new Error(`INVALID_GRANT: ${val.error || 'Invalid refresh token'}`);
    if (val.payload.metadata?.purpose !== 'refresh_token') throw new Error('INVALID_GRANT: token is not a refresh token');
    if (await this.storage.isTokenRevoked(val.payload.tokenId)) throw new Error('INVALID_GRANT: Refresh token revoked');

    const boundResource = val.payload.metadata?.resource;
    if (boundResource !== this.expectedResource || (requestedResource && requestedResource !== boundResource)) throw new Error('INVALID_TARGET: resource mismatch');

    const granted = (val.payload.scopes || []).filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));
    const finalScopes = granted.length > 0 ? granted : [...CHATGPT_LEAST_PRIVILEGE_SCOPES];

    this.authManager.revokeToken(val.payload.tokenId);
    await this.storage.revokeToken(val.payload.tokenId);

    const access = this.authManager.generateToken(val.payload.subjectId, 'client', finalScopes, 60 * 60 * 1000, {
      purpose: 'access_token', resource: boundResource, clientId: val.payload.subjectId
    });
    const refresh = this.authManager.generateToken(val.payload.subjectId, 'client', finalScopes, 90 * 24 * 3600 * 1000, {
      purpose: 'refresh_token', resource: boundResource, clientId: val.payload.subjectId
    });

    return { access_token: access.token, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh.token, scope: finalScopes.join(' ') };
  }

  public buildAuthorizationRedirect(redirectUri: string, code: string, state?: string): string {
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    target.searchParams.set('iss', this.issuerUrl);
    return target.toString();
  }

  public renderAuthorizationPage(params: {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope?: string;
    resource?: string;
  }): string {
    const scopesList = this.sanitizeScopes(params.scope);
    const scopeItemsHtml = scopesList.map(s => `<li><strong>${htmlEscape(s)}</strong></li>`).join('');
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorize DevSpace Ultra vNext</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}.card{background:#1e293b;border-radius:12px;max-width:480px;width:100%;padding:32px;border:1px solid #334155}h1{font-size:22px;margin-top:0;color:#38bdf8}p{font-size:14px;color:#94a3b8;line-height:1.5}.scope-box{background:#0f172a;border-radius:8px;padding:16px;margin:20px 0;border:1px solid #334155}.btn{display:block;width:100%;padding:12px;border-radius:8px;font-size:15px;font-weight:600;border:none;cursor:pointer}.btn-primary{background:#0284c7;color:white;margin-bottom:12px}.btn-secondary{background:transparent;color:#94a3b8;border:1px solid #475569}</style></head>
<body><div class="card"><h1>🚀 DevSpace Ultra vNext</h1><p><strong>ChatGPT</strong> is requesting access to your DevSpace Ultra Gateway.</p><div class="scope-box"><ul>${scopeItemsHtml}</ul></div>
<form method="POST" action="${htmlEscape(this.issuerUrl)}/oauth/authorize">
${hidden('client_id', params.clientId || '')}${hidden('redirect_uri', params.redirectUri || '')}${hidden('state', params.state || '')}${hidden('code_challenge', params.codeChallenge || '')}${hidden('code_challenge_method', params.codeChallengeMethod || 'S256')}${hidden('scope', params.scope || CHATGPT_LEAST_PRIVILEGE_SCOPES.join(' '))}${hidden('resource', params.resource || this.expectedResource)}
<button type="submit" class="btn btn-primary">Authorize & Connect</button><button type="button" class="btn btn-secondary" onclick="window.history.back()">Cancel</button></form></div></body></html>`;
  }
}
