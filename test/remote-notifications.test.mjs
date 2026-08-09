import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBrowserNotificationController,
  notificationCopy,
  notificationForDeviceTransition,
  notificationForRemoteEvent,
  notificationForStreamTransition,
} from "../remote-notifications.js";
import { applyRemoteSessionEvent, createRemoteSessionState, installRemoteSnapshot } from "../remote-session-state.js";

const now = "2026-08-09T00:00:00.000Z";
const scope = { controlSessionId: "control_1", deviceId: "device_1", workspaceId: "workspace_1", sessionId: "session_1" };
const snapshot = {
  schemaVersion: 1,
  workspace: { id: scope.workspaceId, name: "Work" },
  session: { id: scope.sessionId, workspaceId: scope.workspaceId, title: "Session", status: "running", createdAt: now, updatedAt: now, activeRunId: "run_1" },
  messages: [], todos: [], interactions: [], capturedAt: now,
};

function envelope(sequence, data, overrides = {}) {
  return {
    schemaVersion: 1, payloadVersion: 1, eventId: `event_${sequence}`, cursor: sequence, sequence,
    controlSessionId: scope.controlSessionId, deviceId: scope.deviceId, commandId: null,
    workspaceId: scope.workspaceId, sessionId: scope.sessionId, runId: null, occurredAt: now,
    data, ...overrides,
  };
}

function apply(previous, event) {
  const result = applyRemoteSessionEvent(previous, event, String(event.cursor));
  return { result, signal: notificationForRemoteEvent(previous, result.state, event, result.effects) };
}

test("classifies only supported waiting, terminal, disconnect, closure and device transitions", () => {
  let state = installRemoteSnapshot(createRemoteSessionState(scope), snapshot).state;
  const interaction = { id: "interaction_1", sessionId: scope.sessionId, runId: "run_1", status: "pending", title: "secret prompt", createdAt: now, expiresAt: null, type: "permission", description: "/private/path", permittedResponses: ["allow_once", "reject"], resolution: null };
  let applied = apply(state, envelope(1, { type: "interaction.upsert", interaction }, { runId: "run_1" }));
  assert.equal(applied.signal.category, "interaction_waiting");
  state = applied.result.state;
  applied = apply(state, envelope(2, { type: "interaction.upsert", interaction }, { runId: "run_1" }));
  assert.equal(applied.signal, null);
  state = applied.result.state;
  for (const [index, status, category] of [[3, "completed", "run_completed"], [4, "failed", "run_failed"], [5, "aborted", "run_aborted"]]) {
    applied = apply(state, envelope(index, { type: "run.status", runId: `run_${index}`, status, error: status === "failed" ? { schemaVersion: 1, code: "secret_error", message: "raw secret", retryable: false, correlationId: null } : null }, { runId: `run_${index}` }));
    assert.equal(applied.signal.category, category);
    state = applied.result.state;
  }
  assert.equal(notificationForStreamTransition("LIVE", "RECONNECTING", { active: true, controlSessionId: "control_1", transitionId: 1 }).category, "session_disconnected");
  assert.equal(notificationForStreamTransition("CONNECTING", "CLOSED", { active: true, closed: true, controlSessionId: "control_1" }).category, "session_closed");
  const online = { id: "device_1", enrollmentStatus: "enrolled", presence: "online", localControlEnabled: true, connectionGeneration: 1 };
  assert.equal(notificationForDeviceTransition(online, { ...online, enrollmentStatus: "revoked", presence: "offline", localControlEnabled: false, revokedAt: now }, { active: true }).category, "device_revoked");
  assert.equal(notificationForDeviceTransition(online, { ...online, presence: "stale", lastSeenAt: now }, { active: true }).category, "device_unavailable");
  assert.equal(notificationForDeviceTransition(online, undefined, { active: true }).category, "device_unavailable");
});

test("notification copy is fixed and never includes actor content, payloads, errors or identifiers", () => {
  const created = [];
  class FakeNotification {
    static permission = "granted";
    constructor(title, options) { created.push({ title, ...options }); }
  }
  const controller = createBrowserNotificationController({ notificationApi: FakeNotification });
  const categories = ["interaction_waiting", "run_completed", "run_failed", "run_aborted", "session_disconnected", "session_closed", "device_revoked", "device_unavailable"];
  for (const category of categories) controller.notify({
    category,
    identity: `event:${category}:credential_jws_secret`,
    title: "injected prompt",
    body: "transcript /Users/private token=jws_secret raw error",
    payload: { authorization: "Bearer secret" },
  });
  assert.deepEqual(created, categories.map(notificationCopy));
  assert.doesNotMatch(JSON.stringify(created), /injected|transcript|Users|token|secret|credential|authorization/i);
});

test("fails closed when notifications are unsupported or denied and requests permission only explicitly", async () => {
  const unsupported = createBrowserNotificationController({ notificationApi: undefined });
  assert.equal(unsupported.permission(), "unsupported");
  assert.equal(await unsupported.requestPermission(), "unsupported");
  assert.equal(unsupported.notify({ category: "run_completed", identity: "one" }), false);

  let requests = 0;
  class DeniedNotification {
    static permission = "denied";
    static requestPermission() { requests += 1; return Promise.resolve("granted"); }
  }
  const denied = createBrowserNotificationController({ notificationApi: DeniedNotification });
  assert.equal(await denied.requestPermission(), "denied");
  assert.equal(requests, 0);
  assert.equal(denied.notify({ category: "run_completed", identity: "two" }), false);

  class PromptedNotification {
    static permission = "default";
    static requestPermission() { requests += 1; PromptedNotification.permission = "granted"; return Promise.resolve("granted"); }
    constructor() {}
  }
  const prompted = createBrowserNotificationController({ notificationApi: PromptedNotification });
  assert.equal(requests, 0);
  assert.equal(prompted.notify({ category: "run_completed", identity: "three" }), false);
  assert.equal(await prompted.requestPermission(), "granted");
  assert.equal(requests, 1);
  assert.equal(prompted.notify({ category: "run_completed", identity: "three" }), true);
});

test("deduplicates stable identities and notification clicks only focus the current view", () => {
  const created = [];
  let focused = 0;
  class FakeNotification {
    static permission = "granted";
    constructor(title, options) { this.title = title; this.options = options; created.push(this); }
    close() { this.closed = true; }
  }
  const controller = createBrowserNotificationController({ notificationApi: FakeNotification, focus: () => { focused += 1; } });
  const candidate = { category: "session_closed", identity: "stream:control_1:closed" };
  assert.equal(controller.notify(candidate), true);
  assert.equal(controller.notify(candidate), false);
  assert.equal(created.length, 1);
  assert.equal("data" in created[0].options, false);
  created[0].onclick();
  assert.equal(created[0].closed, true);
  assert.equal(focused, 1);
  assert.equal(notificationForStreamTransition("RECONNECTING", "RECONNECTING", { active: true, controlSessionId: "control_1", transitionId: 1 }), null);
  assert.notEqual(notificationForStreamTransition("LIVE", "RECONNECTING", { active: true, controlSessionId: "control_1", transitionId: 2 })?.identity, notificationForStreamTransition("LIVE", "RECONNECTING", { active: true, controlSessionId: "control_1", transitionId: 1 })?.identity);
});

test("never notifies for initial snapshot hydration or initial observed state", () => {
  const initial = createRemoteSessionState(scope);
  const installed = installRemoteSnapshot(initial, {
    ...snapshot,
    interactions: [{ id: "interaction_initial", sessionId: scope.sessionId, runId: "run_1", status: "pending", title: "secret", createdAt: now, expiresAt: null, type: "permission", description: "secret", permittedResponses: ["reject"], resolution: null }],
  });
  assert.equal(notificationForRemoteEvent(initial, installed.state, { eventId: "snapshot_event" }, installed.effects), null);
  assert.equal(notificationForDeviceTransition(null, { id: "device_1", enrollmentStatus: "revoked", presence: "offline", localControlEnabled: false }, { active: true }), null);
  assert.equal(notificationForStreamTransition(null, "CLOSED", { active: true, closed: true, controlSessionId: "control_1" }), null);
});
