import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Pure local capacity check. Does not load clients, consume messages or write state.
import { totalmem } from "node:os";
import {
  snapshotCapacity,
  snapshotMemory,
} from "../apps/worker/src/snapshot-capacity.js";
try {
  const initialNodeOptions = process.env.NODE_OPTIONS;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // loadEnvFile cannot change the running V8 heap. Re-exec once if .env supplied
  // startup options, preserving shell precedence and never printing their values.
  if (
    initialNodeOptions !== process.env.NODE_OPTIONS &&
    !process.argv.includes("--memory-env-applied")
  ) {
    const child = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--memory-env-applied",
      ],
      { env: process.env, stdio: "inherit" },
    );
    if (child.error) throw new Error("MEMORY_DIAGNOSTIC_START_FAILED");
    process.exit(child.status ?? 1);
  }
  const sample = snapshotMemory();
  const lanes = (["prematch", "inplay"] as const).map((lane) =>
    snapshotCapacity(process.env, sample, lane),
  );
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        supplierRequests: 0,
        writes: 0,
        process: "standalone_diagnostic_not_live_worker",
        nodeVersion: process.version,
        totalPhysicalBytes: totalmem(),
        lanes,
        note: "Live worker repeats the guard after restoring its state; this standalone result is indicative only.",
      },
      null,
      2,
    ),
  );
  if (lanes.some((lane) => !lane.allowed)) process.exitCode = 2;
} catch {
  console.error(
    JSON.stringify({
      readOnly: true,
      supplierRequests: 0,
      writes: 0,
      error: "MEMORY_CONFIG_NOT_READABLE_OR_INVALID",
      message: "Use integer lane caps from 1 to 256 MiB.",
    }),
  );
  process.exitCode = 1;
}
