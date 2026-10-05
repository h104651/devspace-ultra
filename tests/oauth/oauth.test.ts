import * as assert from 'assert';
import crypto from 'crypto';
import { AuthManager } from '../../src/security/auth-manager';
import { OAuthManager, CHATGPT_LEAST_PRIVILEGE_SCOPES } from '../../src/oauth/oauth-manager';

class MockStorage {
  private clients: Map<string, any> = new Map();
  private codes: Map<string, any> = new Map();
  private revoked: Set<string> = new Set();

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
    const authManager = new AuthManager('test-master-secret-12345678901234567890');
    const storage = new MockStorage() as any;
    const oauthManager = new OAuthManager('https://devspace-ultra-gateway.abdul-hsu.workers.dev', authManager, storage);

    // 1. Discovery Metadata: offline_access advertised & S256 PKCE
    const authServerMeta = oauthManager.getAuthorizationServerMetadata();
    assert.strictEqual(authServerMeta.issuer, 'https://devspace-ultra-gateway.abdul-hsu.workers.dev');
    assert.strictEqual(authServerMeta.authorization_endpoint, 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/oauth/authorize');
    assert.strictEqual(authServerMeta.token_endpoint, 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/oauth/token');
    assert.ok(authServerMeta.scopes_supported.includes('offline_access'), 'Must advertise offline_access');
    assert.deepStrictEqual(authServerMeta.code_challenge_methods_supported, ['S256']);
    assert.deepStrictEqual(authServerMeta.token_endpoint_auth_methods_supported, ['none']);
    assert.strictEqual(authServerMeta.scopes_supported.includes('admin:*'), false);
    passed++;

    // 2. Protected Resource Metadata for /mcp
    const resourceMeta = oauthManager.getProtectedResourceMetadata();
    assert.strictEqual(resourceMeta.resource, 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp');
    assert.ok(resourceMeta.scopes_supported.includes('offline_access'));
    assert.ok(resourceMeta.scopes_supported.includes('mcp:access'));
    passed++;

    // 3. Dynamic Client Registration with arbitrary valid ChatGPT redirect URI
    const chatgptRedirectUri = 'https://chatgpt.com/connector/oauth/FLLrQdlez6Uf';
    const regRes = await oauthManager.registerClient({
      client_name: 'ChatGPT Live Connector',
      redirect_uris: [chatgptRedirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
    assert.ok(regRes.client_id.startsWith('chatgpt_client_'));
    assert.deepStrictEqual(regRes.redirect_uris, [chatgptRedirectUri]);
    passed++;

    // 4. Authorization Code Generation with PKCE S256 & resource parameter
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const code = await oauthManager.createAuthorizationCode({
      clientId: regRes.client_id,
      redirectUri: chatgptRedirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scope: 'offline_access mcp:access tasks:submit admin:*', // tries to request admin:*
      state: 'oauth_s_6a8e8733e3788191afcf32faea0c3d5f',
      resource: 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp'
    });
    assert.ok(code.startsWith('dsu_code_'));
    passed++;

    // 5. Code Exchange: Reject Tampered Redirect URI
    await assert.rejects(
      async () => {
        await oauthManager.exchangeCodeForTokens({
          code,
          redirectUri: 'https://evil.com/callback',
          codeVerifier
        });
      },
      /redirect_uri mismatch/,
      'Must reject tampered redirect URI'
    );
    passed++;

    // 6. Code Exchange: PKCE verification and least-privilege token issuance
    const tokens = await oauthManager.exchangeCodeForTokens({
      code,
      redirectUri: chatgptRedirectUri,
      codeVerifier,
      resource: 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp'
    });
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.strictEqual(tokens.token_type, 'Bearer');
    assert.strictEqual(tokens.scope.includes('admin:*'), false, 'Must not grant admin:* scope');
    assert.ok(tokens.scope.includes('mcp:access'));
    passed++;

    // 7. Single-use Code Replay Prevention
    await assert.rejects(
      async () => {
        await oauthManager.exchangeCodeForTokens({
          code,
          redirectUri: chatgptRedirectUri,
          codeVerifier
        });
      },
      /Authorization code not found or expired/
    );
    passed++;

    // 8. Refresh Token Exchange with Rotation
    const refreshedTokens = await oauthManager.refreshAccessToken(tokens.refresh_token, 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp');
    assert.ok(refreshedTokens.access_token);
    assert.ok(refreshedTokens.refresh_token);
    assert.notStrictEqual(refreshedTokens.access_token, tokens.access_token);
    assert.strictEqual(refreshedTokens.scope.includes('admin:*'), false);
    passed++;

    // 9. Revoked Token Rejection
    const parsedRef = authManager.validateToken(refreshedTokens.refresh_token);
    await storage.revokeToken(parsedRef.payload?.tokenId);

    await assert.rejects(
      async () => {
        await oauthManager.refreshAccessToken(refreshedTokens.refresh_token);
      },
      /Refresh token revoked/
    );
    passed++;

    // 10. Consent UI rendering includes resource
    const html = oauthManager.renderAuthorizationPage({
      clientId: regRes.client_id,
      redirectUri: chatgptRedirectUri,
      state: 'oauth_s_6a8e8733e3788191afcf32faea0c3d5f',
      codeChallenge,
      codeChallengeMethod: 'S256',
      resource: 'https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp'
    });
    assert.ok(html.includes('Authorize DevSpace Ultra vNext'));
    assert.ok(html.includes('ChatGPT'));
    assert.ok(html.includes('mcp:access'));
    passed++;

  } catch (err: any) {
    console.error('OAuth test failed:', err);
    failed++;
  }

  return { passed, failed };
}
