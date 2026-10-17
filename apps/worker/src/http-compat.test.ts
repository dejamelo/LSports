import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketRequestBody } from './http-compat.js';
test('ticket 217525 market wire body uses userName, password, packageId 4511 and fixture array without mutating SDK input', () => {
  const input = { username: 'synthetic-user', password: 'synthetic-secret', packageId: 4511, fixtures: [20540377] };
  const output = marketRequestBody(JSON.stringify(input));
  assert.equal(typeof output, 'string');
  assert.deepEqual(JSON.parse(output as string), { userName: 'synthetic-user', password: 'synthetic-secret', packageId: 4511, fixtures: [20540377] });
  assert.equal(input.username, 'synthetic-user');
  assert.equal((marketRequestBody(input) as Record<string, unknown>).username, undefined);
  assert.deepEqual((marketRequestBody({ ...input, fixtures: undefined }) as Record<string, unknown>).fixtures, []);
  for (const fixtures of ['20540377', [0], [-1], [1.5], ['20540377']]) {
    assert.throws(() => marketRequestBody({ ...input, fixtures }), error => {
      assert(!String(error).includes(input.username)); assert(!String(error).includes(input.password)); return true;
    });
  }
});
