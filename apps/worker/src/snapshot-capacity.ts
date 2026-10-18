import { getHeapStatistics } from "node:v8";
export const MiB = 1024 * 1024;
/** Planning envelope, not a promise of a hard RSS limit: JSON + SDK conversion expands bytes. */
export function snapshotCapacity(
  env: NodeJS.ProcessEnv = process.env,
  headroom = Math.min(
    getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed,
    process.availableMemory?.() || Infinity,
  ),
) {
  const mb = Number(env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB || 128);
  if (!Number.isSafeInteger(mb) || mb < 1 || mb > 256)
    throw new Error("INVALID_SNAPSHOT_CAPACITY");
  const limitBytes = mb * MiB;
  const budgetBytes = limitBytes * 8 + 64 * MiB;
  return {
    limitBytes,
    budgetBytes,
    headroomBytes: Math.max(0, Math.floor(headroom)),
    allowed: headroom >= budgetBytes,
  };
}
