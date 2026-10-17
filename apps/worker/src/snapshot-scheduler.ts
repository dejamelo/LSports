import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { statePath } from '@lsports/feed-store';
import { OperationError } from './diagnostics.js';
import type { Operation } from './diagnostics.js';
interface Schedule { nextAt: number; failures: Record<string, number>; due: Record<string, number> }
// Local policy, not a claimed supplier quota: serialize host requests, space by 5s,
// refresh each operation at most every 5min; back off 60s..30min + positive jitter.
export class SnapshotScheduler {
  private path: string;
  constructor(host: string, private packageId: number, private options: {
    root?: string; now?: () => number; random?: () => number; spacingMs?: number; refreshMs?: number;
  } = {}) {
    this.path = `${options.root || statePath()}.snapshot-${createHash('sha256').update(new URL(host).origin).digest('hex').slice(0, 16)}.json`;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private defer(name: Operation, retryAt: number): never {
    throw new OperationError({ operation: name, protocol: 'http', category: 'rate_limited', deferred: true,
      retryAt: new Date(retryAt).toISOString(), retryAfterMs: Math.max(0, retryAt - this.now()),
      message: 'Consulta snapshot aplazada por coordinación local; no se realizó una nueva solicitud ni se interpreta como ausencia de eventos.' });
  }
  async run<T>(name: Operation, action: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true });
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Recover only a dead owner's lock. An empty partially-written lock gets a grace period.
      const owner = Number(await readFile(lockPath, 'utf8').catch(() => ''));
      let dead = false;
      if (owner > 0 && Number.isSafeInteger(owner)) {
        try { process.kill(owner, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      } else { const info = await stat(lockPath).catch(() => undefined); dead = !!info && Date.now() - info.mtimeMs > 60000; }
      if (dead) {
        // Serialize stale-lock recovery too, so two restarters cannot remove a new owner's lock.
        let recovery;
        try { recovery = await open(`${lockPath}.reclaim`, 'wx', 0o600); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return this.defer(name, this.now() + 5000); }
        try {
          const current = Number(await readFile(lockPath, 'utf8').catch(() => ''));
          const info = await stat(lockPath).catch(() => undefined);
          let stillDead = !current && !!info && Date.now() - info.mtimeMs > 60000;
          if (current > 0 && Number.isSafeInteger(current)) {
            try { process.kill(current, 0); } catch (e) { stillDead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
          }
          if (stillDead) await rm(lockPath, { force: true });
        } finally { await recovery.close(); await rm(`${lockPath}.reclaim`, { force: true }); }
        return this.run(name, action);
      }
      return this.defer(name, this.now() + (this.options.spacingMs ?? 5000));
    }
    try {
      await lock.writeFile(String(process.pid)); await lock.close();
      let schedule: Schedule = { nextAt: 0, failures: {}, due: {} };
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8')) as Schedule;
        if (!Number.isFinite(saved.nextAt) || !saved.failures || !saved.due ||
            [...Object.values(saved.failures), ...Object.values(saved.due)].some(n => !Number.isFinite(n) || n < 0))
          throw new Error('Invalid snapshot schedule');
        schedule = saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const key = `${this.packageId}:${name}`;
      const due = Math.max(schedule.nextAt, schedule.due[key] || 0);
      if (due > this.now()) return this.defer(name, due);
      const save = async () => {
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(schedule), { mode: 0o600 }); await rename(temp, this.path);
      };
      // Persist reservation before the request, including process-crash recovery.
      schedule.nextAt = this.now() + (this.options.spacingMs ?? 5000);
      schedule.due[key] = this.now() + (this.options.refreshMs ?? 300000);
      await save();
      try {
        const result = await action();
        schedule.failures[key] = 0;
        schedule.nextAt = this.now() + (this.options.spacingMs ?? 5000);
        await save();
        return result;
      } catch (error) {
        if (error instanceof OperationError && error.diagnostic.category === 'rate_limited') {
          const attempts = (schedule.failures[key] || 0) + 1;
          schedule.failures[key] = attempts;
          const base = Math.min(1800000, 60000 * 2 ** Math.min(attempts - 1, 5));
          const wait = error.diagnostic.retryAfterMs ?? Math.ceil(base * (1 + (this.options.random?.() ?? Math.random()) * .1));
          const retryAt = this.now() + Math.max(1000, this.options.spacingMs ?? 5000, wait);
          schedule.nextAt = retryAt;
          schedule.due[key] = retryAt;
          await save();
          throw new OperationError({ ...error.diagnostic, deferred: false, retryAfterMs: Math.max(1000, this.options.spacingMs ?? 5000, wait),
            retryAt: new Date(retryAt).toISOString(), attempts });
        }
        // Non-429 failures are retried on the normal refresh interval, never in a tight loop.
        throw error;
      }
    } finally { await lock.close().catch(() => {}); await rm(lockPath, { force: true }); }
  }
}
