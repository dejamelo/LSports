import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clients } from './provider.js';
import { OperationError } from './diagnostics.js';
import { TradeState } from './state.js';

// Synthetic protocol evidence; this is not a capture from the user's Mac.
test('HTTP 200 distinguishes missing/null/empty Body, alternate envelope, application errors and valid market recovery without leaking payload', async () => {
  let payload: unknown;
  let mime = 'application/json';
  let raw = false;
  let requests = 0;
  const secret = 'PRIVATE_PASSWORD_OR_PAYLOAD';
  const server = createServer(async (req, res) => {
    for await (const _ of req) {} requests++;
    res.setHeader('Content-Type', mime);
    res.end(raw ? payload as string : JSON.stringify(payload));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const api = clients({ lane: 'prematch', packageId: 4511, username: secret, password: secret,
      hostname: 'unused', vhost: 'StmPreMatch', queue: '_4511_', port: 5672, tls: false }, { snapshotUrl: url, customersUrl: url },
      { run: (_operation, action) => action() }); // isolated protocol test; production scheduler unchanged
    for (const [value, reason, bodyShape, errorCount] of [
      [{ Header: { HttpStatusCode: 200 } }, 'missing_response_body', 'missing', 0],
      [{ Header: { HttpStatusCode: 200 }, Body: null }, 'null_response_body', 'null', 0],
      [{ header: { status: 200 }, body: { secret } }, 'missing_response_header', 'missing', 0],
      [{ Header: { HttpStatusCode: 200 }, Body: {}, [secret]: secret }, 'invalid_snapshot', 'object', 0],
      [{ Header: { HttpStatusCode: 200, Errors: [{ Message: secret }] }, Body: null }, 'application_error', 'null', 1],
      [{ Header: { HttpStatusCode: 200, Errors: { Message: secret } }, Body: null }, 'application_error', 'null', 1],
      [{ Header: { HttpStatusCode: 200 }, Body: { Error: secret } }, 'application_error', 'object', 1],
    ] as const) {
      payload = value;
      await assert.rejects(() => api.outrightMarkets!(), error => {
        assert(error instanceof OperationError);
        const d = error.diagnostic;
        assert.equal(d.httpStatus, 200); assert.equal(d.reason, reason);
        assert.equal(d.responseInspection?.body, bodyShape);
        assert.equal(d.responseInspection?.applicationErrorItems, errorCount);
        assert(!JSON.stringify(error).includes(secret));
        return true;
      });
    }
    raw = true; mime = 'text/html'; payload = `<html>${secret}</html>`;
    await assert.rejects(() => api.outrightMarkets!(), error => {
      assert(error instanceof OperationError); assert.equal(error.diagnostic.reason, 'non_json_response');
      assert.equal(error.diagnostic.responseInspection?.contentType, 'html'); assert(!JSON.stringify(error).includes(secret)); return true;
    });
    payload = '';
    await assert.rejects(() => api.outrightMarkets!(), error => {
      assert(error instanceof OperationError); assert.equal(error.diagnostic.reason, 'empty_http_body'); return true;
    });
    raw = false; mime = 'application/json'; payload = { Header: { HttpStatusCode: 200, Errors: [] }, Body: [] };
    assert.deepEqual(await api.outrightMarkets!(), []);
    assert.equal(api.outrightResponseInspections?.()?.markets?.bodyEmptyArray, true);
    // Official envelope and complete entity validation, not HTTP status alone, permit recovery.
    payload = { Header: { HttpStatusCode: 200 }, Body: { Id: 90, Events: [{ FixtureId: 20540377, Markets: [{ Id: 160,
      Name: 'Synthetic Race Winner', Status: 1, Bets: [{ Id: '9223372036854775807', Price: '3.25', Status: 1 }] }] }] } };
    const recovered = await api.outrightMarkets!();
    const state = new TradeState();
    state.apply('prematch', [{ fixtureId: 20540377, outright: { competitionId: 90, fixture: { sport: { name: 'Horse Racing' }, status: 1,
      participants: [{ id: 1, name: 'Synthetic participant' }] } } }], Date.now() - 1000);
    state.apply('prematch', recovered, Date.now()); state.set('prematch', { phase: 'connected' });
    assert.equal(state.feed().events[0].selections[0].odds, 3.25);
    assert.equal(state.feed().events[0].selections[0].available, true);
    const inspection = api.outrightResponseInspections?.()?.markets;
    assert.equal(inspection?.marketRows, 1); assert.equal(inspection?.selectionRows, 1);
    assert.equal(requests, 11); // one request per explicit test input, no fallback retry
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('Header inspection reveals only allowed field types, bounded numeric codes, booleans and fixed semantic signals', async () => {
  const { inspectResponse } = await import('./response-inspection.js');
  const secret = 'PRIVATE_USERNAME_TOKEN_OR_URL';
  const summary = inspectResponse({ Header: { StatusCode: 400, ErrorCode: '1001', Success: false,
    Message: `Invalid fixture parameter; access denied ${secret}`, RequestId: secret,
    [secret]: secret, Password: secret }, Body: null }, 'application/json');
  assert.equal(summary.headerStatusType, 'missing');
  assert.equal(summary.headerFields?.StatusCode, 'number');
  assert.equal(summary.headerFields?.Message, 'string');
  assert.deepEqual(summary.headerCodes, { StatusCode: 400, ErrorCode: 1001 });
  assert.deepEqual(summary.headerFlags, { Success: false });
  assert.deepEqual(summary.headerMessageSignals, ['permission', 'invalid_parameter']);
  assert.equal(summary.headerOtherFieldCount, 2);
  assert.equal(summary.body, 'null');
  assert(!JSON.stringify(summary).includes(secret));
  assert(!JSON.stringify(summary).includes('Password'));
});
