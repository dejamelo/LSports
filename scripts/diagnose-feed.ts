// Local file only; deliberately avoids provider clients, API/ticket stores and migrations.
import { readFile } from "node:fs/promises";
import { statePath } from "@lsports/feed-store";
import {
  feedEvidence,
  supportFeedMessage,
} from "../apps/api/src/feed-evidence.js";
try {
  const saved = JSON.parse(await readFile(statePath(), "utf8"));
  if (saved.mode !== "connected" || !Array.isArray(saved.events))
    throw new Error("INVALID_FEED");
  const { workerCheckpoint: _privateCheckpoint, ...feed } = saved;
  const report = feedEvidence(feed);
  console.log(
    process.argv.includes("--support")
      ? supportFeedMessage(report)
      : JSON.stringify(report, null, 2),
  );
} catch {
  console.error(
    JSON.stringify({
      readOnly: true,
      writes: 0,
      supplierRequests: 0,
      code: "LOCAL_FEED_NOT_READABLE_OR_INVALID",
      message: "No se imprimen excepciones ni contenido del archivo.",
    }),
  );
  process.exitCode = 1;
}
