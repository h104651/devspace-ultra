import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ProjectRegistry,
  ProjectPathSecurity,
  LocalProjectDefinition
} from '../../src/local-agent/project-registry';

export async function runProjectRegistryUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`\n  FAIL: ${name}\n  ${err.stack || err.message}`);
    }
  }

  const tmpBase = path.join(os.tmpdir(), `devspace-project-registry-test-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  const rootA = path.join(tmpBase, 'proj-a');
  const rootB = path.join(tmpBase, 'proj-b');
  const outsideDir = path.join(tmpBase, 'outside-secret');

  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  fs.writeFileSync(path.join(rootA, 'fileA.txt'), 'Hello from Project A', 'utf-8');
  fs.writeFileSync(path.join(rootB, 'fileB.txt'), 'Hello from Project B', 'utf-8');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SUPER_SECRET_HOST_DATA', 'utf-8');

  try {
    // 1. normalizeProjectId
    await test('normalizeProjectId: normalizes lowercase, trimmed strings', () => {
      assert.strictEqual(ProjectPathSecurity.normalizeProjectId('  Astor-TuneUp  '), 'astor-tuneup');
      assert.strictEqual(ProjectPathSecurity.normalizeProjectId('devspace_ultra.v2'), 'devspace_ultra.v2');
    });

    await test('normalizeProjectId: rejects invalid characters and empty strings', () => {
      assert.throws(() => ProjectPathSecurity.normalizeProjectId(''), /INVALID_PROJECT_ID/);
      assert.throws(() => ProjectPathSecurity.normalizeProjectId('proj/sub'), /INVALID_PROJECT_ID/);
      assert.throws(() => ProjectPathSecurity.normalizeProjectId('proj\\sub'), /INVALID_PROJECT_ID/);
      assert.throws(() => ProjectPathSecurity.normalizeProjectId('proj:sub'), /INVALID_PROJECT_ID/);
      assert.throws(() => ProjectPathSecurity.normalizeProjectId('proj*sub'), /INVALID_PROJECT_ID/);
    });

    // 2. ProjectRegistry Registration & Lookup
    await test('ProjectRegistry: register and get project', () => {
      const registry = new ProjectRegistry();
      registry.registerProject({
        projectId: 'Project-A',
        displayName: 'Project Alpha',
        root: rootA,
        permissions: { read: true, write: true, test: true, build: true }
      });

      const p = registry.getProject('project-a');
      assert.strictEqual(p.projectId, 'project-a');
      assert.strictEqual(p.displayName, 'Project Alpha');
      assert.strictEqual(p.enabled, true);
      assert.strictEqual(p.permissions.read, true);
      assert.strictEqual(p.permissions.write, true);
    });

    await test('ProjectRegistry: getProject throws LOCAL_PROJECT_NOT_FOUND for unregistered', () => {
      const registry = new ProjectRegistry();
      assert.throws(
        () => registry.getProject('non-existent'),
        /LOCAL_PROJECT_NOT_FOUND/
      );
    });

    await test('ProjectRegistry: getProject throws LOCAL_PROJECT_DISABLED for disabled project', () => {
      const registry = new ProjectRegistry();
      registry.registerProject({
        projectId: 'disabled-proj',
        root: rootA,
        enabled: false
      });
      assert.throws(
        () => registry.getProject('disabled-proj'),
        /LOCAL_PROJECT_DISABLED/
      );
    });

    await test('ProjectRegistry: listProjects returns safe metadata without leaking root path', () => {
      const registry = new ProjectRegistry();
      registry.registerProject({
        projectId: 'project-a',
        displayName: 'Project Alpha',
        root: rootA
      });

      const list = registry.listProjects();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].projectId, 'project-a');
      assert.strictEqual(list[0].displayName, 'Project Alpha');
      assert.strictEqual(list[0].enabled, true);
      assert.strictEqual((list[0] as any).root, undefined);
      assert.strictEqual((list[0] as any).canonicalRoot, undefined);
    });

    // 3. validateRelativePath Security
    await test('validateRelativePath: accepts valid relative paths', () => {
      assert.strictEqual(ProjectPathSecurity.validateRelativePath('src/index.ts'), path.normalize('src/index.ts'));
      assert.strictEqual(ProjectPathSecurity.validateRelativePath('docs/readme.md'), path.normalize('docs/readme.md'));
    });

    await test('validateRelativePath: rejects absolute paths (POSIX and Windows)', () => {
      assert.throws(() => ProjectPathSecurity.validateRelativePath('/etc/passwd'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('\\windows\\system32'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('C:\\Users\\admin'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('D:/data'), /LOCAL_PROJECT_PATH_ESCAPE/);
    });

    await test('validateRelativePath: rejects UNC and network paths', () => {
      assert.throws(() => ProjectPathSecurity.validateRelativePath('\\\\server\\share\\file.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('//server/share/file.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
    });

    await test('validateRelativePath: rejects .. path traversal escaping root', () => {
      assert.throws(() => ProjectPathSecurity.validateRelativePath('..'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('../secret.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('..\\secret.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('foo/../../secret.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
      assert.throws(() => ProjectPathSecurity.validateRelativePath('foo\\..\\..\\secret.txt'), /LOCAL_PROJECT_PATH_ESCAPE/);
    });

    // 4. resolveReadPath & resolveWritePath
    await test('resolveReadPath: resolves existing file within canonical root', () => {
      const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(rootA);
      const target = ProjectPathSecurity.resolveReadPath(canonicalRoot, 'fileA.txt');
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'Hello from Project A');
    });

    await test('resolveReadPath: throws FILE_NOT_FOUND when file does not exist', () => {
      const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(rootA);
      assert.throws(
        () => ProjectPathSecurity.resolveReadPath(canonicalRoot, 'does_not_exist.txt'),
        /FILE_NOT_FOUND/
      );
    });

    await test('resolveReadPath: blocks symlink escaping project root', () => {
      const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(rootA);
      const symlinkPath = path.join(rootA, 'escape_link.txt');
      const targetOutside = path.join(outsideDir, 'secret.txt');

      try {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        fs.symlinkSync(targetOutside, symlinkPath, 'file');

        assert.throws(
          () => ProjectPathSecurity.resolveReadPath(canonicalRoot, 'escape_link.txt'),
          /LOCAL_PROJECT_PATH_ESCAPE/
        );
      } catch (symlinkErr: any) {
        if (symlinkErr.code === 'EPERM' && process.platform === 'win32') {
          // Windows unprivileged symlink privilege limitation in some CI environments
          console.log('      (Skipping symlink creation test due to Windows unprivileged environment)');
        } else {
          throw symlinkErr;
        }
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      }
    });

    await test('resolveWritePath: resolves new file path in project', () => {
      const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(rootA);
      const target = ProjectPathSecurity.resolveWritePath(canonicalRoot, 'sub/nested/newfile.txt');
      assert.strictEqual(ProjectPathSecurity.isPathInsideRoot(target, canonicalRoot), true);
    });

    await test('resolveWritePath: rejects write path traversal escaping project root', () => {
      const canonicalRoot = ProjectPathSecurity.getCanonicalRoot(rootA);
      assert.throws(
        () => ProjectPathSecurity.resolveWritePath(canonicalRoot, '../../outside.txt'),
        /LOCAL_PROJECT_PATH_ESCAPE/
      );
    });

    // 5. Config persistence
    await test('ProjectRegistry: load and save to projects.json', () => {
      const configPath = path.join(tmpBase, 'projects.json');
      const reg1 = new ProjectRegistry({ configFilePath: configPath });
      reg1.registerProject({
        projectId: 'project-1',
        displayName: 'Proj 1',
        root: rootA,
        permissions: { read: true, write: false, test: true, build: false }
      });
      reg1.saveToFile();

      const reg2 = new ProjectRegistry({ configFilePath: configPath });
      const p = reg2.getProject('project-1');
      assert.strictEqual(p.projectId, 'project-1');
      assert.strictEqual(p.displayName, 'Proj 1');
      assert.strictEqual(p.permissions.write, false);
      assert.strictEqual(p.permissions.read, true);
    });

  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }

  return { passed, failed };
}
