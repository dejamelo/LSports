import { test } from "node:test";
import assert from "node:assert/strict";
import { homologationAdmission } from "../../../scripts/homologation-policy.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("staging consumer requires explicit capacity/cutover/cooldown gates and does not infer Mac shutdown", () => {
  const now = Date.parse("2026-10-18T22:00:00Z");
  const env = {
    ADL_CAPACITY_APPROVED: "yes",
    ADL_MAC_WORKER_STOPPED: "yes",
    ADL_SUPPLIER_NOT_BEFORE_UTC: "2026-10-18T22:00:00Z",
  };
  assert.equal(homologationAdmission({}, now).allowed, false);
  assert.equal(
    homologationAdmission({ ...env, ADL_MAC_WORKER_STOPPED: "no" }, now).reason,
    "mac_shutdown_not_confirmed",
  );
  assert.equal(
    homologationAdmission(
      { ...env, ADL_SUPPLIER_NOT_BEFORE_UTC: "2026-10-18T22:01:00Z" },
      now,
    ).reason,
    "supplier_cooldown_pending",
  );
  assert.equal(
    homologationAdmission(
      { ...env, ADL_SUPPLIER_NOT_BEFORE_UTC: "2026-02-30T22:00:00Z" },
      now,
    ).allowed,
    false,
  );
  assert.equal(homologationAdmission(env, now).allowed, true);
});
test("staging launcher exits before worker/provider imports when cutover is not acknowledged", async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/homologation-worker.ts"],
      { env: { ...process.env, ADL_CAPACITY_APPROVED: "no" } },
    );
    assert.fail("Must block");
  } catch (e) {
    assert.equal((e as { code: number }).code, 2);
    assert((e as { stderr: string }).stderr.includes("capacity_not_reviewed"));
  }
});

test("six-digit executor deadline reproduces exit 2 before provider imports; rounded millisecond barrier retains safety", async () => {
  const env={...process.env,ADL_CAPACITY_APPROVED:'yes',ADL_MAC_WORKER_STOPPED:'yes',ADL_SUPPLIER_NOT_BEFORE_UTC:'2026-01-01T00:00:00.000123Z'};
  await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','scripts/homologation-worker.ts'],{env}),error=>{
    const e=error as {code:number;stderr:string};
    assert.equal(e.code,2);assert.equal(JSON.parse(e.stderr.trim()).reason,'supplier_cooldown_not_confirmed');return true;
  });
  const repaired={...env,ADL_SUPPLIER_NOT_BEFORE_UTC:'2026-01-01T00:00:00.001Z'};
  assert.equal(homologationAdmission(repaired,Date.parse('2026-01-01T00:00:00.000Z')).reason,'supplier_cooldown_pending');
  assert.equal(homologationAdmission(repaired,Date.parse('2026-01-01T00:00:00.001Z')).allowed,true);
});
