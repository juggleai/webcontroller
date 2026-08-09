import { consumeSSEStream } from "./sse.js";

export class RemoteStreamError extends Error {
  constructor(message, { status = 0, permanent = false, closed = false } = {}) {
    super(message);
    this.name = "RemoteStreamError";
    this.status = status;
    this.permanent = permanent;
    this.closed = closed;
  }
}

export function createRemoteSessionStream(options) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const setTimer = options.setTimeout || globalThis.setTimeout;
  const clearTimer = options.clearTimeout || globalThis.clearTimeout;
  const random = options.random || Math.random;
  const maxFailures = options.maxFailures ?? 3;
  const pollInterval = options.pollInterval ?? 5000;
  let stopped = true;
  let generation = 0;
  let failures = 0;
  let cursor = options.cursor == null ? null : String(options.cursor);
  let reconnectTimer = null;
  let pollTimer = null;
  let pollRunning = false;
  let controller = null;

  const emitState = (value, detail) => options.onState?.(value, detail);
  const current = (value) => !stopped && value === generation;

  function stopPolling() {
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(value) {
    if (!current(value) || pollTimer !== null || pollRunning) return;
    emitState("POLLING");
    pollTimer = setTimer(async () => {
      pollTimer = null;
      if (!current(value) || pollRunning) return;
      pollRunning = true;
      try { await options.onPoll?.(); } catch (error) { options.onLog?.("poll failed", error); }
      finally { pollRunning = false; schedulePoll(value); }
    }, pollInterval);
  }

  function scheduleConnect(value) {
    if (!current(value)) return;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(failures, 5)) * (0.8 + random() * 0.4);
    emitState(failures ? "RECONNECTING" : "CONNECTING");
    reconnectTimer = setTimer(() => { reconnectTimer = null; void connect(value); }, delay);
  }

  async function connect(value) {
    if (!current(value)) return;
    controller = new AbortController();
    const url = new URL(options.url);
    const headers = new Headers(options.headers?.() || options.headers || {});
    headers.set("Accept", "text/event-stream");
    if (cursor !== null) {
      url.searchParams.set("afterCursor", cursor);
      headers.set("Last-Event-ID", cursor);
    }
    try {
      const response = await fetchImpl(url, { headers, credentials: "omit", signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw new RemoteStreamError(`SSE authorization failed (${response.status})`, { status: response.status, permanent: true });
      if (response.status === 410) throw new RemoteStreamError("Control session is closed", { status: 410, closed: true });
      if (!response.ok || !response.body) throw new RemoteStreamError(`SSE HTTP ${response.status}`, { status: response.status });
      failures = 0;
      stopPolling();
      emitState("LIVE");
      await consumeSSEStream(response.body, async (record) => {
        if (!current(value)) return;
        if (record.type === "snapshot_required") { await options.onResync?.("server"); return; }
        if (record.type === "session_closed") throw new RemoteStreamError("Control session is closed", { closed: true });
        if (record.type === "error") {
          let payload; try { payload = JSON.parse(record.data); } catch { payload = null; }
          if (payload?.error?.code === "control_session_expired") throw new RemoteStreamError(payload.error.message, { closed: true });
          throw new RemoteStreamError(payload?.error?.message || "SSE error event");
        }
        if (record.type !== "message" || !record.id) throw new RemoteStreamError("Unexpected SSE event");
        await options.onRecord(record);
        cursor = record.id;
      }, options.parserOptions);
      if (current(value)) throw new RemoteStreamError("SSE stream ended");
    } catch (error) {
      if (!current(value) || error?.name === "AbortError") return;
      if (error?.permanent) { stopped = true; emitState("ERROR", error); options.onPermanentError?.(error); return; }
      if (error?.closed) { stopped = true; emitState("CLOSED", error); options.onClosed?.(error); return; }
      failures += 1;
      options.onLog?.("stream disconnected", error);
      if (failures >= maxFailures) schedulePoll(value);
      scheduleConnect(value);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      failures = 0;
      emitState("CONNECTING");
      void connect(generation);
    },
    stop(finalState = "CLOSED") {
      stopped = true;
      generation += 1;
      controller?.abort();
      controller = null;
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      stopPolling();
      emitState(finalState);
    },
    getCursor: () => cursor,
    setCursor(value) { cursor = value == null ? null : String(value); },
  };
}
