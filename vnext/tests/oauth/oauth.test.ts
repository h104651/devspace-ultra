import * as assert from 'assert';
import crypto from 'crypto';
import { AuthManager } from '../../src/security/auth-manager';
import { OAuthManager, CHATGPT_LEAST_PRIVILEGE_SCOPES } from '../../src/oauth/oauth-manager';

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

    // 1. Metadata tests
    const authMeta = oauthManager.getAuthorizationServerMetadata();
    assert.strictEqual(authMeta.issuer, issuer);
    assert.deepStrictEqual(authMeta.code_challenge_methods_supported, ['S256']);
    assert.deepStrictEqual(authMeta.token_endpoint_auth_methods_supported, ['none']);
    assert.strictEqual(authMeta.authorization_response_iss_parameter_supported, true);
    assert.deepStrictEqual(authMeta.scopes_supported, CHATGPT_LEAST_PRIVILEGE_SCOPES);
    assert.strictEqual(authMeta.scopes_supported.includes('admin'), false);
    assert.strictEqual(authMeta.scopes_supported.includes('admin:kill-switch'), false);
    assert.strictEqual(authMeta.scopes_supported.includes('local:write'), false);
    assert.strictEqual(authMeta.scopes_supported.includes('tasks:cancel'), false);
    passed++;

    const resourceMeta = oauthManager.getProtectedResourceMetadata();
    assert.strictEqual(resourceMeta.resource, resource);
    assert.deepStrictEqual(resourceMeta.scopes_supported, CHATGPT_LEAST_PRIVILEGE_SCOPES);
    assert.ok(resourceMeta.scopes_supported.includes('mcp:access'));
    passed++;

    // 2. Client registration
    const redirectUri = 'https://chatgpt.com/connector/oauth/FLLrQdlez6Uf';
    const reg = await oauthManager.registerClient({
      client_name: 'ChatGPT Live Connector',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
    assert.ok(reg.client_id.startsWith('chatgpt_client_'));
    assert.deepStrictEqual(reg.redirect_uris, [redirectUri]);
    passed++;

    await assert.rejects(() => oauthManager.registerClient({ redirect_uris: ['http://evil.example/cb'] }), /web redirect URIs must use https/);
    passed++;

    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // 3. Strict Privilege Boundary Rejection Tests
    // (a) public OAuth requesting admin -> INVALID_SCOPE
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'admin', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (b) public OAuth requesting admin:kill-switch -> INVALID_SCOPE
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'admin:kill-switch', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (c) public OAuth requesting local:write -> INVALID_SCOPE
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'local:write', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (d) public OAuth requesting tasks:cancel -> INVALID_SCOPE
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'tasks:cancel', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (e) public OAuth requesting local:git_status -> INVALID_SCOPE
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'local:git_status', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (f) mixed scope escalation attempt ("mcp:access admin") - must fail closed, NO partial grant
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'mcp:access admin', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // (g) mixed scope escalation attempt ("offline_access mcp:access local:write")
    await assert.rejects(
      () => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'offline_access mcp:access local:write', resource }),
      /INVALID_SCOPE.*not permitted/
    );
    passed++;

    // 4. Normal Least Privilege Authorization
    const validScope = 'offline_access mcp:access tasks:submit tasks:read artifacts:read kaggle:submit kaggle:read local:read local:test swarm:dispatch';
    const code = await oauthManager.createAuthorizationCode({
      clientId: reg.client_id,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: validScope,
      state: 'state-1',
      resource
    });
    assert.ok(code.startsWith('dsu_code_'));
    passed++;

    // 5. Code exchange validation & Least Privilege Guarantee
    await assert.rejects(() => oauthManager.createAuthorizationCode({ clientId: reg.client_id, redirectUri: 'https://evil.example/callback', codeChallenge: challenge, codeChallengeMethod: 'S256', resource }), /redirect_uri is not registered/);
    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: 'wrong-client', redirectUri, codeVerifier: verifier, resource }), /client_id mismatch/);
    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri: 'https://evil.example/callback', codeVerifier: verifier, resource }), /redirect_uri mismatch/);
    passed++;

    const tokens = await oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri, codeVerifier: verifier, resource });
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.strictEqual(tokens.scope.includes('admin'), false);
    assert.strictEqual(tokens.scope.includes('local:write'), false);
    assert.strictEqual(tokens.scope.includes('tasks:cancel'), false);
    assert.strictEqual(authManager.validateToken(tokens.access_token).payload?.metadata?.purpose, 'access_token');
    assert.strictEqual(authManager.validateToken(tokens.refresh_token).payload?.metadata?.purpose, 'refresh_token');
    passed++;

    // Cannot replay used authorization code
    await assert.rejects(() => oauthManager.exchangeCodeForTokens({ code, clientId: reg.client_id, redirectUri, codeVerifier: verifier, resource }), /Authorization code not found or expired/);
    passed++;

    // 6. Refresh Token flow & Privilege Rejection
    const refreshed = await oauthManager.refreshAccessToken(tokens.refresh_token, resource);
    assert.notStrictEqual(refreshed.refresh_token, tokens.refresh_token);
    assert.strictEqual(refreshed.scope.includes('admin'), false);
    assert.strictEqual(refreshed.scope.includes('local:write'), false);
    await assert.rejects(() => oauthManager.refreshAccessToken(tokens.refresh_token, resource), /(TOKEN_REVOKED|Refresh token revoked)/);
    passed++;

    // Malicious or historically overprivileged refresh token rejection test
    const fakeOverprivilegedRefresh = authManager.generateToken(reg.client_id, 'client', ['mcp:access', 'admin', 'local:write'], 3600000, {
      purpose: 'refresh_token', resource, clientId: reg.client_id
    });
    await assert.rejects(
      () => oauthManager.refreshAccessToken(fakeOverprivilegedRefresh.token, resource),
      /INVALID_GRANT: refresh token contains forbidden privileged scopes/
    );
    passed++;

    await assert.rejects(() => oauthManager.refreshAccessToken(tokens.access_token, resource), /not a refresh token/);
    await assert.rejects(() => oauthManager.refreshAccessToken(refreshed.refresh_token, 'https://other.example/mcp'), /resource mismatch/);
    passed++;

    // 7. Authorization Page Rendering
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
