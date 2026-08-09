import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTROL_SESSION_EXPIRY_WARNING_MS,
  controlSessionExpiry,
  createCloudRequestError,
  createRenewalState,
  transitionRenewal,
} from "../control-session-renewal.js";

const now = Date.parse("2026-08-09T12:00:00.000Z");

test("parses the backend top-level error code", () => {
  const error = createCloudRequestError({ error: "control_session_reauthentication_required", message: "Renew first" }, 409);
  assert.equal(error.code, "control_session_reauthentication_required");
  assert.equal(error.message, "Renew first");
  assert.equal(error.status, 409);
  assert.equal(createCloudRequestError({ error: { code: "wrong_shape" } }, 500).code, "request_failed");
});

test("classifies approaching and expired control-session timestamps", () => {
  const session = { status: "active", expiresAt: new Date(now + CONTROL_SESSION_EXPIRY_WARNING_MS + 1).toISOString() };
  assert.equal(controlSessionExpiry(session, now).state, "active");
  assert.equal(controlSessionExpiry({ ...session, expiresAt: new Date(now + CONTROL_SESSION_EXPIRY_WARNING_MS).toISOString() }, now).state, "approaching");
  assert.equal(controlSessionExpiry({ ...session, expiresAt: new Date(now).toISOString() }, now).state, "expired");
  assert.equal(controlSessionExpiry({ ...session, status: "closed" }, now).state, "expired");
});

test("reauthentication requires one explicit renewal and never replays the mutation", () => {
  const required = transitionRenewal(createRenewalState(), {
    type: "command_failed",
    operation: "session.prompt",
    errorCode: "control_session_reauthentication_required",
  });
  assert.equal(required.state.phase, "renew_required");
  assert.deepEqual(required.effects, ["offer_renewal"]);
  assert.equal(required.replayMutation, false);

  const requested = transitionRenewal(required.state, { type: "renew_requested" });
  assert.deepEqual(requested.effects, ["renew_session"]);
  assert.equal(transitionRenewal(requested.state, { type: "renew_requested" }).effects.length, 0);

  const renewed = transitionRenewal(requested.state, { type: "renew_succeeded" });
  assert.deepEqual(renewed.effects, ["update_session", "tell_user_to_retry"]);
  assert.equal(renewed.replayMutation, false);
  assert.equal(renewed.effects.includes("execute_mutation"), false);
});

test("expired or closed renewal decisions recreate instead of revive", () => {
  for (const errorCode of ["control_session_expired", "control_session_closed"]) {
    const result = transitionRenewal({ phase: "renewing", operation: "session.abort", attempts: 1 }, { type: "renew_failed", errorCode });
    assert.equal(result.state.phase, "recreating");
    assert.deepEqual(result.effects, ["recreate_session"]);
    assert.equal(result.replayMutation, false);
  }
});
