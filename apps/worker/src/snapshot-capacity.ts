import { getHeapStatistics } from "node:v8";
import type { Lane } from "@lsports/contracts";
export const MiB = 1024 * 1024;
export function snapshotMemory() {
  const heap = getHeapStatistics();
  return {
    heapLimitBytes: heap.heap_size_limit,
    heapUsedBytes: process.memoryUsage().heapUsed,
    availableMemoryBytes: process.availableMemory?.() ?? null,
  };
}
/** Estimate, not a hard RSS guarantee. Global legacy setting applies only to PreMatch. */
export function snapshotCapacity(
  env: NodeJS.ProcessEnv = process.env,
  input: number | ReturnType<typeof snapshotMemory> = snapshotMemory(),
  lane: Lane = "prematch",
) {
  const value =
    lane === "prematch"
      ? env.LSPORTS_PREMATCH_SNAPSHOT_MAX_RESPONSE_MB ||
        env.LSPORTS_SNAPSHOT_MAX_RESPONSE_MB ||
        128
      : env.LSPORTS_INPLAY_SNAPSHOT_MAX_RESPONSE_MB || 128;
  const mb = Number(value);
  if (!Number.isSafeInteger(mb) || mb < 1 || mb > 256)
    throw new Error("INVALID_SNAPSHOT_CAPACITY");
  const heapHeadroomBytes =
    typeof input === "number"
      ? input
      : Math.max(0, input.heapLimitBytes - input.heapUsedBytes);
  const availableMemoryBytes =
    typeof input === "number" ? null : input.availableMemoryBytes;
  const headroomBytes = Math.max(
    0,
    Math.floor(Math.min(heapHeadroomBytes, availableMemoryBytes ?? Infinity)),
  );
  const limitingFactor =
    availableMemoryBytes === null
      ? "heap_only"
      : heapHeadroomBytes === availableMemoryBytes
        ? "both"
        : heapHeadroomBytes < availableMemoryBytes
          ? "heap"
          : "available_memory";
  const memory = {
    heapLimitBytes: typeof input === "number" ? null : input.heapLimitBytes,
    heapUsedBytes: typeof input === "number" ? null : input.heapUsedBytes,
    heapHeadroomBytes,
    availableMemoryBytes,
    limitingFactor,
  } as const;
  const limitBytes = mb * MiB,
    budgetBytes = limitBytes * 8 + 64 * MiB;
  return {
    lane,
    limitBytes,
    budgetBytes,
    headroomBytes,
    memory,
    allowed: headroomBytes >= budgetBytes,
  };
}
