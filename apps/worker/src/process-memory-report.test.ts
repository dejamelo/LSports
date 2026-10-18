import { test } from "node:test";
import assert from "node:assert/strict";
import { processMemoryReport } from "../../../scripts/process-memory-report.js";
test("process memory report preserves RSS/PIDs but removes command arguments, private paths and unknown executable names", () => {
  const report = processMemoryReport(
    " 15 1 1000 /private/user/secret-binary\n 16 1 900 /usr/local/bin/node\n 17 1 2000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 18 1 400 node --token=private-token\n",
    16,
    15,
  );
  assert.equal(report.worker?.pid, 16);
  assert.equal(report.worker?.rssBytes, 900 * 1024);
  assert.equal(report.topProcesses[0].category, "chrome_or_chromium");
  assert.equal(report.processCount, 4);
  assert(!JSON.stringify(report).includes("private"));
  assert(!JSON.stringify(report).includes("token"));
  assert(!JSON.stringify(report).includes("/Applications"));
});
