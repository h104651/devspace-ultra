import * as assert from 'assert';
import gatewayWorker from '../../src/cloudflare/worker';

const LEGACY_SINGLETON_NAME = 'global-gateway-singleton';
const RECOVERY_SINGLETON_NAME = 'global-gateway-singleton-recovery-20260910';

export async function runWorkerRoutingRecoveryTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const routedNames: string[] = [];
    const env: any = {
      GATEWAY_DO: {
        idFromName(name: string) {
          routedNames.push(name);
          return { name };
        },
        get(id: any) {
          return {
            fetch: async () => new Response(JSON.stringify({ routedTo: id.name }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          };
        }
      }
    };

    const response = await gatewayWorker.fetch(
      new Request('https://devspace-ultra-gateway.abdul-hsu.workers.dev/health'),
      env
    );
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(
      routedNames,
      [RECOVERY_SINGLETON_NAME],
      'Production traffic must use a fresh named object while the legacy singleton storage is preserved for recovery'
    );
    assert.notStrictEqual(routedNames[0], LEGACY_SINGLETON_NAME);
    passed++;
  } catch (err) {
    failed++;
    console.error('Worker recovery singleton routing regression failed:', err);
  }

  return { passed, failed };
}
