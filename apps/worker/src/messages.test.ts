import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { decodeMessage } from "./messages.js";
import { OperationError } from "./diagnostics.js";
const at = 1700000000000;
const headers = { MessageGuid: "test", MessageType: "3", timestamp_in_ms: at };
const body = {
  Events: [
    {
      FixtureId: 123,
      Markets: [
        {
          Id: 1,
          Status: 1,
          Bets: [
            { Id: "9223372036854775807", Name: "1", Price: "2.1", Status: 1 },
          ],
        },
      ],
    },
  ],
};
const wire = (
  type = 3,
  value: unknown = body,
  header: Record<string, unknown> = {},
) =>
  Buffer.from(
    JSON.stringify({
      Header: { Type: type, MsgGuid: "test", ...header },
      Body: value,
    }),
  );
function failure(action: () => unknown, reason: string) {
  assert.throws(action, (error) => {
    assert(error instanceof OperationError);
    assert.equal(error.diagnostic.operation, "feed.decode");
    assert.equal(error.diagnostic.reason, reason);
    assert(error.diagnostic.messageMetadata);
    return true;
  });
}
test("official envelopes decode entities, keep large IDs, and normalize BOM and properties without exposing content", () => {
  const decoded = decodeMessage(
    Buffer.concat([Buffer.from([239, 187, 191]), wire()]),
    headers,
    {
      contentType: "application/json; charset=utf-8",
      contentEncoding: "utf-8",
    },
  );
  assert.equal(
    decoded.events[0].markets?.[0].bets?.[0].id,
    "9223372036854775807",
  );
  assert.equal(decoded.metadata.messageTypeName, "MarketUpdate");
  assert.equal(decoded.metadata.compression, "none");
  assert.equal(decoded.metadata.eventCount, 1);
  for (const [type, value] of [
    [1, { Events: [{ FixtureId: 123, Fixture: { Status: 1 } }] }],
    [
      2,
      {
        Events: [{ FixtureId: 123, Livescore: { Scoreboard: { Status: 2 } } }],
      },
    ],
    [35, body],
  ] as const)
    assert.equal(
      decodeMessage(wire(type, value), {
        ...headers,
        MessageType: String(type),
      }).events.length,
      1,
    );
});
test("gzip, zlib deflate, brotli and gzip magic are handled with bounded output", () => {
  for (const [compress, encoding] of [
    [gzipSync, "gzip"],
    [deflateSync, "deflate"],
    [brotliCompressSync, "br"],
  ] as const) {
    const input = compress(wire());
    const d = decodeMessage(input, headers, {
      contentType: "application/octet-stream",
      contentEncoding: encoding,
    });
    assert.equal(d.events.length, 1);
    assert.equal(d.metadata.decodedBytes, wire().length);
    assert.equal(d.metadata.compression, encoding);
  }
  const auto = decodeMessage(gzipSync(wire()), headers);
  assert(auto.metadata.warnings?.includes("compression_detected_by_signature"));
  failure(
    () =>
      decodeMessage(Buffer.from("not compressed"), headers, {
        contentEncoding: "gzip",
      }),
    "decompression_failed",
  );
  failure(
    () =>
      decodeMessage(
        gzipSync(wire()),
        headers,
        { contentEncoding: "gzip" },
        false,
        { wireBytes: 10000, decodedBytes: 16 },
      ),
    "message_too_large",
  );
  failure(
    () =>
      decodeMessage(wire(), headers, {}, false, {
        wireBytes: 1,
        decodedBytes: 10000,
      }),
    "message_too_large",
  );
});
test("absent AMQP headers use explicit official envelope metadata; event updates never invent supplier timestamps", () => {
  const d = decodeMessage(
    wire(3, body, { CreationDate: "2023-11-14T22:13:20.000Z" }),
  );
  assert.equal(d.at, at);
  assert.equal(d.metadata.timestampSource, "creation_date");
  assert.equal(d.metadata.guidSource, "envelope");
  assert.equal(
    decodeMessage(
      wire(),
      { MessageGuid: "test", MessageType: "3" },
      { timestamp: at / 1000 },
    ).metadata.timestampSource,
    "amqp_timestamp",
  );
  failure(() => decodeMessage(wire()), "missing_timestamp");
  failure(
    () =>
      decodeMessage(
        Buffer.from(JSON.stringify({ Header: { Type: 3 }, Body: body })),
        { timestamp_in_ms: at },
      ),
    "invalid_message_headers",
  );
});
test("heartbeat and keepalive accept absent/null bodies, ID and timestamp only for control messages", () => {
  for (const type of [31, 32]) {
    const d = decodeMessage(
      Buffer.from(JSON.stringify({ Header: { Type: type } })),
    );
    assert.equal(d.events.length, 0);
    assert.equal(d.metadata.timestampSource, "received_control");
    assert.equal(d.metadata.guidSource, "control_fingerprint");
  }
  const interrupted = decodeMessage(wire(32, { FeedInterrupted: [1] }));
  assert.equal(interrupted.interrupted, true);
  failure(
    () => decodeMessage(wire(32, { FeedInterrupted: "secret" })),
    "invalid_event_body",
  );
  assert.equal(decodeMessage(wire(31, null)).events.length, 0);
});
test("malformed JSON, UTF8, envelope, entity and unsupported type have distinct sanitized errors", () => {
  const secret = randomUUID();
  const unknownMime = decodeMessage(wire(), headers, { contentType: secret });
  assert(unknownMime.metadata.warnings?.includes("unrecognized_content_type"));
  assert(!JSON.stringify(unknownMime.metadata).includes(secret));
  for (const [action, reason] of [
    [() => decodeMessage(Buffer.from(secret), headers), "invalid_json"],
    [() => decodeMessage(Buffer.from([0xff, 0xfe]), headers), "invalid_utf8"],
    [() => decodeMessage(Buffer.from("[]"), headers), "invalid_envelope"],
    [() => decodeMessage(wire(3, {}), headers), "invalid_event_body"],
    [() => decodeMessage(wire(37, {}), headers), "unsupported_message_type"],
    [() => decodeMessage(wire(999, {}), headers), "unsupported_message_type"],
    [
      () => decodeMessage(wire(), headers, { contentEncoding: secret }),
      "unsupported_content_encoding",
    ],
    [
      () =>
        decodeMessage(wire(), headers, {
          contentType: "application/json;charset=utf-16",
        }),
      "unsupported_content_encoding",
    ],
    [
      () =>
        decodeMessage(
          wire(3, {
            Events: [
              { FixtureId: 123, Markets: [{ Id: 1, Bets: [{ Id: secret }] }] },
            ],
          }),
          headers,
        ),
      "entity_conversion",
    ],
  ] as const) {
    assert.throws(action, (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.diagnostic.reason, reason);
      const output = JSON.stringify(error.diagnostic);
      assert(!output.includes(secret));
      assert(!output.includes('"Body"'));
      assert(!output.includes("9223372036854775807"));
      return true;
    });
  }
});
