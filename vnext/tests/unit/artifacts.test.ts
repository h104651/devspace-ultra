import * as assert from 'assert';
import * as fs from 'fs';
import { ArtifactStore } from '../../src/storage/artifact-store';

export async function runArtifactsUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-artifacts';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  try {
    const store = new ArtifactStore(testDir, 1024 * 1024); // 1MB max

    // Test 1: Save log artifact
    const art1 = store.saveArtifact('task-100', 'stdout.log', 'line 1\nline 2\nsuccess', 'log');
    assert.strictEqual(art1.name, 'stdout.log');
    assert.strictEqual(art1.type, 'log');
    assert.strictEqual(art1.preview, 'line 1\nline 2\nsuccess');
    assert.ok(art1.sha256.length === 64);
    passed++;

    // Test 2: Read artifact content
    const content = store.readArtifactContent(art1.id);
    assert.ok(content);
    assert.strictEqual(content?.toString('utf-8'), 'line 1\nline 2\nsuccess');
    passed++;

    // Test 3: List task artifacts
    store.saveArtifact('task-100', 'result.json', JSON.stringify({ score: 0.99 }), 'json');
    const taskArts = store.getTaskArtifacts('task-100');
    assert.strictEqual(taskArts.length, 2);
    passed++;

    // Test 4: Oversized artifact rejection
    const bigBuffer = Buffer.alloc(2 * 1024 * 1024); // 2MB
    assert.throws(() => {
      store.saveArtifact('task-100', 'huge.bin', bigBuffer, 'binary');
    }, /ARTIFACT_SIZE_EXCEEDED/);
    passed++;
  } catch (err: any) {
    console.error('Artifacts test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
