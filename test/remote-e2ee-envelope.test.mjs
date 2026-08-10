import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveRemoteControlE2EEKeyFromSecret, encryptRemoteControlPayload, sessionEventAAD } from "../remote-e2ee.js";
import { decryptControllerCommandTerminal, decryptControllerEventEnvelope } from "../remote-e2ee-envelope.js";

const desktopKeyId = `p256:${"A".repeat(43)}`;
const controllerKeyId = `p256:${"B".repeat(43)}`;
const desktopStatementHash = "a".repeat(64);
const controlSessionId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

test("browser decrypts an integrated SSE event with immutable source routing", async () => {
  const key = await deriveRemoteControlE2EEKeyFromSecret({ secret: new Uint8Array(32), controlSessionId, deviceId, desktopKeyId, controllerKeyId, desktopStatementHash, direction: "desktop-to-controller" });
  const routing = {
    eventId: "33333333-3333-4333-8333-333333333333", controlSessionId, deviceId,
    workspaceId: "ws_1", sessionId: "ses_1", sourceSequence: 7,
    eventType: "todos.replace", occurredAt: "2026-08-10T12:00:00.123Z",
    desktopKeyId, desktopStatementHash, controllerKeyId,
  };
  const encryptedPayload = await encryptRemoteControlPayload({ key, aad: sessionEventAAD(routing), value: { type: "todos.replace", todos: [] }, nonce: new Uint8Array(12) });
  const envelope = {
    schemaVersion: 1, payloadVersion: 1, eventId: routing.eventId, cursor: 55, sequence: 19,
    controlSessionId, deviceId, commandId: null, workspaceId: "ws_1", sessionId: "ses_1", runId: null,
    occurredAt: routing.occurredAt, data: null, sourceSequence: 7, eventType: routing.eventType,
    payloadEncryption: { mode: "e2ee-v1", desktopKeyId, desktopStatementHash, controllerKeyId }, encryptedPayload,
  };
  const decrypted = await decryptControllerEventEnvelope(envelope, { inboundKey: key, desktopKeyId, desktopStatementHash, controllerKeyId });
  assert.deepEqual(decrypted.data, { type: "todos.replace", todos: [] });
  assert.equal(decrypted.sequence, 19);
  assert.equal("sourceSequence" in decrypted, false);
  await assert.rejects(() => decryptControllerEventEnvelope({ ...envelope, sourceSequence: 8 }, { inboundKey: key, desktopKeyId, desktopStatementHash, controllerKeyId }));
});

test("browser safely consumes explicit content-free encrypted control signals", async () => {
  const encryption = { inboundKey: null, desktopKeyId, desktopStatementHash, controllerKeyId };
  const terminal = await decryptControllerCommandTerminal({
    terminal: {
      commandId: "33333333-3333-4333-8333-333333333333", status: "expired", result: null, error: null, encryptedPayload: null,
      payloadEncryption: { mode: "e2ee-v1", desktopKeyId, desktopStatementHash, controllerKeyId },
      controlSignal: { type: "cloud.command_terminal", status: "expired", errorCode: "command_expired" },
    },
    encryption, controlSessionId, deviceId, operation: "session.create",
  });
  assert.equal(terminal.error.code, "command_expired");
  const snapshot = await decryptControllerEventEnvelope({
    eventId: "44444444-4444-4444-8444-444444444444", sequence: 20, controlSessionId, deviceId,
    workspaceId: "ws_1", sessionId: "ses_1", occurredAt: "2026-08-10T12:00:00.123Z", data: null,
    sourceSequence: 9, eventType: "snapshot_required", controlSignal: "snapshot_required",
    payloadEncryption: { mode: "e2ee-v1", desktopKeyId, desktopStatementHash, controllerKeyId },
  }, encryption);
  assert.deepEqual(snapshot.data, { type: "snapshot_required", reason: "sequence_gap" });
});
