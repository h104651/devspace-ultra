import * as assert from 'assert';
import * as path from 'path';
import { PathSanitizer } from '../../src/security/path-sanitizer';

export async function runPathSanitizerUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const baseDir = path.resolve('test-sandbox-root');

  try {
    // Test 1: Valid path inside root
    const safePath = PathSanitizer.resolveSafePath(baseDir, 'subdir/file.txt');
    assert.strictEqual(safePath, path.join(baseDir, 'subdir', 'file.txt'));
    passed++;

    // Test 2: Path traversal attack using ../
    assert.throws(() => {
      PathSanitizer.resolveSafePath(baseDir, '../../windows/system32/cmd.exe');
    }, /PATH_TRAVERSAL_DENIED/, 'Should throw PATH_TRAVERSAL_DENIED');
    passed++;

    // Test 3: Null byte injection
    assert.throws(() => {
      PathSanitizer.resolveSafePath(baseDir, 'file.txt\0.exe');
    }, /Invalid relative path/, 'Should block null bytes');
    passed++;

    // Test 4: Sanitize artifact filenames
    const sanitized = PathSanitizer.sanitizeArtifactFilename('../../bad:name*.log');
    assert.strictEqual(sanitized, 'bad_name_.log');
    passed++;
  } catch (err: any) {
    console.error('Path sanitizer test failed:', err);
    failed++;
  }

  return { passed, failed };
}
