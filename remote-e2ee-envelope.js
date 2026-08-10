import { commandResultAAD, decryptRemoteControlPayload, sessionEventAAD } from "./remote-e2ee.js";

const TERMINAL = new Set(["succeeded", "failed", "rejected", "expired", "cancelled"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function assertBinding(value, encryption) {
  if (value?.payloadEncryption?.mode !== "e2ee-v1" ||
      value.payloadEncryption.desktopKeyId !== encryption.desktopKeyId ||
      value.payloadEncryption.desktopStatementHash !== encryption.desktopStatementHash ||
      value.payloadEncryption.controllerKeyId !== encryption.controllerKeyId) {
    throw new Error("Encrypted payload binding is invalid");
  }
}

export async function decryptControllerCommandTerminal({ terminal, encryption, controlSessionId, deviceId, operation }) {
  if (!encryption) {
    if (terminal?.payloadEncryption?.mode === "e2ee-v1") throw new Error("Unexpected encrypted command result");
    return terminal;
  }
  assertBinding(terminal, encryption);
  if (!TERMINAL.has(terminal.status) || terminal.result !== null || terminal.error !== null) throw new Error("Invalid encrypted command terminal");
  if (terminal.encryptedPayload) {
    if (terminal.controlSignal !== undefined) throw new Error("Ambiguous encrypted command terminal");
    const decrypted = await decryptRemoteControlPayload({
      key: encryption.inboundKey,
      aad: commandResultAAD({ commandId: terminal.commandId, controlSessionId, deviceId, operation, status: terminal.status, desktopKeyId: encryption.desktopKeyId, desktopStatementHash: encryption.desktopStatementHash, controllerKeyId: encryption.controllerKeyId }),
      payload: terminal.encryptedPayload,
    });
    if (!exact(decrypted, ["result", "error"])) throw new Error("Invalid decrypted command terminal");
    return { ...terminal, result: decrypted.result, error: decrypted.error };
  }
  const signal = terminal.controlSignal;
  if (!exact(signal, ["type", "status", "errorCode"]) || signal.type !== "cloud.command_terminal" ||
      signal.status !== terminal.status || signal.status === "succeeded" || !(signal.errorCode === null || typeof signal.errorCode === "string")) {
    throw new Error("Encrypted command result was downgraded");
  }
  const code = signal.errorCode || (signal.status === "expired" ? "command_expired" : signal.status === "cancelled" ? "command_cancelled" : "delivery_failed");
  return { ...terminal, error: { schemaVersion: 1, code, message: `Command ${signal.status}`, retryable: false, correlationId: terminal.commandId } };
}

export async function decryptControllerEventEnvelope(envelope, encryption) {
  if (!encryption) {
    if (envelope?.payloadEncryption?.mode === "e2ee-v1") throw new Error("Unexpected encrypted event");
    if (envelope?.payloadEncryption?.mode === "none") {
      const { payloadEncryption, ...plain } = envelope;
      return plain;
    }
    return envelope;
  }
  assertBinding(envelope, encryption);
  if (envelope.controlSignal === "command_terminal" || envelope.controlSignal === "command_lifecycle") {
    if (envelope.encryptedPayload !== undefined || !exact(envelope.data, ["type", "commandId", "status"]) ||
        envelope.data.type !== "command.lifecycle" || envelope.data.commandId !== envelope.commandId ||
        (envelope.controlSignal === "command_terminal" ? !TERMINAL.has(envelope.data.status) : !["pending", "accepted", "running"].includes(envelope.data.status))) {
      throw new Error("Invalid command terminal signal");
    }
    const { payloadEncryption, controlSignal, ...plain } = envelope;
    return plain;
  }
  if (envelope.controlSignal === "snapshot_required") {
    if (envelope.encryptedPayload !== undefined || envelope.data !== null || envelope.eventType !== "snapshot_required" ||
        !Number.isSafeInteger(envelope.sourceSequence) || envelope.sourceSequence <= 0) {
      throw new Error("Invalid snapshot-required signal");
    }
    const { payloadEncryption, controlSignal, eventType, sourceSequence, ...plain } = envelope;
    return { ...plain, data: { type: "snapshot_required", reason: "sequence_gap" } };
  }
  if (envelope.controlSignal !== undefined || !envelope.encryptedPayload || envelope.data !== null ||
      !Number.isSafeInteger(envelope.sourceSequence) || envelope.sourceSequence <= 0) {
    throw new Error("Encrypted event was downgraded");
  }
  const data = await decryptRemoteControlPayload({
    key: encryption.inboundKey,
    aad: sessionEventAAD({ eventId: envelope.eventId, controlSessionId: envelope.controlSessionId, deviceId: envelope.deviceId, workspaceId: envelope.workspaceId, sessionId: envelope.sessionId, sourceSequence: envelope.sourceSequence, eventType: envelope.eventType, occurredAt: envelope.occurredAt, desktopKeyId: encryption.desktopKeyId, desktopStatementHash: encryption.desktopStatementHash, controllerKeyId: encryption.controllerKeyId }),
    payload: envelope.encryptedPayload,
  });
  if (data?.type !== envelope.eventType) throw new Error("Encrypted event type mismatch");
  const { payloadEncryption, encryptedPayload, eventType, sourceSequence, ...plain } = envelope;
  return { ...plain, data };
}
