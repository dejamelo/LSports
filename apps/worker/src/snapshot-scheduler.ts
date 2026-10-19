import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { statePath } from '@lsports/feed-store';
import { OperationError, describeFailure } from './diagnostics.js';
import type { Operation } from './diagnostics.js';
interface Schedule { requests?: Record<string, NonNullable<import('@lsports/contracts').IntegrationDiagnostic['coordinator']>>; lastRequest?: NonNullable<import('@lsports/contracts').IntegrationDiagnostic['coordinator']>; nextAt: number; failures: Record<string, number>; due: Record<string, number> }
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
  private defer(name: Operation, retryAt: number, rateLimitSource: "local_in_flight" | "local_host_cooldown" | "local_operation_cooldown" = "local_in_flight", coordinator?: Schedule["lastRequest"]): never {
    throw new OperationError({ operation: name, protocol: 'http', category: 'rate_limited', deferred: true, requesterPid:process.pid, rateLimitSource, coordinator,
      retryAt: new Date(retryAt).toISOString(), retryAfterMs: Math.max(0, retryAt - this.now()),
      message: 'Consulta snapshot aplazada por coordinación local; no se realizó una nueva solicitud ni se interpreta como ausencia de eventos.' });
  }
  async run<T>(name: Operation, action: () => Promise<T>, continuation?: {recoveryId:string;part:number}): Promise<T> {
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
        return this.run(name, action, continuation);
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
      const previous=schedule.requests?.[key];
      const ownSuccess=!!continuation&&previous?.recoveryId===continuation.recoveryId&&previous.outcome==='success'&&previous.partitionPart!==undefined&&continuation.part===previous.partitionPart+1;
      const due = Math.max(schedule.nextAt, ownSuccess?0:schedule.due[key] || 0);
      if (due > this.now()) return this.defer(name, due, !ownSuccess && (schedule.due[key] || 0) >= schedule.nextAt ? "local_operation_cooldown" : "local_host_cooldown", !ownSuccess && (schedule.due[key] || 0) >= schedule.nextAt ? schedule.requests?.[key] || schedule.lastRequest : schedule.lastRequest);
      const save = async () => {
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(schedule), { mode: 0o600 }); await rename(temp, this.path);
      };
      // Persist reservation before the request, including process-crash recovery.
      schedule.lastRequest = {packageId:this.packageId, operation:name, pid:process.pid, at:new Date(this.now()).toISOString(), outcome:"reserved",...(continuation?{recoveryId:continuation.recoveryId,partitionPart:continuation.part}:{})};
      (schedule.requests ||= {})[key] = schedule.lastRequest;
      schedule.nextAt = this.now() + (this.options.spacingMs ?? 5000);
      schedule.due[key] = this.now() + (this.options.refreshMs ?? 300000);
      await save();
      try {
        const result = await action();
        schedule.failures[key] = 0;
        schedule.lastRequest!.outcome = "success";
        schedule.lastRequest!.completedAt = new Date(this.now()).toISOString();
        schedule.nextAt = this.now() + (this.options.spacingMs ?? 5000);
        await save();
        return result;
      } catch (error) {
        if (error instanceof OperationError && error.diagnostic.category === 'rate_limited') {
          const attempts = (schedule.failures[key] || 0) + 1;
          schedule.failures[key] = attempts;
          schedule.lastRequest!.outcome = "rate_limited";
          schedule.lastRequest!.completedAt = new Date(this.now()).toISOString();
          const base = Math.min(1800000, 60000 * 2 ** Math.min(attempts - 1, 5));
          const wait = error.diagnostic.retryAfterMs ?? Math.ceil(base * (1 + (this.options.random?.() ?? Math.random()) * .1));
          const retryAt = this.now() + Math.max(1000, this.options.spacingMs ?? 5000, wait);
          schedule.nextAt = retryAt;
          schedule.due[key] = retryAt;
          await save();
          throw new OperationError({ ...error.diagnostic, deferred: false, requesterPid:process.pid, rateLimitSource: "supplier_http", coordinator: schedule.lastRequest, retryAfterMs: Math.max(1000, this.options.spacingMs ?? 5000, wait),
            retryAt: new Date(retryAt).toISOString(), attempts });
        }
        // A completed failure must not keep masquerading as an in-flight reservation.
        // Keep the full original cooldown; recording failure does not permit an early retry.
        const diagnostic = describeFailure(error, name, "http");
        const {category, reason, httpStatus, errorType, clientCode, networkCode, stage,responseLimitBytes,timeoutMs,memoryBudgetBytes,memoryHeadroomBytes,snapshotMemory} = diagnostic;
        schedule.lastRequest!.outcome = "failed";
        schedule.lastRequest!.completedAt = new Date(this.now()).toISOString();
        schedule.lastRequest!.failure = {category,reason,httpStatus,errorType,clientCode,networkCode,stage,responseLimitBytes,timeoutMs,memoryBudgetBytes,memoryHeadroomBytes,snapshotMemory};
        await save();
        throw new OperationError({...diagnostic, retryAt:new Date(schedule.due[key]).toISOString(), requesterPid:process.pid, coordinator:schedule.lastRequest});
      }
    } finally { await lock.close().catch(() => {}); await rm(lockPath, { force: true }); }
  }
}
