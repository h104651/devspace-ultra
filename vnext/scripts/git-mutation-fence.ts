import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GitBranchAdapter, GitBranchLease } from './execute-git-branch-mutations';

// The protected directory is provisioned by local operator policy, never by
// an MCP task. Its ACL must deny the child identity writes and deletion.
// A single staged-execution fence deliberately serializes Git mutations even
// across project aliases; every competing workspace writer must honor it
// before enabling the production adapter. No automatic stale lock recovery.
export function withDurableGitFence(protectedDirectory: string, inner: GitBranchAdapter): GitBranchAdapter {
  if (!path.isAbsolute(protectedDirectory)) throw new Error('GIT_FENCE_DIRECTORY_DENIED');
  const root = fs.realpathSync(protectedDirectory);
  if (path.relative(root, path.resolve(protectedDirectory)) !== '' ||
      !fs.lstatSync(root).isDirectory() || fs.lstatSync(protectedDirectory).isSymbolicLink()) {
    throw new Error('GIT_FENCE_DIRECTORY_DENIED');
  }
  const lockPath = path.join(root, 'git-mutation.lock');
  return {
    async acquire(projectId: string): Promise<GitBranchLease> {
      // Persist before obtaining the inner execution lease. A crash at any
      // point leaves a fence, including an incomplete/empty owner record.
      const owner = JSON.stringify({ projectId, pid: process.pid, nonce: crypto.randomUUID(), createdAt: Date.now() });
      let fd: number;
      try { fd = fs.openSync(lockPath, 'wx', 0o600); }
      catch (err: any) {
        if (err.code === 'EEXIST') throw new Error('GIT_MUTATION_FENCE_HELD');
        throw err;
      }
      try { fs.writeFileSync(fd, owner, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      // Failure to acquire the inner lease is conservatively uncertain.
      const lease = await inner.acquire(projectId);
      let finished = false;
      return {
        approvedTargets: lease.approvedTargets,
        emptyHooksDirectory: lease.emptyHooksDirectory,
        indexWorkspace: lease.indexWorkspace,
        query: lease.query ? (args) => {
          if (finished) throw new Error('GIT_MUTATION_LEASE_CLOSED');
          return lease.query!(args);
        } : undefined,
        snapshot(intent) {
          if (finished) throw new Error('GIT_MUTATION_LEASE_CLOSED');
          return lease.snapshot(intent);
        },
        run(args) {
          if (finished) throw new Error('GIT_MUTATION_LEASE_CLOSED');
          return lease.run(args);
        },
        async finish(disposition) {
          if (finished) throw new Error('GIT_MUTATION_LEASE_CLOSED');
          finished = true;
          await lease.finish(disposition);
          if (disposition !== 'release') return;
          if (!fs.lstatSync(lockPath).isFile() || fs.lstatSync(lockPath).isSymbolicLink() ||
              fs.readFileSync(lockPath, 'utf8') !== owner) throw new Error('GIT_MUTATION_FENCE_OWNER_UNCERTAIN');
          fs.unlinkSync(lockPath);
        }
      };
    }
  };
}
