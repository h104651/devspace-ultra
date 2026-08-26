import * as assert from 'assert';
import crypto from 'crypto';
import { AuthManager } from '../../src/security/auth-manager';
import { OAuthManager } from '../../src/oauth/oauth-manager';

class MockStorage {
  private clients = new Map<string, any>();
  private codes = new Map<string, any>();
  private revoked = new Set<string>();
  async saveOAuthClient(client: any) { this.clients.set(client.clientId, client); }
  async getOAuthClient(id: string) { return this.clients.get(id); }
  async saveOAuthCode(code: any) { this.codes.set(code.code, code); }
  async getOAuthCode(code: string) { return this.codes.get(code); }
  async deleteOAuthCode(code: string) { this.codes.delete(code); }
  async isTokenRevoked(id: string) { return this.revoked.has(id); }
  async revokeToken(id: string) { this.revoked.add(id); }
}

export async function runOAuthTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  try {
    const issuer = 'https://devspace-ultra-gateway.abdul-hsu.workers.dev';
    const resource = `${issuer}/mcp`;
    const authManager = new AuthManager('test-master-secret-12345678901234567890');
    const storage = new MockStorage() as any;
    const oauthManager = new OAuthManager(issuer, authManager, storage);

    const authMeta = oauthManager.getAuthorizationServerMetadata();
    assert.strictEqual(authMeta.issuer, issuer);
    assert.deepStrictEqual(authMeta.code_challenge_methods_supported, ['S256']);
    assert.deepStrictEqual(authMeta.token_endpoint_auth_methods_supported, ['none']);
    assert.strictEqual(authMeta.authorization_response_iss_parameter_supported, true);
    assert.strictEqual(authMeta.scopes_supported.includes('admin:*'), false);
    passed++;

    const resourceMeta = oauthManager.getProtectedResourceMetadata();
    assert.strictEqual(resourceMeta.resource, resource);
    assert.ok(resourceMeta.scopes_supported.includes('mcp:access'));
    passed++;

    const redirectUri = 'https://chatgpt.com/connector/oauth/FLLrQdlez6Uf';
    const reg = await oauthManager.registerClient({ client_name: 'ChatGPT Live Connector', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    assert.ok(reg.client_id.startsWith('chatgpt_client_'));
    assert.deepStrictEqual(reg.redirect_uris, [redirectUri]);
    passed++;

    await assert.rejects(() => oauthManager.registerClient({ redirect_uris: ['http://evil.example/cb'] }), /web redirect URIs must use https/);
    passed++;

    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    await assert.rejects(
      () => oauthManager.createAuthorizationCode({
        clientId: reg.client_id,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scope: 'admin:* totally:unknown',
        resource
      }),
      /INVALID_SCOPE/
    );
    passed++;

    const code = await oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'offline_access mcp:access tasks:submit admin:*', state: 'state-1', resource });
    assert.ok(code.startsWith('dsu_code_'));
    passed++;

    await assert.rejects(() => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri: 'https://evil.example/callback', codeChallenge: challenge, codeChallengeMethod: 'S256', resource }), /redirect_uri is not registered/);
    passed++;

    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: 'wrong-client', redirectUri, codeVerifier: verifier, resource }), /client_id mismatch/);
    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri: 'https://evil.example/callback', codeVerifier: verifier, resource }), /redirect_uri mismatch/);
    passed++;

    const tokens = await oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri, codeVerifier: verifier, resource });
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.strictEqual(tokens.scope.includes('admin:*'), false);
    assert.strictEqual(authManager.validateToken(tokens.access_token).payload?.metadata?.purpose, 'access_token');
    assert.strictEqual(authManager.validateToken(tokens.refresh_token).payload?.metadata?.purpose, 'refresh_token');
    passed++;

    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri, codeVerifier: verifier, resource }), /Authorization code not found or expired/);
    passed++;

    const refreshed = await oauthManager.refreshAccessToken(tokens.refresh_token, resource);
    assert.notStrictEqual(refreshed.refresh_token, tokens.refresh_token);
    await assert.rejects(() => oauthManager.refreshAccessToken(tokens.refresh_token, resource), /(TOKEN_REVOKED|Refresh token revoked)/);
    passed++;

    await assert.rejects(() => oauthManager.refreshAccessToken(tokens.access_token, resource), /not a refresh token/);
    await assert.rejects(() => oauthManager.refreshAccessToken(refreshed.refresh_token, 'https://other.example/mcp'), /resource mismatch/);
    passed++;

    const redirect = oauthManager.buildAuthorizationRedirect(redirectUri, 'code-1', 'state-1');
    assert.ok(redirect.includes('iss='));
    const html = oauthManager.renderAuthorizationPage({ clientId: reg.client_id, redirectUri, state: 'state-1', codeChallenge: challenge, codeChallengeMethod: 'S256', resource });
    assert.ok(html.includes('Authorize DevSpace Ultra vNext'));
    assert.ok(html.includes('mcp:access'));
    passed++;
  } catch (err: any) {
    console.error('OAuth test failed:', err);
    failed++;
  }
  return { passed, failed };
}
