import assert from "node:assert/strict";
import { test } from "node:test";

import { createRemoteSessionStream } from "../remote-session-stream.js";

function scheduler() {
  const jobs = [];
  return { jobs, setTimeout(fn) { jobs.push(fn); return fn; }, clearTimeout(fn) { const index = jobs.indexOf(fn); if (index >= 0) jobs.splice(index, 1); }, async run() { const fn = jobs.shift(); if (fn) { fn(); await new Promise((resolve) => setTimeout(resolve, 0)); } } };
}

function response(body, status = 200) { return new Response(body, { status, headers: { "content-type": "text/event-stream" } }); }

test("resumes with matching query and Last-Event-ID and commits cursor after callback", async () => {
  const calls = [];
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const stream = createRemoteSessionStream({
    url: "https://example.test/events", cursor: 7,
    fetch: async (url, options) => { calls.push([url.toString(), options.headers.get("Last-Event-ID")]); return response(body); },
    onRecord(record) { assert.equal(stream.getCursor(), "7"); assert.equal(record.id, "8"); },
  });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.enqueue(new TextEncoder().encode("id: 8\ndata: {}\n\n"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [["https://example.test/events?afterCursor=7", "7"]]);
  assert.equal(stream.getCursor(), "8");
  stream.stop();
});

test("401 and 403 are permanent and do not reconnect", async () => {
  const timer = scheduler();
  let permanent = 0;
  const stream = createRemoteSessionStream({ url: "https://example.test/events", fetch: async () => response("", 401), setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, onPermanentError() { permanent += 1; } });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(permanent, 1);
  assert.equal(timer.jobs.length, 0);
});

test("410 and named session_closed surface closure", async () => {
  for (const result of [response("", 410), response("event: session_closed\ndata: {}\n\n")]) {
    let closed = 0;
    const stream = createRemoteSessionStream({ url: "https://example.test/events", fetch: async () => result, onClosed() { closed += 1; } });
    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, 1);
  }
});

test("starts polling only after bounded failures and never overlaps ticks", async () => {
  const timer = scheduler();
  let fetches = 0;
  let polls = 0;
  let release;
  const stream = createRemoteSessionStream({
    url: "https://example.test/events", maxFailures: 2, pollInterval: 1, random: () => 0,
    fetch: async () => { fetches += 1; throw new Error("offline"); }, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    onPoll: () => { polls += 1; return new Promise((resolve) => { release = resolve; }); },
  });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timer.jobs.length, 1);
  await timer.run();
  assert.equal(fetches, 2);
  assert.equal(timer.jobs.length, 2);
  await timer.run();
  assert.equal(polls, 1);
  assert.equal(timer.jobs.filter(Boolean).length, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timer.jobs.length, 2);
  stream.stop();
});

test("named snapshot_required invokes coalescible recovery without moving cursor", async () => {
  let recoveries = 0;
  const stream = createRemoteSessionStream({ url: "https://example.test/events", cursor: 4, fetch: async () => response("event: snapshot_required\ndata: {}\n\n"), onResync() { recoveries += 1; } });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recoveries, 1);
  assert.equal(stream.getCursor(), "4");
  stream.stop();
});
