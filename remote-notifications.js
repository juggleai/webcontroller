const COPY = Object.freeze({
  interaction_waiting: Object.freeze({
    title: "JuggleWork needs your attention",
    body: "A remote session is waiting for a response.",
  }),
  run_completed: Object.freeze({
    title: "JuggleWork run completed",
    body: "A remote session run completed.",
  }),
  run_failed: Object.freeze({
    title: "JuggleWork run failed",
    body: "A remote session run failed.",
  }),
  run_aborted: Object.freeze({
    title: "JuggleWork run aborted",
    body: "A remote session run was aborted.",
  }),
  session_disconnected: Object.freeze({
    title: "JuggleWork control disconnected",
    body: "The current remote control connection was interrupted.",
  }),
  session_closed: Object.freeze({
    title: "JuggleWork control session closed",
    body: "The current remote control session was closed.",
  }),
  device_revoked: Object.freeze({
    title: "JuggleWork device access revoked",
    body: "Access to the current Desktop was revoked.",
  }),
  device_unavailable: Object.freeze({
    title: "JuggleWork Desktop unavailable",
    body: "The current Desktop is unavailable.",
  }),
});

const TERMINAL_RUN_CATEGORIES = Object.freeze({
  completed: "run_completed",
  failed: "run_failed",
  aborted: "run_aborted",
});

function stableValue(value) {
  const text = String(value ?? "");
  return text.length > 0 && text.length <= 512 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function signal(category, identity) {
  const stableIdentity = stableValue(identity);
  return COPY[category] && stableIdentity ? Object.freeze({ category, identity: stableIdentity }) : null;
}

export function notificationCopy(category) {
  return COPY[category] || null;
}

export function notificationForRemoteEvent(previousState, nextState, envelope, effects) {
  if (!previousState?.installed || !nextState?.installed || !Array.isArray(effects)) return null;
  const eventId = stableValue(envelope?.eventId);
  if (!eventId || effects.some((effect) => effect?.type === "snapshot")) return null;

  const interactionEffect = effects.find((effect) => effect?.type === "interaction.upsert");
  if (interactionEffect) {
    const interaction = nextState.interactions?.get(interactionEffect.interactionId);
    const previous = previousState.interactions?.get(interactionEffect.interactionId);
    if (interaction?.status === "pending" && previous?.status !== "pending") {
      return signal("interaction_waiting", `event:${eventId}:interaction_waiting`);
    }
  }

  const runEffect = effects.find((effect) => effect?.type === "run.status");
  if (runEffect) {
    const run = nextState.runs?.get(runEffect.runId);
    const previous = previousState.runs?.get(runEffect.runId);
    const category = TERMINAL_RUN_CATEGORIES[run?.status];
    if (category && previous?.status !== run.status) return signal(category, `event:${eventId}:${category}`);
  }
  return null;
}

function deviceAvailable(device) {
  return device?.enrollmentStatus === "enrolled" && device?.presence === "online" && device?.localControlEnabled === true;
}

export function notificationForDeviceTransition(previousDevice, nextDevice, { active = false } = {}) {
  if (!active || !previousDevice) return null;
  const deviceId = stableValue(previousDevice.id);
  if (!deviceId) return null;
  if (!nextDevice) return signal("device_unavailable", `device:${deviceId}:unavailable:missing`);
  if (previousDevice.id !== nextDevice.id) return null;
  const version = stableValue(nextDevice.revokedAt || nextDevice.lastSeenAt || nextDevice.connectionGeneration || "state");
  if (!version) return null;
  if (previousDevice.enrollmentStatus !== "revoked" && nextDevice.enrollmentStatus === "revoked") {
    return signal("device_revoked", `device:${deviceId}:revoked:${version}`);
  }
  if (deviceAvailable(previousDevice) && !deviceAvailable(nextDevice)) {
    const nextState = `${nextDevice.enrollmentStatus}:${nextDevice.presence}:${Boolean(nextDevice.localControlEnabled)}`;
    return signal("device_unavailable", `device:${deviceId}:unavailable:${nextState}:${version}`);
  }
  return null;
}

export function notificationForStreamTransition(previousState, nextState, {
  active = false,
  closed = false,
  controlSessionId = null,
  transitionId = null,
} = {}) {
  const sessionId = stableValue(controlSessionId);
  if (!active || !sessionId || !previousState) return null;
  if (nextState === "CLOSED" && closed) return signal("session_closed", `stream:${sessionId}:closed`);
  if ((previousState === "LIVE" || previousState === "POLLING") && nextState === "RECONNECTING") {
    const stableTransitionId = stableValue(transitionId);
    return stableTransitionId ? signal("session_disconnected", `stream:${sessionId}:disconnected:${stableTransitionId}`) : null;
  }
  return null;
}

export function createBrowserNotificationController({
  notificationApi = globalThis.Notification,
  focus = () => undefined,
  maxRemembered = 2048,
} = {}) {
  const seen = new Set();

  function permission() {
    if (typeof notificationApi !== "function") return "unsupported";
    return new Set(["default", "denied", "granted"]).has(notificationApi.permission)
      ? notificationApi.permission
      : "unsupported";
  }

  return Object.freeze({
    permission,
    async requestPermission() {
      const current = permission();
      if (current === "unsupported" || current === "denied" || current === "granted") return current;
      if (typeof notificationApi.requestPermission !== "function") return "unsupported";
      try {
        const result = await notificationApi.requestPermission();
        return new Set(["default", "denied", "granted"]).has(result) ? result : permission();
      } catch {
        return "unsupported";
      }
    },
    notify(candidate) {
      const copy = notificationCopy(candidate?.category);
      const identity = stableValue(candidate?.identity);
      if (permission() !== "granted" || !copy || !identity || seen.has(identity)) return false;
      let notification;
      try {
        notification = new notificationApi(copy.title, { body: copy.body });
      } catch {
        return false;
      }
      seen.add(identity);
      while (seen.size > maxRemembered) seen.delete(seen.values().next().value);
      notification.onclick = () => {
        try { notification.close?.(); } catch { /* Browser notification cleanup is best-effort. */ }
        try { focus(); } catch { /* Notification clicks must not execute fallback navigation. */ }
      };
      return true;
    },
  });
}
