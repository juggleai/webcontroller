export const CONTROL_SESSION_EXPIRY_WARNING_MS = 2 * 60 * 1000;

const MUTATION_OPERATIONS = new Set([
  "session.create",
  "session.prompt",
  "session.abort",
  "session.pending.cancel",
  "interaction.permission.reply",
  "interaction.question.reply",
]);

const CLOSED_SESSION_ERRORS = new Set([
  "control_session_expired",
  "control_session_closed",
]);

export function createCloudRequestError(payload, status) {
  const code = typeof payload?.error === "string" && payload.error ? payload.error : "request_failed";
  const message = typeof payload?.message === "string" && payload.message ? payload.message : `HTTP ${status}`;
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function controlSessionExpiry(session, now = Date.now(), warningMs = CONTROL_SESSION_EXPIRY_WARNING_MS) {
  if (!session) return { state: "none", remainingMs: null };
  const expiresAt = Date.parse(session.expiresAt);
  if (session.status !== "active" || !Number.isFinite(expiresAt) || expiresAt <= now) {
    return { state: "expired", remainingMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : null };
  }
  const remainingMs = expiresAt - now;
  return { state: remainingMs <= warningMs ? "approaching" : "active", remainingMs };
}

export function createRenewalState() {
  return { phase: "idle", operation: null, attempts: 0 };
}

export function transitionRenewal(current, event) {
  const state = current || createRenewalState();
  switch (event.type) {
    case "command_started":
      return event.operation && MUTATION_OPERATIONS.has(event.operation)
        ? { state: createRenewalState(), effects: [] }
        : { state, effects: [] };
    case "command_failed":
      if (CLOSED_SESSION_ERRORS.has(event.errorCode)) {
        return { state: { ...state, phase: "recreating", operation: event.operation || null }, effects: ["recreate_session"], replayMutation: false };
      }
      if (event.errorCode === "control_session_reauthentication_required" && MUTATION_OPERATIONS.has(event.operation)) {
        return { state: { phase: "renew_required", operation: event.operation, attempts: 0 }, effects: ["offer_renewal"], replayMutation: false };
      }
      return { state, effects: [], replayMutation: false };
    case "renew_requested":
      if (state.phase === "renewing" || state.attempts > 0) return { state, effects: [] };
      return { state: { ...state, phase: "renewing", attempts: 1 }, effects: ["renew_session"] };
    case "renew_succeeded":
      return {
        state: state.operation
          ? { ...state, phase: "retry_required", attempts: Math.max(1, state.attempts) }
          : createRenewalState(),
        effects: state.operation ? ["update_session", "tell_user_to_retry"] : ["update_session"],
        replayMutation: false,
      };
    case "renew_failed":
      if (CLOSED_SESSION_ERRORS.has(event.errorCode)) {
        return { state: { ...state, phase: "recreating" }, effects: ["recreate_session"], replayMutation: false };
      }
      return { state: { ...state, phase: "renew_failed" }, effects: ["show_renewal_error"], replayMutation: false };
    case "session_recreated":
      return { state: createRenewalState(), effects: [] };
    default:
      throw new Error(`Unknown renewal event: ${event.type}`);
  }
}

export function isMutationOperation(operation) {
  return MUTATION_OPERATIONS.has(operation);
}
