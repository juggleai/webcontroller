import assert from "node:assert/strict";
import { test } from "node:test";

import { consumeSSEStream, createSSEParser, SSELimitError } from "../sse.js";

const encode = (value) => new TextEncoder().encode(value);

test("parses LF, CRLF, CR, comments, optional spaces and multiline data", () => {
  const parser = createSSEParser();
  const records = parser.push(encode(": hi\rdata:first\r\ndata:  second\nevent: update\rid: 7\r\n\r\n"));
  assert.deepEqual(records, [{ type: "update", data: "first\n second", id: "7" }]);
});

test("handles arbitrary chunk and UTF-8 splits and flushes at EOF", () => {
  const bytes = encode("id: 9\ndata: 火箭\nevent: named");
  const parser = createSSEParser();
  const records = [];
  for (const byte of bytes) records.push(...parser.push(Uint8Array.of(byte)));
  records.push(...parser.finish());
  assert.deepEqual(records, [{ type: "named", data: "火箭", id: "9" }]);
});

test("blank records without data do not dispatch and NUL IDs are ignored", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push(encode("event: ignored\n\nid: valid\ndata: one\n\nid: bad\0id\ndata: two\n\n")), [
    { type: "message", data: "one", id: "valid" },
    { type: "message", data: "two", id: "valid" },
  ]);
});

test("bounds an unterminated or complete record slightly over 512 KiB", () => {
  const parser = createSSEParser({ maxRecordBytes: 540 * 1024 });
  assert.throws(() => parser.push(encode(`data: ${"x".repeat(541 * 1024)}`)), SSELimitError);
});

test("consumes a byte stream in record order", async () => {
  const chunks = [encode("data: a\n\n"), encode("event: end\ndata: b")];
  const stream = new ReadableStream({ pull(controller) { chunks.length ? controller.enqueue(chunks.shift()) : controller.close(); } });
  const records = [];
  await consumeSSEStream(stream, async (record) => records.push(record));
  assert.deepEqual(records.map((item) => [item.type, item.data]), [["message", "a"], ["end", "b"]]);
});
