import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import { statePath } from "@lsports/feed-store";
import {
  snapshotCapacity,
  snapshotMemory,
} from "../apps/worker/src/snapshot-capacity.js";
import { processMemoryReport } from "./process-memory-report.js";
try {
  try {
    process.loadEnvFile(".env");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let workerPid: number | undefined;
  // Bounded read; never acquire, reclaim or remove the worker lock.
  try {
    const file = await open(`${statePath()}.lock`, "r");
    try {
      const bytes = Buffer.alloc(64);
      const { bytesRead } = await file.read(bytes, 0, 64, 0);
      const text = bytes.subarray(0, bytesRead).toString().trim();
      if (/^\d{1,10}$/.test(text)) workerPid = Number(text);
    } finally {
      await file.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const result = await promisify(execFile)(
    "ps",
    ["-axo", "pid=,ppid=,rss=,comm="],
    { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  const memory = snapshotMemory();
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        supplierRequests: 0,
        writes: 0,
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        workerLockPid: workerPid ?? null,
        processes: processMemoryReport(result.stdout, workerPid),
        capacityComparisonOnly: ["prematch", "inplay"].map((l) =>
          snapshotCapacity(process.env, memory, l as "prematch" | "inplay"),
        ),
        note: "Collector heap is not worker heap. Use snapshotMemory from the worker diagnostic for actual admission.",
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    JSON.stringify({
      readOnly: true,
      supplierRequests: 0,
      writes: 0,
      error: "LOCAL_PROCESS_MEMORY_REPORT_UNAVAILABLE",
      message:
        "No process output, exceptions, paths, arguments or environment values printed.",
    }),
  );
  process.exitCode = 1;
}
