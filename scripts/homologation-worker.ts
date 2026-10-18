// Deliberately no provider imports before operational gates and memory admission.
import { snapshotCapacity } from "../apps/worker/src/snapshot-capacity.js";
import { homologationAdmission } from "./homologation-policy.js";
const admission = homologationAdmission(process.env);
if (!admission.allowed) {
  console.error(
    JSON.stringify({
      operation: "homologation.admission",
      status: "blocked",
      reason: admission.reason,
    }),
  );
  process.exitCode = 2;
} else {
  try {
    const lanes = (["prematch", "inplay"] as const).map((l) =>
      snapshotCapacity(process.env, undefined, l),
    );
    if (lanes.some((l) => !l.allowed)) {
      console.error(
        JSON.stringify({
          operation: "homologation.preflight",
          status: "blocked",
          reason: "memory_budget_exceeded",
          lanes,
        }),
      );
      process.exitCode = 2;
    } else await import("../apps/worker/src/index.js");
  } catch {
    console.error(
      "ADL worker preflight failed; no credentials or raw exceptions printed.",
    );
    process.exitCode = 1;
  }
}
