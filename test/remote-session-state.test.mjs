import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRemoteSessionEvent, createRemoteSessionState, establishRemoteSnapshotBaseline, installRemoteSnapshot, RemoteStateError } from "../remote-session-state.js";

const scope = { controlSessionId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222", workspaceId: "workspace_1", sessionId: "session_1" };
const now = "2026-08-09T00:00:00.000Z";
const part = { type: "text", id: "part_1", text: "hello" };
const message = { id: "message_1", role: "assistant", createdAt: now, completedAt: null, parts: [part] };
const snapshot = { schemaVersion: 1, workspace: { id: scope.workspaceId, name: "Work" }, session: { id: scope.sessionId, workspaceId: scope.workspaceId, title: "Session", status: "idle", createdAt: now, updatedAt: now, activeRunId: null }, messages: [message], todos: [], interactions: [], capturedAt: now };

function event(sequence, cursor, data, overrides = {}) {
  return { schemaVersion: 1, payloadVersion: 1, eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, cursor, sequence, controlSessionId: scope.controlSessionId, deviceId: scope.deviceId, commandId: null, workspaceId: scope.workspaceId, sessionId: scope.sessionId, runId: null, occurredAt: now, data, ...overrides };
}

function installed() { return installRemoteSnapshot(createRemoteSessionState(scope), snapshot).state; }

test("installs a normalized snapshot with map and order models", () => {
  const result = installRemoteSnapshot(createRemoteSessionState(scope), snapshot);
  assert.equal(result.state.messages.get(message.id).parts[0].text, "hello");
  assert.deepEqual(result.state.messageOrder, [message.id]);
  assert.equal(result.effects[0].type, "snapshot");
});

test("dispatches by envelope.data.type and applies all collection handlers", () => {
  let state = installed();
  let result = applyRemoteSessionEvent(state, event(1, 10, { type: "message.part.upsert", messageId: message.id, part: { ...part, text: "updated" } }), "10");
  assert.equal(result.state.messages.get(message.id).parts[0].text, "updated");
  state = result.state;
  result = applyRemoteSessionEvent(state, event(2, 14, { type: "todos.replace", todos: [{ id: "todo_1", content: "Ship", status: "pending", priority: "high" }] }, { runId: "irrelevant_envelope_value" }), "14");
  assert.equal(result.state.todos.get("todo_1").content, "Ship");
  state = result.state;
  const interaction = { id: "interaction_1", sessionId: scope.sessionId, runId: null, status: "pending", title: "Permission", createdAt: now, expiresAt: null, type: "permission", description: "Use tool", permittedResponses: ["allow_once", "reject"], resolution: null };
  state = applyRemoteSessionEvent(state, event(3, 20, { type: "interaction.upsert", interaction }), "20").state;
  state = applyRemoteSessionEvent(state, event(4, 21, { type: "interaction.remove", interactionId: interaction.id }), "21").state;
  state = applyRemoteSessionEvent(state, event(5, 30, { type: "message.remove", messageId: message.id }), "30").state;
  assert.equal(state.messages.size, 0);
  assert.equal(state.interactions.size, 0);
});

test("requires exact immutable scope, matching SSE cursor, monotonic cursor and contiguous sequence", () => {
  const state = installed();
  assert.throws(() => applyRemoteSessionEvent(state, event(1, 1, { type: "message.remove", messageId: message.id }, { deviceId: "other" }), "1"), RemoteStateError);
  assert.throws(() => applyRemoteSessionEvent(state, event(1, 1, { type: "message.remove", messageId: message.id }), "2"), /cursor/);
  const first = applyRemoteSessionEvent(state, event(1, 5, { type: "message.remove", messageId: "none" }), "5").state;
  assert.throws(() => applyRemoteSessionEvent(first, event(2, 5, { type: "message.remove", messageId: "none" }), "5"), /cursor/);
  assert.throws(() => applyRemoteSessionEvent(first, event(3, 9, { type: "message.remove", messageId: "none" }), "9"), /sequence/);
});

test("duplicates are no-ops only when the immutable envelope is identical", () => {
  const original = event(1, 1, { type: "command.lifecycle", commandId: "command_1", status: "running" }, { commandId: "command_1" });
  const first = applyRemoteSessionEvent(installed(), original, "1");
  assert.strictEqual(applyRemoteSessionEvent(first.state, structuredClone(original), "1").state, first.state);
  assert.throws(() => applyRemoteSessionEvent(first.state, { ...original, occurredAt: "2026-08-09T00:00:01Z" }, "1"), /Conflicting/);
});

test("does not commit cursor or sequence when application fails", () => {
  const state = installed();
  assert.throws(() => applyRemoteSessionEvent(state, event(1, 4, { type: "message.part.upsert", messageId: "missing", part }), "4"), /parent/);
  assert.equal(state.cursor, null);
  assert.equal(state.sequence, 0);
  assert.throws(() => applyRemoteSessionEvent(state, event(1, 4, { type: "unknown" }), "4"), /Unknown/);
});

test("terminal status for an old run cannot clear a newer active run", () => {
  let state = installed();
  const newer = { workspaceId: scope.workspaceId, sessionId: scope.sessionId, runId: "run_new", status: "running" };
  state = applyRemoteSessionEvent(state, event(1, 1, { type: "session.status", status: "running", run: newer }, { runId: "run_new" }), "1").state;
  state = applyRemoteSessionEvent(state, event(2, 2, { type: "run.status", runId: "run_old", status: "completed", error: null }, { runId: "run_old" }), "2").state;
  assert.equal(state.activeRun.runId, "run_new");
  state = applyRemoteSessionEvent(state, event(3, 3, { type: "run.status", runId: "run_new", status: "completed", error: null }, { runId: "run_new" }), "3").state;
  assert.equal(state.activeRun, null);
});

test("snapshot_required returns recovery effect and malformed snapshots fail closed", () => {
  const result = applyRemoteSessionEvent(installed(), event(1, 1, { type: "snapshot_required", reason: "sequence_gap" }), "1");
  assert.deepEqual(result.effects, [{ type: "resync", reason: "sequence_gap" }]);
  assert.throws(() => installRemoteSnapshot(createRemoteSessionState(scope), { ...snapshot, extra: true }), /Malformed/);
  assert.throws(() => installRemoteSnapshot(createRemoteSessionState(scope), { ...snapshot, messages: [message, message] }), /Duplicate/);
});

test("establishes a trusted snapshot baseline at its exact terminal command lifecycle", () => {
  const boundary = event(7, 18, { type: "command.lifecycle", commandId: "snapshot_command", status: "succeeded" }, { commandId: "snapshot_command" });
  const result = establishRemoteSnapshotBaseline(createRemoteSessionState(scope), snapshot, boundary, "18", "snapshot_command");
  assert.equal(result.state.cursor, 18);
  assert.equal(result.state.sequence, 7);
  assert.equal(result.state.installed, true);
  const later = applyRemoteSessionEvent(result.state, event(8, 19, { type: "message.remove", messageId: "none" }), "19");
  assert.equal(later.state.sequence, 8);
  assert.throws(() => establishRemoteSnapshotBaseline(createRemoteSessionState(scope), snapshot, { ...boundary, commandId: "other" }, "18", "snapshot_command"), /boundary/);
});

test("accepts exact trimmed UTF-8 identifiers and rejects control or byte-oversize values", () => {
  assert.doesNotThrow(() => createRemoteSessionState({ ...scope, workspaceId: "工作区/alpha" }));
  assert.throws(() => createRemoteSessionState({ ...scope, workspaceId: " workspace" }), /scope/);
  assert.throws(() => createRemoteSessionState({ ...scope, workspaceId: "a\n" }), /scope/);
  assert.throws(() => createRemoteSessionState({ ...scope, workspaceId: "界".repeat(86) }), /scope/);
});
