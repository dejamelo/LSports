import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { root } from "@lsports/feed-store";
test("UTC contract diagnostic reports affected IDs without replay, locks, ticket access or checkpoint writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adl-readonly-utc-"));
  const path = join(directory, "feed.json"),
    tickets = join(directory, "tickets.sqlite");
  const raw = "2026-10-18T14:39:04.0173136";
  const saved = {
    workerCheckpoint: {
      outright: [
        {
          lane: "prematch",
          fixtureId: 20545283,
          betAt: [["160:1", Date.parse("2026-10-18T17:39:04.017Z")]],
          settlementAudit: [
            [
              "160:1",
              {
                lastSnapshot: {
                  versionAt: "2026-10-18T17:39:04.017Z",
                  decision: "stored",
                  timestamp: { rawLastUpdate: raw },
                },
              },
            ],
          ],
          deferredTimestampBets: [
            ["160:2", { inspection: { rawLastUpdate: raw } }],
          ],
        },
      ],
    },
  };
  await writeFile(path, JSON.stringify(saved));
  await writeFile(tickets, "do not open");
  try {
    const before = await readFile(path),
      beforeTickets = await readFile(tickets);
    const output = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/diagnose-utc-contract.ts"],
      { cwd: root, env: { ...process.env, LSPORTS_STATE_FILE: path } },
    );
    const result = JSON.parse(output.stdout);
    assert.equal(result.readOnly, true);
    assert.equal(result.writes, 0);
    assert.equal(result.ticketsOpened, false);
    assert.equal(result.items[0].fixtureId, 20545283);
    assert.equal(result.items[0].historicalConversionMatches, false);
    assert.equal(result.items[1].source, "saved_quarantine");
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readFile(tickets), beforeTickets);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
