import { mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Keep the startup/recovery gate while checking identity and unlinking. Other
// cooperating workers cannot replace a lock between those two operations.
export async function acquireWorkerLock(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const guardPath = `${path}.reclaim`;
  const guard = await open(guardPath, 'wx', 0o600);
  const guardIdentity = await guard.stat();
  const removeOwned = async (file: string, identity: { ino: number; dev: number }, contents?: string) => {
    try {
      const current = await lstat(file);
      if (!current.isFile() || current.ino !== identity.ino || current.dev !== identity.dev) return false;
      if (contents !== undefined && await readFile(file, 'utf8') !== contents) return false;
      await unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    await guard.writeFile(String(process.pid));
    // Do not reclaim another process's stale lock here. The explicit offline
    // recovery command verifies its owner and creates backups first.
    const lock = await open(path, 'wx', 0o600);
    const identity = await lock.stat();
    try { await lock.writeFile(String(process.pid)); await lock.sync(); }
    catch (error) { await removeOwned(path, identity); throw error; }
    finally { await lock.close(); }
    let released = false;
    return async () => {
      if (released) return false;
      // A simultaneous startup may briefly own the gate while rejecting our
      // still-live lock. Wait for that operation; never remove its guard.
      const deadline = Date.now() + 3000;
      const acquireReleaseGuard = async () => {
        for (;;) {
          try { return await open(guardPath, 'wx', 0o600); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
            await delay(25);
          }
        }
      };
      const releaseGuard = await acquireReleaseGuard();
      const releaseIdentity = await releaseGuard.stat();
      try {
        await releaseGuard.writeFile(String(process.pid));
        const removed = await removeOwned(path, identity, String(process.pid));
        released = true;
        return removed;
      } finally {
        await releaseGuard.close();
        await removeOwned(guardPath, releaseIdentity);
      }
    };
  } finally {
    await guard.close();
    await removeOwned(guardPath, guardIdentity);
  }
}
