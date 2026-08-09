const SESSION_STATUSES = new Set(["idle", "running", "waiting", "retrying", "aborting", "completed", "failed"]);
const RUN_STATUSES = new Set(["started", "running", "waiting", "retrying", "aborting", "completed", "failed", "aborted"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);
const COMMAND_STATUSES = new Set(["pending", "leased", "delivered", "accepted", "running", "succeeded", "failed", "rejected", "expired", "cancelled"]);
const REASONS = new Set(["cursor_missing", "cursor_expired", "sequence_gap"]);
const ENVELOPE_KEYS = ["schemaVersion", "payloadVersion", "eventId", "cursor", "sequence", "controlSessionId", "deviceId", "commandId", "workspaceId", "sessionId", "runId", "occurredAt", "data"];

export class RemoteStateError extends Error {
  constructor(message, { resync = true } = {}) {
    super(message);
    this.name = "RemoteStateError";
    this.resync = resync;
  }
}

function fail(message) { throw new RemoteStateError(message); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail("Malformed remote payload");
}
function id(value) {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function date(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function nullable(value, check) { return value === null || check(value); }
function jsonClone(value) { return structuredClone(value); }
function uniqueIds(values) { return new Set(values.map((value) => value.id)).size === values.length; }

function validatePart(part) {
  if (!object(part) || !id(part.id)) fail("Malformed message part");
  if (part.type === "text" || part.type === "reasoning") {
    exact(part, ["type", "id", "text"]);
    if (typeof part.text !== "string" || part.text.length > 2_000_000) fail("Malformed message part");
  } else if (part.type === "tool") {
    exact(part, ["type", "id", "name", "title", "status", "input", "output"]);
    if (!id(part.name) || !nullable(part.title, (value) => typeof value === "string" && value.length <= 500) || !new Set(["pending", "running", "completed", "failed"]).has(part.status)) fail("Malformed tool part");
  } else fail("Unknown message part");
}

function validateMessage(message) {
  exact(message, ["id", "role", "createdAt", "completedAt", "parts"]);
  if (!id(message.id) || !new Set(["user", "assistant", "system", "tool"]).has(message.role) || !date(message.createdAt) || !nullable(message.completedAt, date) || !Array.isArray(message.parts) || message.parts.length > 10_000) fail("Malformed message");
  const seen = new Set();
  for (const part of message.parts) {
    validatePart(part);
    if (seen.has(part.id)) fail("Duplicate message part");
    seen.add(part.id);
  }
}

function validateTodo(todo) {
  exact(todo, ["id", "content", "status", "priority"]);
  if (!id(todo.id) || typeof todo.content !== "string" || !todo.content.trim() || !new Set(["pending", "in_progress", "completed", "cancelled"]).has(todo.status) || !new Set(["low", "medium", "high"]).has(todo.priority)) fail("Malformed todo");
}

function validateInteraction(value, sessionId) {
  if (!object(value)) fail("Malformed interaction");
  const common = ["id", "sessionId", "runId", "status", "title", "createdAt", "expiresAt", "type"];
  const extra = value.type === "permission" ? ["description", "permittedResponses", "resolution"] : value.type === "question" ? ["questions", "resolution"] : fail("Unknown interaction");
  exact(value, [...common, ...extra]);
  if (!id(value.id) || value.sessionId !== sessionId || !nullable(value.runId, id) || !new Set(["pending", "resolved", "expired"]).has(value.status) || typeof value.title !== "string" || !value.title.trim() || !date(value.createdAt) || !nullable(value.expiresAt, date)) fail("Malformed interaction");
  if (value.type === "permission") {
    if (typeof value.description !== "string" || !Array.isArray(value.permittedResponses) || value.permittedResponses.length < 1 || value.permittedResponses.some((item) => !new Set(["allow_once", "reject"]).has(item)) || !nullable(value.resolution, (item) => new Set(["allow_once", "reject"]).has(item))) fail("Malformed permission interaction");
  } else {
    if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 100 || !nullable(value.resolution, Array.isArray)) fail("Malformed question interaction");
    for (const question of value.questions) {
      exact(question, ["id", "prompt", "multiple", "options"]);
      if (!id(question.id) || typeof question.prompt !== "string" || !question.prompt.trim() || typeof question.multiple !== "boolean" || !Array.isArray(question.options) || question.options.some((item) => typeof item !== "string" || !item.trim())) fail("Malformed question");
    }
    if (value.resolution) for (const answer of value.resolution) {
      exact(answer, ["questionId", "values"]);
      if (!id(answer.questionId) || !Array.isArray(answer.values) || answer.values.length < 1 || answer.values.some((item) => typeof item !== "string")) fail("Malformed question resolution");
    }
  }
}

function validateRun(run, scope) {
  exact(run, ["workspaceId", "sessionId", "runId", "status"]);
  if (run.workspaceId !== scope.workspaceId || run.sessionId !== scope.sessionId || !id(run.runId) || !RUN_STATUSES.has(run.status)) fail("Malformed or cross-scope run");
}

function validateError(error, runId) {
  const keys = Object.hasOwn(error, "currentRunId") ? ["schemaVersion", "code", "message", "retryable", "correlationId", "currentRunId"] : ["schemaVersion", "code", "message", "retryable", "correlationId"];
  exact(error, keys);
  if (error.schemaVersion !== 1 || !id(error.code) || typeof error.message !== "string" || !error.message.trim() || typeof error.retryable !== "boolean" || !nullable(error.correlationId, id) || (Object.hasOwn(error, "currentRunId") && !nullable(error.currentRunId, (value) => id(value) && value === runId))) fail("Malformed run error");
}

function validateSnapshot(snapshot, scope) {
  exact(snapshot, ["schemaVersion", "workspace", "session", "messages", "todos", "interactions", "capturedAt"]);
  exact(snapshot.workspace, ["id", "name"]);
  exact(snapshot.session, ["id", "workspaceId", "title", "status", "createdAt", "updatedAt", "activeRunId"]);
  if (snapshot.schemaVersion !== 1 || snapshot.workspace.id !== scope.workspaceId || typeof snapshot.workspace.name !== "string" || !snapshot.workspace.name.trim() || snapshot.session.id !== scope.sessionId || snapshot.session.workspaceId !== scope.workspaceId || typeof snapshot.session.title !== "string" || !snapshot.session.title.trim() || !SESSION_STATUSES.has(snapshot.session.status) || !date(snapshot.session.createdAt) || !date(snapshot.session.updatedAt) || !nullable(snapshot.session.activeRunId, id) || !date(snapshot.capturedAt)) fail("Malformed or cross-scope snapshot");
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length > 100_000 || !Array.isArray(snapshot.todos) || snapshot.todos.length > 10_000 || !Array.isArray(snapshot.interactions) || snapshot.interactions.length > 1_000) fail("Malformed snapshot collections");
  if (!uniqueIds(snapshot.messages) || !uniqueIds(snapshot.todos) || !uniqueIds(snapshot.interactions)) fail("Duplicate snapshot identifiers");
  snapshot.messages.forEach(validateMessage);
  snapshot.todos.forEach(validateTodo);
  snapshot.interactions.forEach((item) => validateInteraction(item, scope.sessionId));
}

export function createRemoteSessionState(scope) {
  exact(scope, ["controlSessionId", "deviceId", "workspaceId", "sessionId"]);
  if (!Object.values(scope).every(id)) fail("Invalid remote scope");
  return {
    scope: Object.freeze({ ...scope }), cursor: null, sequence: 0, installed: false,
    snapshot: null, messages: new Map(), messageOrder: [], todos: new Map(), todoOrder: [],
    interactions: new Map(), interactionOrder: [], activeRun: null, runs: new Map(),
    lastError: null, seen: new Map(),
  };
}

export function installRemoteSnapshot(state, snapshot) {
  validateSnapshot(snapshot, state.scope);
  const next = { ...state, installed: true, snapshot: jsonClone(snapshot), messages: new Map(), messageOrder: [], todos: new Map(), todoOrder: [], interactions: new Map(), interactionOrder: [], lastError: null };
  for (const message of snapshot.messages) { next.messages.set(message.id, jsonClone(message)); next.messageOrder.push(message.id); }
  for (const todo of snapshot.todos) { next.todos.set(todo.id, jsonClone(todo)); next.todoOrder.push(todo.id); }
  for (const interaction of snapshot.interactions) { next.interactions.set(interaction.id, jsonClone(interaction)); next.interactionOrder.push(interaction.id); }
  next.activeRun = snapshot.session.activeRunId ? { runId: snapshot.session.activeRunId, status: snapshot.session.status } : null;
  return { state: next, effects: [{ type: "snapshot", recovery: state.installed }] };
}

export function establishRemoteSnapshotBaseline(state, snapshot, envelope, sseId, commandId) {
  validateEnvelope(state, envelope, sseId);
  if (envelope.commandId !== commandId || envelope.data?.type !== "command.lifecycle" ||
      envelope.data.commandId !== commandId || envelope.data.status !== "succeeded") {
    fail("Snapshot command boundary is not a successful terminal lifecycle");
  }
  const installed = installRemoteSnapshot(state, snapshot);
  const next = { ...installed.state, cursor: envelope.cursor, sequence: envelope.sequence, seen: new Map() };
  remember(next, envelope);
  return { state: next, effects: installed.effects };
}

function validateEnvelope(state, envelope, sseId) {
  exact(envelope, ENVELOPE_KEYS);
  const scope = state.scope;
  if (envelope.schemaVersion !== 1 || envelope.payloadVersion !== 1 || !id(envelope.eventId) || !Number.isSafeInteger(envelope.cursor) || envelope.cursor <= 0 || !Number.isSafeInteger(envelope.sequence) || envelope.sequence <= 0 || !date(envelope.occurredAt)) fail("Malformed event envelope");
  if (String(envelope.cursor) !== sseId) fail("SSE ID does not match event cursor");
  if (envelope.controlSessionId !== scope.controlSessionId || envelope.deviceId !== scope.deviceId || envelope.workspaceId !== scope.workspaceId || envelope.sessionId !== scope.sessionId) fail("Cross-scope event");
  if (!nullable(envelope.commandId, id) || !nullable(envelope.runId, id) || !object(envelope.data)) fail("Malformed event envelope");
}

function remember(next, envelope) {
  next.seen = new Map(next.seen);
  next.seen.set(envelope.eventId, JSON.stringify(envelope));
  while (next.seen.size > 2048) next.seen.delete(next.seen.keys().next().value);
}

export function applyRemoteSessionEvent(state, envelope, sseId) {
  validateEnvelope(state, envelope, sseId);
  const serialized = JSON.stringify(envelope);
  if (state.seen.has(envelope.eventId)) {
    if (state.seen.get(envelope.eventId) !== serialized) fail("Conflicting duplicate event");
    return { state, effects: [] };
  }
  if (!state.installed) fail("Event arrived before snapshot installation");
  if (state.cursor !== null && envelope.cursor <= state.cursor) fail("Non-monotonic event cursor");
  if (envelope.sequence !== state.sequence + 1) fail("Non-contiguous control-session sequence");

  const data = envelope.data;
  const next = { ...state };
  let effects;
  switch (data.type) {
    case "snapshot": {
      exact(data, ["type", "snapshot"]);
      const installed = installRemoteSnapshot(next, data.snapshot);
      Object.assign(next, installed.state);
      effects = installed.effects;
      break;
    }
    case "message.upsert":
      exact(data, ["type", "message"]); validateMessage(data.message);
      next.messages = new Map(next.messages); next.messageOrder = [...next.messageOrder];
      if (!next.messages.has(data.message.id)) next.messageOrder.push(data.message.id);
      next.messages.set(data.message.id, jsonClone(data.message)); effects = [{ type: "message.upsert", messageId: data.message.id }]; break;
    case "message.remove":
      exact(data, ["type", "messageId"]); if (!id(data.messageId)) fail("Malformed message removal");
      next.messages = new Map(next.messages); next.messages.delete(data.messageId); next.messageOrder = next.messageOrder.filter((item) => item !== data.messageId); effects = [{ type: "message.remove", messageId: data.messageId }]; break;
    case "message.part.upsert": {
      exact(data, ["type", "messageId", "part"]); if (!id(data.messageId)) fail("Malformed part update"); validatePart(data.part);
      const parent = next.messages.get(data.messageId); if (!parent) fail("Message part parent is missing");
      const message = jsonClone(parent); const index = message.parts.findIndex((part) => part.id === data.part.id);
      if (index < 0) message.parts.push(jsonClone(data.part)); else message.parts[index] = jsonClone(data.part);
      next.messages = new Map(next.messages); next.messages.set(message.id, message); effects = [{ type: "message.part.upsert", messageId: message.id, partId: data.part.id }]; break;
    }
    case "todos.replace":
      exact(data, ["type", "todos"]); if (!Array.isArray(data.todos) || data.todos.length > 10_000 || !uniqueIds(data.todos)) fail("Malformed todos"); data.todos.forEach(validateTodo);
      next.todos = new Map(data.todos.map((item) => [item.id, jsonClone(item)])); next.todoOrder = data.todos.map((item) => item.id); effects = [{ type: "todos.replace" }]; break;
    case "interaction.upsert":
      exact(data, ["type", "interaction"]); validateInteraction(data.interaction, state.scope.sessionId); if (data.interaction.runId !== envelope.runId) fail("Interaction run correlation mismatch");
      next.interactions = new Map(next.interactions); next.interactionOrder = [...next.interactionOrder]; if (!next.interactions.has(data.interaction.id)) next.interactionOrder.push(data.interaction.id); next.interactions.set(data.interaction.id, jsonClone(data.interaction)); effects = [{ type: "interaction.upsert", interactionId: data.interaction.id }]; break;
    case "interaction.remove":
      exact(data, ["type", "interactionId"]); if (!id(data.interactionId)) fail("Malformed interaction removal"); next.interactions = new Map(next.interactions); next.interactions.delete(data.interactionId); next.interactionOrder = next.interactionOrder.filter((item) => item !== data.interactionId); effects = [{ type: "interaction.remove", interactionId: data.interactionId }]; break;
    case "session.status":
      exact(data, ["type", "status", "run"]); if (!SESSION_STATUSES.has(data.status) || !nullable(data.run, object)) fail("Malformed session status"); if (data.run) validateRun(data.run, state.scope); if ((data.run?.runId || null) !== envelope.runId) fail("Session run correlation mismatch");
      next.snapshot = { ...next.snapshot, session: { ...next.snapshot.session, status: data.status, activeRunId: data.run?.runId || null } }; next.activeRun = data.run ? jsonClone(data.run) : null; effects = [{ type: "session.status" }]; break;
    case "run.status": {
      exact(data, ["type", "runId", "status", "error"]); if (!id(data.runId) || data.runId !== envelope.runId || !RUN_STATUSES.has(data.status) || !nullable(data.error, object)) fail("Malformed run status"); if (data.error) validateError(data.error, data.runId);
      next.runs = new Map(next.runs); next.runs.set(data.runId, { runId: data.runId, status: data.status, error: jsonClone(data.error) }); next.lastError = data.error ? jsonClone(data.error) : next.lastError;
      if (next.activeRun?.runId === data.runId) next.activeRun = TERMINAL_RUN_STATUSES.has(data.status) ? null : { ...next.activeRun, status: data.status };
      effects = [{ type: "run.status", runId: data.runId }]; break;
    }
    case "snapshot_required":
      exact(data, ["type", "reason"]); if (!REASONS.has(data.reason)) fail("Malformed snapshot request"); effects = [{ type: "resync", reason: data.reason }]; break;
    case "command.lifecycle":
      exact(data, ["type", "commandId", "status"]); if (!id(data.commandId) || data.commandId !== envelope.commandId || !COMMAND_STATUSES.has(data.status)) fail("Malformed command lifecycle"); effects = [{ type: "command.lifecycle", commandId: data.commandId, status: data.status }]; break;
    default: fail("Unknown remote event type");
  }
  next.cursor = envelope.cursor;
  next.sequence = envelope.sequence;
  remember(next, envelope);
  return { state: next, effects };
}
