import assert from "node:assert/strict";
import { test } from "node:test";

import { createWebControllerServer } from "../server.mjs";

test("serves the diagnostic page with restrictive browser headers", async (context) => {
  const server = createWebControllerServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  const page = await response.text();
  assert.match(page, /远程控制诊断台/);
  assert.match(page, /data-operation="session\.create"/);
  assert.match(page, /id="createSessionForm"/);
  assert.doesNotMatch(page, /id="sessionTitleInput"[^>]*maxlength=/);
  assert.match(page, /Maximum 120 Unicode code points/);
  assert.doesNotMatch(page, /id="createSessionForm"[\s\S]*name="prompt"/);
});

test("exposes a local health endpoint and rejects unknown files", async (context) => {
  const server = createWebControllerServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ready" });
  assert.equal((await fetch(`${base}/private.txt`)).status, 404);
});

test("serves the DOM-free remote control modules", async (context) => {
  const server = createWebControllerServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  for (const asset of ["sse.js", "remote-session-state.js", "remote-session-stream.js", "control-session-renewal.js", "remote-notifications.js", "remote-e2ee.js", "e2ee-negotiation.js", "remote-e2ee-envelope.js", "session-creation.js", "busy-session-state.js"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
  }
});
