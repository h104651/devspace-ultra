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
  createdAt: number;
}

export interface OAuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope: string;
  state?: string;
  resource?: string;
  expiresAt: number;
}

export class OAuthManager {
  private issuerUrl: string;
  private authManager: AuthManager;
  private storage: CloudflareSqliteStorageAdapter;

  constructor(issuerUrl: string, authManager: AuthManager, storage: CloudflareSqliteStorageAdapter) {
    this.issuerUrl = issuerUrl.replace(/\/+$/, '');
    this.authManager = authManager;
    this.storage = storage;
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
      scopes_supported: CHATGPT_LEAST_PRIVILEGE_SCOPES
    };
  }

  public getProtectedResourceMetadata() {
    return {
      resource: `${this.issuerUrl}/mcp`,
      authorization_servers: [this.issuerUrl],
      scopes_supported: CHATGPT_LEAST_PRIVILEGE_SCOPES,
      bearer_methods_supported: ['header']
    };
  }

  public async registerClient(body: any): Promise<any> {
    const clientName = body.client_name || 'ChatGPT DevSpace Ultra Client';
    const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
      ? body.redirect_uris
      : ['https://chatgpt.com/aip/oauth/callback', 'https://chat.openai.com/aip/oauth/callback'];
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code'];
    const tokenAuthMethod = body.token_endpoint_auth_method || 'none';

    const clientId = `chatgpt_client_${crypto.randomUUID()}`;
    const clientSecret = tokenAuthMethod !== 'none' ? crypto.randomBytes(32).toString('hex') : undefined;

    const record: OAuthClientRegistration = {
      clientId,
      clientSecret,
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenAuthMethod,
      createdAt: Date.now()
    };

    await this.storage.saveOAuthClient(record);

    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
      client_secret_expires_at: 0,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: tokenAuthMethod
    };
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
    const code = `dsu_code_${crypto.randomUUID()}`;
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Sanitize requested scopes to only allowed least-privilege scopes
    let grantedScopes = CHATGPT_LEAST_PRIVILEGE_SCOPES;
    if (params.scope) {
      const requested = params.scope.split(/[\s,]+/);
      grantedScopes = requested.filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));
      if (grantedScopes.length === 0) {
        grantedScopes = CHATGPT_LEAST_PRIVILEGE_SCOPES;
      }
    }

    const record: OAuthCodeRecord = {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod || 'S256',
      scope: grantedScopes.join(' '),
      state: params.state,
      resource: params.resource,
      expiresAt
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
  }): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  }> {
    const codeRecord = await this.storage.getOAuthCode(params.code);
    if (!codeRecord) {
      throw new Error('INVALID_GRANT: Authorization code not found or expired');
    }

    if (codeRecord.expiresAt < Date.now()) {
      await this.storage.deleteOAuthCode(params.code);
      throw new Error('INVALID_GRANT: Authorization code has expired');
    }

    // Exact redirect_uri verification
    if (codeRecord.redirectUri && params.redirectUri && codeRecord.redirectUri !== params.redirectUri) {
      console.error(`REDIRECT_URI_MISMATCH: stored=${codeRecord.redirectUri} received=${params.redirectUri}`);
      throw new Error('INVALID_GRANT: redirect_uri mismatch');
    }

    // PKCE Verification
    if (codeRecord.codeChallenge) {
      if (!params.codeVerifier) {
        throw new Error('INVALID_REQUEST: code_verifier required for PKCE');
      }

      if (codeRecord.codeChallengeMethod === 'S256') {
        const computed = crypto.createHash('sha256').update(params.codeVerifier).digest('base64url');
        if (computed !== codeRecord.codeChallenge) {
          throw new Error('INVALID_GRANT: PKCE code_verifier challenge mismatch');
        }
      } else if (codeRecord.codeChallengeMethod === 'plain') {
        if (params.codeVerifier !== codeRecord.codeChallenge) {
          throw new Error('INVALID_GRANT: PKCE code_verifier mismatch');
        }
      }
    }

    // Delete used code (single-use)
    await this.storage.deleteOAuthCode(params.code);

    // Issue least-privilege tokens
    const grantedScopes = codeRecord.scope.split(' ').filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));
    const tokenRes = this.authManager.generateToken(
      codeRecord.clientId || 'chatgpt-oauth-client',
      'client',
      grantedScopes.length > 0 ? grantedScopes : CHATGPT_LEAST_PRIVILEGE_SCOPES,
      30 * 24 * 3600 * 1000 // 30 days
    );

    const refreshTokenRes = this.authManager.generateToken(
      codeRecord.clientId || 'chatgpt-oauth-client',
      'client',
      grantedScopes.length > 0 ? grantedScopes : CHATGPT_LEAST_PRIVILEGE_SCOPES,
      90 * 24 * 3600 * 1000 // 90 days
    );

    return {
      access_token: tokenRes.token,
      token_type: 'Bearer',
      expires_in: 30 * 24 * 3600,
      refresh_token: refreshTokenRes.token,
      scope: (grantedScopes.length > 0 ? grantedScopes : CHATGPT_LEAST_PRIVILEGE_SCOPES).join(' ')
    };
  }

  public async refreshAccessToken(refreshToken: string, requestedResource?: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  }> {
    const val = this.authManager.validateToken(refreshToken);
    if (!val.valid || !val.payload) {
      throw new Error(`INVALID_GRANT: ${val.error || 'Invalid refresh token'}`);
    }

    const isRevoked = await this.storage.isTokenRevoked(val.payload.tokenId);
    if (isRevoked) {
      throw new Error('INVALID_GRANT: Refresh token revoked');
    }

    // Least privilege sanitization
    const grantedScopes = (val.payload.scopes || []).filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));
    const finalScopes = grantedScopes.length > 0 ? grantedScopes : CHATGPT_LEAST_PRIVILEGE_SCOPES;

    const newAccessToken = this.authManager.generateToken(
      val.payload.subjectId,
      'client',
      finalScopes,
      30 * 24 * 3600 * 1000
    );

    const newRefreshToken = this.authManager.generateToken(
      val.payload.subjectId,
      'client',
      finalScopes,
      90 * 24 * 3600 * 1000
    );

    return {
      access_token: newAccessToken.token,
      token_type: 'Bearer',
      expires_in: 30 * 24 * 3600,
      refresh_token: newRefreshToken.token,
      scope: finalScopes.join(' ')
    };
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
    const scopesList = (params.scope ? params.scope.split(/[\s,]+/) : CHATGPT_LEAST_PRIVILEGE_SCOPES)
      .filter(s => CHATGPT_LEAST_PRIVILEGE_SCOPES.includes(s));

    const scopeItemsHtml = scopesList.map(s => `<li><strong>${s}</strong></li>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authorize DevSpace Ultra vNext</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #1e293b; border-radius: 12px; max-width: 480px; width: 100%; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); border: 1px solid #334155; }
    h1 { font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; }
    .scope-box { background: #0f172a; border-radius: 8px; padding: 16px; margin: 20px 0; border: 1px solid #334155; }
    .scope-box h3 { margin: 0 0 8px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
    .scope-box ul { margin: 0; padding-left: 20px; font-size: 13px; color: #cbd5e1; }
    .btn { display: block; width: 100%; padding: 12px; border-radius: 8px; font-size: 15px; font-weight: 600; text-align: center; cursor: pointer; border: none; transition: all 0.15s ease; box-sizing: border-box; }
    .btn-primary { background: #0284c7; color: white; margin-bottom: 12px; }
    .btn-primary:hover { background: #0369a1; }
    .btn-secondary { background: transparent; color: #94a3b8; border: 1px solid #475569; }
    .btn-secondary:hover { background: #334155; color: white; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 DevSpace Ultra vNext</h1>
    <p><strong>ChatGPT</strong> is requesting access to connect with your DevSpace Ultra Gateway.</p>
    <div class="scope-box">
      <h3>Granted Permissions (Least Privilege)</h3>
      <ul>${scopeItemsHtml}</ul>
    </div>
    <form method="POST" action="${this.issuerUrl}/oauth/authorize">
      <input type="hidden" name="client_id" value="${encodeURIComponent(params.clientId || '')}">
      <input type="hidden" name="redirect_uri" value="${encodeURIComponent(params.redirectUri || '')}">
      <input type="hidden" name="state" value="${encodeURIComponent(params.state || '')}">
      <input type="hidden" name="code_challenge" value="${encodeURIComponent(params.codeChallenge || '')}">
      <input type="hidden" name="code_challenge_method" value="${encodeURIComponent(params.codeChallengeMethod || 'S256')}">
      <input type="hidden" name="scope" value="${encodeURIComponent(params.scope || CHATGPT_LEAST_PRIVILEGE_SCOPES.join(' '))}">
      <input type="hidden" name="resource" value="${encodeURIComponent(params.resource || '')}">
      <button type="submit" class="btn btn-primary">Authorize & Connect</button>
      <button type="button" class="btn btn-secondary" onclick="window.history.back()">Cancel</button>
    </form>
  </div>
</body>
</html>`;
  }
}
