export const MAX_PENDING_ENQUEUE_HANDLES = 100;
export const MAX_REMOTE_PROMPT_UTF8_BYTES = 200_000;

const DEFAULT_HANDLES_STORAGE_KEY = "jugglework.desktop.pending-enqueues.v1";
const DEFAULT_ATTEMPT_STORAGE_KEY = "jugglework.desktop.pending-enqueue-attempt.v1";
const SCOPE_KEYS = ["serverOrigin", "accountId", "organizationId", "deviceId", "workspaceId", "sessionId"];

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function identifier(value) {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function origin(value) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && parsed.origin === value;
  } catch { return false; }
}
function validScope(value) {
  return exact(value, SCOPE_KEYS) && origin(value.serverOrigin) && SCOPE_KEYS.slice(1).every((key) => identifier(value[key]));
}
function scopeKey(scope) { return SCOPE_KEYS.map((key) => scope[key]).join("\0"); }
function sameAuthentication(scope, authentication) {
  return scope.serverOrigin === authentication.serverOrigin && scope.accountId === authentication.accountId &&
    scope.organizationId === authentication.organizationId;
}
function validHandle(value) {
  return exact(value, ["id", "mode", "position", "status"]) && identifier(value.id) &&
    ["steer", "enqueue"].includes(value.mode) && Number.isSafeInteger(value.position) && value.position > 0 && value.status === "pending";
}
function validAttempt(value) {
  return exact(value, ["idempotencyKey", "controlSessionId", "commandId", "createdAt"]) &&
    identifier(value.idempotencyKey) && identifier(value.controlSessionId) &&
    (value.commandId === null || identifier(value.commandId)) && Number.isSafeInteger(value.createdAt) && value.createdAt > 0;
}

export function validRemotePrompt(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_REMOTE_PROMPT_UTF8_BYTES;
}

export function busyModeAvailability(device) {
  const features = Array.isArray(device?.capabilities?.features) ? device.capabilities.features : [];
  return Object.freeze({
    reject: true,
    steer: features.includes("session.steer"),
    enqueue: features.includes("session.enqueue"),
  });
}

export function resolveBusyMode(requested, device) {
  const availability = busyModeAvailability(device);
  return requested === "steer" && availability.steer
    ? "steer"
    : requested === "enqueue" && availability.enqueue ? "enqueue" : "reject";
}

export function isDefinitiveEnqueueOutcome({ result = null, error = null } = {}) {
  return ["started", "steered", "enqueued"].includes(result?.disposition) ||
    error?.safeTerminal === true || error?.definitiveNonEnqueued === true;
}

export function prepareEnqueueSubmission(attempt, { createKey, controlSessionId, now = Date.now }) {
  if (attempt) {
    if (!validAttempt(attempt)) throw new TypeError("Invalid persisted enqueue attempt");
    return Object.freeze({
      idempotencyKey: attempt.idempotencyKey,
      resume: attempt.commandId ? Object.freeze({ commandId: attempt.commandId, controlSessionId: attempt.controlSessionId }) : null,
      attempt: null,
    });
  }
  const next = {
    idempotencyKey: createKey(),
    controlSessionId,
    commandId: null,
    createdAt: now(),
  };
  if (!validAttempt(next)) throw new TypeError("Invalid enqueue attempt identity");
  return Object.freeze({ idempotencyKey: next.idempotencyKey, resume: null, attempt: Object.freeze(next) });
}

export function createPendingEnqueueState(
  limit = MAX_PENDING_ENQUEUE_HANDLES,
  storage = null,
  storageKey = DEFAULT_HANDLES_STORAGE_KEY,
  attemptStorageKey = DEFAULT_ATTEMPT_STORAGE_KEY,
) {
  let currentScope = null;
  let persistedScope = null;
  let attempt = null;
  const handles = new Map();

  function removeStorage(key) {
    if (!storage?.removeItem) return;
    try { storage.removeItem(key); } catch {}
  }

  function clearPersisted() {
    handles.clear();
    persistedScope = null;
    attempt = null;
    removeStorage(storageKey);
    removeStorage(attemptStorageKey);
  }

  function persistHandles() {
    if (!storage?.setItem || !persistedScope || handles.size === 0) {
      removeStorage(storageKey);
      return;
    }
    try {
      storage.setItem(storageKey, JSON.stringify({
        schemaVersion: 1,
        scope: persistedScope,
        handles: [...handles.values()].slice(-limit),
      }));
    } catch {}
  }

  function persistAttempt() {
    if (!storage?.setItem || !persistedScope || !attempt) {
      removeStorage(attemptStorageKey);
      return;
    }
    try { storage.setItem(attemptStorageKey, JSON.stringify({ schemaVersion: 1, scope: persistedScope, attempt })); } catch {}
  }

  if (storage?.getItem) {
    try {
      const stored = JSON.parse(storage.getItem(storageKey) || "null");
      if (stored !== null) {
        if (!exact(stored, ["schemaVersion", "scope", "handles"]) || stored.schemaVersion !== 1 ||
            !validScope(stored.scope) || !Array.isArray(stored.handles) || stored.handles.length > limit ||
            stored.handles.some((handle) => !validHandle(handle)) || new Set(stored.handles.map((handle) => handle.id)).size !== stored.handles.length) {
          throw new Error("Malformed pending enqueue storage");
        }
        persistedScope = Object.freeze({ ...stored.scope });
        for (const handle of stored.handles) handles.set(handle.id, Object.freeze({ ...handle }));
      }
      const storedAttempt = JSON.parse(storage.getItem(attemptStorageKey) || "null");
      if (storedAttempt !== null) {
        if (!exact(storedAttempt, ["schemaVersion", "scope", "attempt"]) || storedAttempt.schemaVersion !== 1 ||
            !validScope(storedAttempt.scope) || !validAttempt(storedAttempt.attempt) ||
            (persistedScope && scopeKey(persistedScope) !== scopeKey(storedAttempt.scope))) {
          throw new Error("Malformed pending enqueue attempt storage");
        }
        persistedScope ||= Object.freeze({ ...storedAttempt.scope });
        attempt = Object.freeze({ ...storedAttempt.attempt });
      }
    } catch { clearPersisted(); }
  }

  function setScope(scope) {
    if (scope === null || scope === undefined) {
      currentScope = null;
      return;
    }
    if (!validScope(scope)) {
      currentScope = null;
      clearPersisted();
      return;
    }
    const next = Object.freeze({ ...scope });
    if (persistedScope && scopeKey(persistedScope) !== scopeKey(next)) clearPersisted();
    currentScope = next;
    persistedScope ||= next;
  }

  function fenceAuthentication(authentication) {
    if (!exact(authentication, ["serverOrigin", "accountId", "organizationId"]) || !origin(authentication.serverOrigin) ||
        !identifier(authentication.accountId) || !identifier(authentication.organizationId)) {
      currentScope = null;
      clearPersisted();
      return false;
    }
    if (persistedScope && !sameAuthentication(persistedScope, authentication)) {
      currentScope = null;
      clearPersisted();
      return false;
    }
    return true;
  }

  function add(handle) {
    if (!currentScope || !validHandle(handle)) return false;
    persistedScope = currentScope;
    handles.delete(handle.id);
    handles.set(handle.id, Object.freeze({ ...handle }));
    while (handles.size > limit) handles.delete(handles.keys().next().value);
    persistHandles();
    return true;
  }

  function beginAttempt(value) {
    if (!currentScope || !validAttempt({ ...value, commandId: value?.commandId ?? null })) return null;
    if (attempt) return attempt;
    persistedScope = currentScope;
    attempt = Object.freeze({ ...value, commandId: value.commandId ?? null });
    persistAttempt();
    return attempt;
  }

  return Object.freeze({
    setScope,
    fenceAuthentication,
    add,
    remove(id) {
      const removed = handles.delete(id);
      persistHandles();
      return removed;
    },
    clear() {
      currentScope = null;
      clearPersisted();
    },
    replace(items) {
      if (!currentScope || !Array.isArray(items) || items.some((item) => !validHandle(item)) ||
          new Set(items.map((item) => item.id)).size !== items.length) return false;
      handles.clear();
      for (const item of items.slice(-limit)) handles.set(item.id, Object.freeze({ ...item }));
      persistedScope = currentScope;
      persistHandles();
      return true;
    },
    list: () => currentScope && persistedScope && scopeKey(currentScope) === scopeKey(persistedScope) ? [...handles.values()] : [],
    beginAttempt,
    setAttemptCommand(commandId, controlSessionId = attempt?.controlSessionId) {
      if (!currentScope || !attempt || !identifier(commandId) || !identifier(controlSessionId)) return null;
      attempt = Object.freeze({ ...attempt, commandId, controlSessionId });
      persistAttempt();
      return attempt;
    },
    attempt: () => currentScope && persistedScope && scopeKey(currentScope) === scopeKey(persistedScope) ? attempt : null,
    clearAttempt() {
      const removed = attempt !== null;
      attempt = null;
      persistAttempt();
      return removed;
    },
    currentScope: () => currentScope ? scopeKey(currentScope) : null,
  });
}
