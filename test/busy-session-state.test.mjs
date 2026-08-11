import assert from "node:assert/strict";
import { test } from "node:test";
import { busyModeAvailability, createPendingEnqueueState, isDefinitiveEnqueueOutcome, prepareEnqueueSubmission, resolveBusyMode, validRemotePrompt } from "../busy-session-state.js";

const scope = {
  serverOrigin: "https://work.example",
  accountId: "account-1",
  organizationId: "org-1",
  deviceId: "device-1",
  workspaceId: "ws",
  sessionId: "ses",
};

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("busy modes use the currently selected device feature advertisement", () => {
  const steer = { capabilities: { features: ["session.steer"] } };
  const enqueue = { capabilities: { features: ["session.enqueue"] } };
  assert.deepEqual(busyModeAvailability(steer), { reject: true, steer: true, enqueue: false });
  assert.equal(resolveBusyMode("steer", steer), "steer");
  assert.equal(resolveBusyMode("enqueue", steer), "reject");
  assert.equal(resolveBusyMode("enqueue", enqueue), "enqueue");
});

test("pending enqueue handles are bounded and fenced by control scope", () => {
  const state = createPendingEnqueueState(2);
  state.setScope(scope);
  state.add({ id: "one", mode: "enqueue", position: 1, status: "pending" });
  state.add({ id: "two", mode: "enqueue", position: 2, status: "pending" });
  state.add({ id: "three", mode: "enqueue", position: 3, status: "pending" });
  assert.deepEqual(state.list().map((item) => item.id), ["two", "three"]);
  state.remove("two");
  assert.deepEqual(state.list().map((item) => item.id), ["three"]);
  state.setScope(scope);
  assert.deepEqual(state.list().map((item) => item.id), ["three"]);
  state.setScope({ ...scope, deviceId: "device-2" });
  assert.deepEqual(state.list(), []);
  state.setScope(null);
  assert.deepEqual(state.list(), []);
});

test("persists scoped enqueue attempts and resumes command identity without prompt or credentials", () => {
  const storage = memoryStorage();
  const first = createPendingEnqueueState(2, storage);
  first.setScope(scope);
  first.beginAttempt({ idempotencyKey: "attempt-1", controlSessionId: "control-1", commandId: null, createdAt: 1 });
  first.setAttemptCommand("command-1", "control-1");
  first.add({ id: "pending-1", mode: "enqueue", position: 1, status: "pending" });

  const persisted = [...storage.values.values()].join("\n");
  assert.doesNotMatch(persisted, /prompt|password|token|authorization|secret/i);

  const reloaded = createPendingEnqueueState(2, storage);
  assert.equal(reloaded.fenceAuthentication({ serverOrigin: scope.serverOrigin, accountId: scope.accountId, organizationId: scope.organizationId }), true);
  reloaded.setScope(scope);
  assert.deepEqual(reloaded.attempt(), {
    idempotencyKey: "attempt-1",
    controlSessionId: "control-1",
    commandId: "command-1",
    createdAt: 1,
  });
  assert.deepEqual(reloaded.list().map((item) => item.id), ["pending-1"]);
  assert.strictEqual(reloaded.beginAttempt({ idempotencyKey: "new-key", controlSessionId: "control-2", createdAt: 2 }), reloaded.attempt());
});

test("prepares retries with the original key and resumes a known command after reload or timeout", () => {
  const unknownCommand = prepareEnqueueSubmission({
    idempotencyKey: "attempt-1",
    controlSessionId: "control-1",
    commandId: null,
    createdAt: 1,
  }, { createKey: () => "must-not-run", controlSessionId: "new-control" });
  assert.equal(unknownCommand.idempotencyKey, "attempt-1");
  assert.equal(unknownCommand.resume, null);
  assert.equal(unknownCommand.attempt, null);

  const knownCommand = prepareEnqueueSubmission({
    idempotencyKey: "attempt-1",
    controlSessionId: "control-1",
    commandId: "command-1",
    createdAt: 1,
  }, { createKey: () => "must-not-run", controlSessionId: "new-control" });
  assert.equal(knownCommand.idempotencyKey, "attempt-1");
  assert.deepEqual(knownCommand.resume, { commandId: "command-1", controlSessionId: "control-1" });

  const fresh = prepareEnqueueSubmission(null, { createKey: () => "attempt-2", controlSessionId: "control-2", now: () => 2 });
  assert.deepEqual(fresh, {
    idempotencyKey: "attempt-2",
    resume: null,
    attempt: { idempotencyKey: "attempt-2", controlSessionId: "control-2", commandId: null, createdAt: 2 },
  });
});

test("clears operational storage on logout and authenticated or controller scope changes", () => {
  for (const change of [
    { authentication: { serverOrigin: scope.serverOrigin, accountId: "account-2", organizationId: scope.organizationId } },
    { authentication: { serverOrigin: scope.serverOrigin, accountId: scope.accountId, organizationId: "org-2" } },
    { authentication: { serverOrigin: "https://other.example", accountId: scope.accountId, organizationId: scope.organizationId } },
    { selectedScope: { ...scope, deviceId: "device-2" } },
    { selectedScope: { ...scope, workspaceId: "other-ws" } },
    { selectedScope: { ...scope, sessionId: "other-session" } },
  ]) {
    const storage = memoryStorage();
    const state = createPendingEnqueueState(2, storage);
    state.setScope(scope);
    state.add({ id: "pending-1", mode: "enqueue", position: 1, status: "pending" });
    state.beginAttempt({ idempotencyKey: "attempt-1", controlSessionId: "control-1", commandId: null, createdAt: 1 });
    if (change.authentication) state.fenceAuthentication(change.authentication);
    else state.setScope(change.selectedScope);
    assert.equal(storage.values.size, 0);
    assert.deepEqual(state.list(), []);
    assert.equal(state.attempt(), null);
  }

  const storage = memoryStorage();
  const state = createPendingEnqueueState(2, storage);
  state.setScope(scope);
  state.beginAttempt({ idempotencyKey: "attempt-1", controlSessionId: "control-1", commandId: null, createdAt: 1 });
  state.clear();
  assert.equal(storage.values.size, 0);
});

test("fails closed on malformed persisted operational metadata", () => {
  const storage = memoryStorage({
    "jugglework.desktop.pending-enqueues.v1": JSON.stringify({
      schemaVersion: 1,
      scope,
      handles: [{ id: "pending-1", mode: "enqueue", position: 1, status: "pending", prompt: "must not persist" }],
    }),
  });
  const state = createPendingEnqueueState(2, storage);
  state.setScope(scope);
  assert.deepEqual(state.list(), []);
  assert.equal(storage.values.size, 0);
});

test("classifies every accepted, non-enqueued, and terminal enqueue outcome as definitive", () => {
  for (const disposition of ["started", "steered", "enqueued"]) {
    assert.equal(isDefinitiveEnqueueOutcome({ result: { disposition } }), true);
  }
  assert.equal(isDefinitiveEnqueueOutcome({ error: { safeTerminal: true } }), true);
  assert.equal(isDefinitiveEnqueueOutcome({ error: { definitiveNonEnqueued: true } }), true);
  assert.equal(isDefinitiveEnqueueOutcome({ error: { ambiguousMutation: true } }), false);
});

test("remote prompt validation uses the 200000 UTF-8 byte boundary", () => {
  assert.equal(validRemotePrompt("x".repeat(200_000)), true);
  assert.equal(validRemotePrompt("x".repeat(200_001)), false);
  assert.equal(validRemotePrompt("界".repeat(66_667)), false);
  assert.equal(validRemotePrompt("   "), false);
});
