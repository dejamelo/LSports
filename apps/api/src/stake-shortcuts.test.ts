import { test } from "node:test";
import assert from "node:assert/strict";
import { returnMinor, majorToMinor, type Currency } from "@lsports/contracts";
import {
  minorInput,
  stakeShortcuts,
  type StakeLimits,
} from "../../web/src/stake-limits.js";
const limits: StakeLimits = {
  minStakeMinor: "100",
  maxStakeMinor: "10000",
  maxReturnMinor: "20000",
  allowRepeatedTickets: true,
  maxTicketsPerPlayerEvent: 3,
  maxStakePerPlayerEventMinor: "15000",
  sameEventMultiples: "blocked",
};
test("stake shortcuts stay within exact operation and potential-return bounds including narrow ranges and correlated odds products", () => {
  for (const odds of [[0], [NaN], [Infinity], [1.5]])
    assert.deepEqual(stakeShortcuts(limits, odds), []);
  assert.deepEqual(stakeShortcuts(limits, [2100000]), ["100", "1000", "5000"]);
  assert.deepEqual(
    stakeShortcuts({ ...limits, maxStakeMinor: "200" }, [2100000]),
    ["100", "200"],
  );
  assert.deepEqual(
    stakeShortcuts({ ...limits, maxReturnMinor: "1000" }, [2100000]),
    ["100", "476"],
  );
  assert.deepEqual(
    stakeShortcuts({ ...limits, maxReturnMinor: "1" }, [2100000]),
    [],
  );
  assert.deepEqual(
    stakeShortcuts({ ...limits, minStakeMinor: "20000" }, [2100000]),
    [],
  );
  for (const odds of [[2100000], [3500000], [2100000, 3500000]])
    for (const value of stakeShortcuts(limits, odds)) {
      assert(BigInt(value) >= BigInt(limits.minStakeMinor));
      assert(BigInt(value) <= BigInt(limits.maxStakeMinor));
      assert(BigInt(returnMinor(value, odds)) <= BigInt(limits.maxReturnMinor));
    }
});
test("shortcut input preserves exact currency precision for ARS CLP PYG USD VES", () => {
  for (const code of ["ARS", "CLP", "PYG", "USD", "VES"] as Currency[])
    for (const value of ["1", "100", "9007199254740991"])
      assert.equal(majorToMinor(minorInput(value, code), code), value);
  assert.equal(minorInput("100", "ARS"), "1.00");
  assert.equal(minorInput("100", "CLP"), "100");
  assert.equal(minorInput("100", "PYG"), "100");
});
