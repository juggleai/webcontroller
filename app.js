import { applyRemoteSessionEvent, createRemoteSessionState, establishRemoteSnapshotBaseline, RemoteStateError } from "./remote-session-state.js";
import { createRemoteSessionStream } from "./remote-session-stream.js";

const DISABLED_GATES = Object.freeze({
  enrollment: false,
  readOnlyControl: false,
  sessionMutation: false,
  interactions: false,
  backgroundLifecycle: false,
  eventCompaction: false,
  multiInstanceRouting: false,
  payloadEncryption: false,
  busySessionSteer: false,
  busySessionEnqueue: false,
  nativeMobile: false,
});

const GATE_LABELS = Object.freeze({
  enrollment: "设备注册",
  readOnlyControl: "只读控制",
  sessionMutation: "会话写操作",
  interactions: "权限与问答",
  backgroundLifecycle: "后台运行",
  eventCompaction: "事件压缩",
  multiInstanceRouting: "多实例路由",
  payloadEncryption: "端到端加密",
  busySessionSteer: "运行中 steer",
  busySessionEnqueue: "持久化队列",
  nativeMobile: "原生移动端",
});

const state = {
  token: null,
  user: null,
  organizations: [],
  activeOrgId: null,
  featureGates: { ...DISABLED_GATES },
  policyVersion: null,
  devices: [],
  selectedDeviceId: null,
  loginMode: "account",
  cloud: { ready: false, cors: false, wssRoute: false },
  refreshTimer: null,
  controlSession: null,
  workspaces: [],
  sessions: [],
  selectedWorkspaceId: null,
  selectedSessionId: null,
  snapshot: null,
  controlGeneration: 0,
  controlBusy: false,
  activeRunId: null,
  activeRunGeneration: 0,
  remoteModel: null,
  remoteStream: null,
  remoteStreamState: "CLOSED",
  remoteEventBuffer: [],
  remoteRecovery: null,
};

const element = (id) => document.getElementById(id);
const baseUrlInput = element("baseUrl");
const logElement = element("log");
const gateList = element("gateList");
const deviceList = element("deviceList");
const readiness = element("readiness");

export function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Server 地址必须使用 HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Server 地址不能包含凭证、查询参数或片段");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/jwork/api") pathname = "";
  else if (pathname === "/jwork") pathname = "";
  else if (pathname !== "") throw new Error("请输入部署 origin，例如 https://work.juggle.im");
  url.pathname = pathname || "/";
  return url.toString().replace(/\/$/, "");
}

function apiRoot() {
  return `${normalizeBaseUrl(baseUrlInput.value)}/jwork/api`;
}

function redact(value) {
  return String(value ?? "")
    .replace(/jws_[A-Za-z0-9_-]+/g, "jws_[REDACTED]")
    .replace(/jwenroll_[A-Za-z0-9_-]+/g, "jwenroll_[REDACTED]")
    .replace(/jwdagent_[A-Za-z0-9_-]+/g, "jwdagent_[REDACTED]")
    .replace(/("?(?:password|token|accessToken|authorization)"?\s*[:=]\s*")([^"]+)(")/gi, "$1[REDACTED]$3");
}

function log(level, message, data) {
  const row = document.createElement("div");
  row.className = "log-entry";
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const serialized = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  row.innerHTML = `<span class="log-time"></span><span class="log-level"></span><span class="log-message"></span>`;
  row.children[0].textContent = timestamp;
  row.children[1].textContent = level.toUpperCase();
  row.children[1].classList.add(level);
  row.children[2].textContent = redact(`${message}${serialized}`);
  logElement.append(row);
  logElement.scrollTop = logElement.scrollHeight;
}

function toast(message) {
  const node = element("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 1800);
}

async function request(path, options = {}) {
  const headers = new Headers({ Accept: "application/json", ...(options.headers || {}) });
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (state.activeOrgId) headers.set("x-jugglework-org-id", state.activeOrgId);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const method = options.method || "GET";
  const url = `${apiRoot()}${path}`;
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeout || 12_000),
    });
  } catch (error) {
    log("error", `${method} ${path} 网络失败`, { message: error instanceof Error ? error.message : "unknown" });
    throw error;
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  log(response.ok ? "success" : "error", `${method} ${path} → ${response.status} (${Math.round(performance.now() - started)}ms)`, response.ok ? undefined : payload);
  if (!response.ok) {
    const error = new Error(payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.error || "request_failed";
    throw error;
  }
  return payload;
}

function setBadge(node, text, type = "neutral") {
  node.textContent = text;
  node.className = `badge ${type}`;
}

function metric(index, text, type) {
  const strong = element("cloudMetrics").children[index].querySelector("strong");
  strong.textContent = text;
  strong.className = type || "";
}

async function checkCloud() {
  element("healthButton").disabled = true;
  state.cloud = { ready: false, cors: false, wssRoute: false };
  try {
    const origin = normalizeBaseUrl(baseUrlInput.value);
    const response = await fetch(`${origin}/jwork/api/ready`, {
      credentials: "omit",
      signal: AbortSignal.timeout(8_000),
    });
    state.cloud.ready = response.ok;
    state.cloud.cors = response.headers.get("access-control-allow-origin") === window.location.origin || response.type === "cors";
    metric(0, response.ok ? "READY" : `HTTP ${response.status}`, response.ok ? "good" : "bad");
    metric(1, state.cloud.cors ? "ALLOWED" : "CHECK", state.cloud.cors ? "good" : "");
    log(response.ok ? "success" : "error", `Cloud ready 检测 → ${response.status}`);

    const wssProbe = await fetch(`${origin}/jwork/api/desktop-agent/v1/connect`, {
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    state.cloud.wssRoute = wssProbe.status === 401 || wssProbe.status === 426 || wssProbe.status === 400;
    metric(2, state.cloud.wssRoute ? "EXPOSED" : `HTTP ${wssProbe.status}`, state.cloud.wssRoute ? "good" : "bad");
    log(state.cloud.wssRoute ? "success" : "error", `Desktop WSS 公共路由探测 → ${wssProbe.status}`);
    element("cloudPulse").className = `pulse ${response.ok ? "online" : "error"}`;
    element("cloudLabel").textContent = response.ok ? "Cloud 可访问" : "Cloud 异常";
    element("cloudDetail").textContent = origin;
  } catch (error) {
    metric(0, "FAILED", "bad");
    metric(1, "FAILED", "bad");
    metric(2, "UNKNOWN", "bad");
    element("cloudPulse").className = "pulse error";
    element("cloudLabel").textContent = "连接失败";
    log("error", "Cloud 检测失败", { message: error instanceof Error ? error.message : "unknown" });
  } finally {
    element("healthButton").disabled = false;
    renderReadiness();
  }
}

async function login(event) {
  event.preventDefault();
  const identity = element("identity").value.trim();
  const passwordNode = element("password");
  const password = passwordNode.value;
  if (!identity || !password) return;
  element("loginButton").disabled = true;
  try {
    const endpoint = state.loginMode === "email" ? "/auth/sign-in/email" : "/auth/sign-in/account";
    const payload = await request(endpoint, {
      method: "POST",
      body: state.loginMode === "email" ? { email: identity, password } : { account: identity, password },
    });
    if (!payload?.token) throw new Error("登录响应未包含 session token");
    state.token = payload.token;
    state.user = payload.user || null;
    passwordNode.value = "";
    setBadge(element("authBadge"), state.user?.name || state.user?.account || "已登录", "good");
    element("loginButton").classList.add("hidden");
    element("logoutButton").classList.remove("hidden");
    log("success", "登录成功，token 已保存在页面内存");
    await loadOrganizations();
  } catch (error) {
    state.token = null;
    setBadge(element("authBadge"), "登录失败", "bad");
    toast(error instanceof Error ? error.message : "登录失败");
  } finally {
    passwordNode.value = "";
    element("loginButton").disabled = false;
  }
}

async function loadOrganizations() {
  const payload = await request("/v1/me/orgs");
  state.organizations = Array.isArray(payload?.orgs) ? payload.orgs : [];
  state.activeOrgId = payload?.activeOrgId || state.organizations[0]?.id || null;
  const select = element("organization");
  select.innerHTML = "";
  for (const organization of state.organizations) {
    const option = document.createElement("option");
    option.value = organization.id;
    option.textContent = `${organization.name} · ${organization.role}`;
    option.selected = organization.id === state.activeOrgId;
    select.append(option);
  }
  select.disabled = state.organizations.length === 0;
  element("refreshPolicyButton").disabled = !state.activeOrgId;
  element("refreshDevicesButton").disabled = !state.activeOrgId;
  if (state.activeOrgId) await loadPolicyAndDevices();
}

async function selectOrganization() {
  const organizationId = element("organization").value;
  if (!organizationId || organizationId === state.activeOrgId) return;
  await request("/v1/me/active-organization", {
    method: "POST",
    body: { organizationId },
  });
  state.activeOrgId = organizationId;
  state.selectedDeviceId = null;
  log("success", "活动组织已切换", { organizationId });
  await loadPolicyAndDevices();
}

async function loadPolicyAndDevices() {
  await Promise.allSettled([loadPolicy(), loadDevices()]);
}

async function loadPolicy() {
  if (!state.token || !state.activeOrgId) return;
  try {
    const payload = await request("/v1/me/desktop-config");
    const gates = payload?.desktopRemoteFeatureGates;
    state.featureGates = gates?.schemaVersion === 1
      ? Object.fromEntries(Object.keys(DISABLED_GATES).map((key) => [key, gates[key] === true]))
      : { ...DISABLED_GATES };
    state.policyVersion = typeof payload?.desktopRemotePolicyVersion === "string"
      ? payload.desktopRemotePolicyVersion
      : null;
  } catch {
    state.featureGates = { ...DISABLED_GATES };
    state.policyVersion = null;
  }
  renderPolicy();
  renderReadiness();
}

async function loadDevices() {
  if (!state.token || !state.activeOrgId) return;
  element("refreshDevicesButton").disabled = true;
  try {
    const payload = await request("/v1/desktop-devices");
    state.devices = Array.isArray(payload?.items) ? payload.items : [];
    if (!state.selectedDeviceId || !state.devices.some((device) => device.id === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices.find((device) => device.presence === "online")?.id || state.devices[0]?.id || null;
    }
    if (state.controlSession && state.controlSession.deviceId !== state.selectedDeviceId) resetRemoteBrowser();
  } catch {
    state.devices = [];
    state.selectedDeviceId = null;
  } finally {
    element("refreshDevicesButton").disabled = !state.activeOrgId;
  }
  renderDevices();
  renderReadiness();
}

function renderPolicy() {
  element("policyVersion").textContent = state.policyVersion || "未返回";
  gateList.innerHTML = "";
  for (const [key, label] of Object.entries(GATE_LABELS)) {
    const enabled = state.featureGates[key] === true;
    const row = document.createElement("div");
    row.className = `gate ${enabled ? "enabled" : ""}`;
    row.innerHTML = `<span></span><span></span>`;
    row.children[0].textContent = label;
    row.children[1].textContent = enabled ? "ENABLED" : "DISABLED";
    gateList.append(row);
  }
}

function renderDevices() {
  deviceList.innerHTML = "";
  if (state.devices.length === 0) {
    deviceList.innerHTML = `<div class="empty-state"><div class="radar"></div><strong>未发现 Desktop 设备</strong><span>设备可能尚未注册，或不属于当前组织</span></div>`;
    return;
  }
  for (const device of state.devices) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `device ${device.id === state.selectedDeviceId ? "selected" : ""}`;
    item.dataset.deviceId = device.id;
    const operations = Array.isArray(device.capabilities?.operations)
      ? device.capabilities.operations.map((entry) => entry.operation)
      : [];
    item.innerHTML = `
      <div class="device-top">
        <div class="device-name">
          <span class="device-dot ${device.presence || "offline"}"></span>
          <div><strong></strong><small></small></div>
        </div>
        <span class="badge ${device.presence === "online" ? "good" : device.presence === "stale" ? "warn" : "neutral"}"></span>
      </div>
      <div class="device-meta"></div>
      <div class="device-operations"></div>`;
    item.querySelector("strong").textContent = device.displayName || device.id;
    item.querySelector("small").textContent = device.id;
    item.querySelector(".badge").textContent = String(device.presence || "offline").toUpperCase();
    const meta = item.querySelector(".device-meta");
    for (const value of [device.platform, `app ${device.appVersion || "—"}`, `protocol v${device.protocolVersion || 0}`, `generation ${device.connectionGeneration || 0}`]) {
      const chip = document.createElement("span");
      chip.textContent = value;
      meta.append(chip);
    }
    const operationNode = item.querySelector(".device-operations");
    operationNode.innerHTML = operations.length
      ? `operations: <code></code>`
      : "operations: none advertised";
    if (operations.length) operationNode.querySelector("code").textContent = operations.join(", ");
    item.addEventListener("click", () => {
      if (state.selectedDeviceId !== device.id) resetRemoteBrowser();
      state.selectedDeviceId = device.id;
      renderDevices();
      renderReadiness();
    });
    deviceList.append(item);
  }
}

function readinessItems() {
  const selected = state.devices.find((device) => device.id === state.selectedDeviceId) || null;
  const operations = selected?.capabilities?.operations?.map((entry) => entry.operation) || [];
  const readOperationsReady = ["workspace.list", "session.list", "session.snapshot"].every((operation) => operations.includes(operation));
  return [
    { title: "Cloud API", pass: state.cloud.ready, detail: state.cloud.ready ? "HTTPS API 可访问" : "Cloud ready 检测未通过" },
    { title: "策略授权", pass: state.featureGates.enrollment && state.featureGates.readOnlyControl, detail: state.featureGates.enrollment && state.featureGates.readOnlyControl ? "Enrollment 与 Read-only 已启用" : "远程控制基础 gates 未启用" },
    { title: "Desktop 在线", pass: selected?.presence === "online" && selected?.localControlEnabled === true, detail: selected ? `${selected.presence} · localControl=${Boolean(selected.localControlEnabled)}` : "尚未选择设备" },
    { title: "只读命令", pass: readOperationsReady, detail: readOperationsReady ? "三个只读 operation 已广告，可通过 command lifecycle 轮询" : operations.length ? `当前仅广告：${operations.join(", ")}` : "Desktop 尚未广告只读 operation；请安装最新测试包" },
  ];
}

function selectedDevice() {
  return state.devices.find((device) => device.id === state.selectedDeviceId) || null;
}

function advertisedOperations(device = selectedDevice()) {
  return Array.isArray(device?.capabilities?.operations)
    ? device.capabilities.operations.flatMap((entry) => typeof entry?.operation === "string" && entry?.payloadVersions?.includes?.(1) ? [entry.operation] : [])
    : [];
}

function resetRemoteBrowser() {
  state.controlGeneration += 1;
  const prior = state.controlSession;
  state.remoteStream?.stop("CLOSED");
  state.remoteStream = null;
  state.controlSession = null;
  state.workspaces = [];
  state.sessions = [];
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.snapshot = null;
  state.remoteModel = null;
  state.remoteEventBuffer = [];
  state.remoteRecovery = null;
  state.remoteStreamState = "CLOSED";
  state.controlBusy = false;
  if (prior?.id && state.token) void request(`/v1/desktop-control-sessions/${encodeURIComponent(prior.id)}`, { method: "DELETE" }).catch(() => undefined);
  renderRemoteBrowser();
  renderSnapshot();
}

async function openControlSession({ workspaceId = null, sessionId = null } = {}) {
  const device = selectedDevice();
  if (!device || device.presence !== "online" || device.localControlEnabled !== true) throw new Error("Desktop 当前不可控制");
  const session = await request("/v1/desktop-control-sessions", {
    method: "POST",
    body: { schemaVersion: 1, deviceId: device.id, workspaceId, sessionId, mode: "view" },
  });
  if (!session?.id || session.deviceId !== device.id) throw new Error("Control session 响应无效");
  return session;
}

async function waitForCommand(controlSessionId, commandId, generation) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (generation !== state.controlGeneration) throw new Error("操作已取消");
    const command = await request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSessionId)}/commands/${encodeURIComponent(commandId)}`);
    if (["succeeded", "failed", "rejected", "expired", "cancelled"].includes(command?.status)) return command;
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
  throw new Error("等待 Desktop 响应超时");
}

async function executeRemoteCommand(controlSession, operation, argumentsValue, generation) {
  const created = await request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}/commands`, {
    method: "POST",
    body: { schemaVersion: 1, operation, payloadVersion: 1, arguments: argumentsValue, idempotencyKey: crypto.randomUUID() },
  });
  if (!created?.commandId) throw new Error("Command 创建响应无效");
  log("info", "command 已创建", { commandId: created.commandId, status: created.status });
  const terminal = await waitForCommand(controlSession.id, created.commandId, generation);
  if (terminal.status !== "succeeded" || terminal.result?.operation !== operation) throw new Error(terminal.error?.message || terminal.error?.code || `Command ${terminal.status}`);
  return { commandId: created.commandId, result: terminal.result.result };
}

async function runRemoteOperation(operation, argumentsValue, scope, { selected = false, withCommand = false } = {}) {
  if (state.controlBusy) throw new Error("已有远程读取正在进行");
  const device = selectedDevice();
  const ops = advertisedOperations(device);
  if (!ops.includes(operation)) throw new Error(`Desktop 未广告 ${operation}（当前广告：${ops.join(", ") || "无"}）`);
  state.controlBusy = true;
  const generation = state.controlGeneration;
  let disposable = null;
  renderRemoteBrowser();
  try {
    const session = selected ? state.controlSession : (disposable = await openControlSession(scope));
    if (!session || generation !== state.controlGeneration) throw new Error("操作已取消");
    const completed = await executeRemoteCommand(session, operation, argumentsValue, generation);
    return withCommand ? completed : completed.result;
  } finally {
    if (disposable?.id) void request(`/v1/desktop-control-sessions/${encodeURIComponent(disposable.id)}`, { method: "DELETE" }).catch(() => undefined);
    if (generation === state.controlGeneration) state.controlBusy = false;
    renderRemoteBrowser();
  }
}

async function loadRemoteWorkspaces() {
  const device = selectedDevice();
  if (state.controlSession) closeSelectedControlSession();
  log("info", "开始读取工作区", { deviceId: state.selectedDeviceId, operations: advertisedOperations(device) });
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.sessions = [];
  state.snapshot = null;
  renderRemoteBrowser();
  renderSnapshot();
  try {
    const result = await runRemoteOperation("workspace.list", {}, {});
    log("info", "workspace.list 返回", result);
    state.workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
    log("success", "workspace.list 完成", { count: state.workspaces.length });
  } catch (error) {
    log("error", "workspace.list 失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "读取工作区失败");
  }
  renderRemoteBrowser();
}

async function selectRemoteWorkspace(workspaceId) {
  if (state.selectedWorkspaceId !== workspaceId) closeSelectedControlSession();
  state.selectedWorkspaceId = workspaceId;
  state.selectedSessionId = null;
  state.sessions = [];
  state.snapshot = null;
  renderRemoteBrowser();
  renderSnapshot();
  try {
    const result = await runRemoteOperation("session.list", { workspaceId }, { workspaceId });
    if (state.selectedWorkspaceId !== workspaceId) return;
    state.sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    log("success", "session.list 完成", { count: state.sessions.length });
  } catch (error) {
    log("error", "session.list 失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "读取会话失败");
  }
  renderRemoteBrowser();
}

async function selectRemoteSession(sessionId) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) return;
  if (state.selectedSessionId === sessionId && state.controlSession) {
    await requestSelectedRecovery("manual_refresh", state.controlGeneration);
    return;
  }
  if (state.selectedSessionId !== sessionId) closeSelectedControlSession();
  state.selectedSessionId = sessionId;
  state.snapshot = null;
  state.remoteStreamState = "CONNECTING";
  renderRemoteBrowser();
  renderSnapshot();
  const generation = state.controlGeneration;
  try {
    const controlSession = await openControlSession({ workspaceId, sessionId });
    if (generation !== state.controlGeneration || state.selectedSessionId !== sessionId) {
      void request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }
    state.controlSession = controlSession;
    state.remoteModel = createRemoteSessionState({ controlSessionId: controlSession.id, deviceId: controlSession.deviceId, workspaceId, sessionId });
    startSelectedStream(generation);
    const completed = await runRemoteOperation("session.snapshot", { workspaceId, sessionId }, { workspaceId, sessionId }, { selected: true, withCommand: true });
    if (generation !== state.controlGeneration || state.selectedSessionId !== sessionId) return;
    await installSelectedSnapshot(completed.result, completed.commandId, false, generation);
    log("success", "session.snapshot 完成", { messages: completed.result?.messages?.length || 0, todos: completed.result?.todos?.length || 0 });
  } catch (error) {
    log("error", "session.snapshot 失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "读取会话快照失败");
  }
  renderRemoteBrowser();
}

async function sendRemotePrompt() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;
  const prompt = element("promptInput").value.trim();
  if (!prompt) return;
  element("sendPromptButton").disabled = true;
  try {
    const result = await runRemoteOperation("session.prompt", { workspaceId, sessionId, prompt }, { workspaceId, sessionId }, { selected: true });
    state.activeRunId = result.runId;
    state.activeRunGeneration = result.generation;
    element("promptPanel").classList.add("hidden");
    element("promptInput").value = "";
    log("success", "Prompt 已提交", { runId: result.runId, generation: result.generation });
    toast("Prompt 已提交到 Desktop");
  } catch (error) {
    log("error", "Prompt 提交失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "Prompt 提交失败");
  } finally {
    element("sendPromptButton").disabled = false;
    renderRemoteBrowser();
  }
}

function closeSelectedControlSession() {
  state.controlGeneration += 1;
  state.remoteStream?.stop("CLOSED");
  state.remoteStream = null;
  const prior = state.controlSession;
  state.controlSession = null;
  state.remoteModel = null;
  state.remoteEventBuffer = [];
  state.remoteRecovery = null;
  state.remoteStreamState = "CLOSED";
  state.activeRunId = null;
  if (prior?.id && state.token) void request(`/v1/desktop-control-sessions/${encodeURIComponent(prior.id)}`, { method: "DELETE" }).catch(() => undefined);
}

function streamHeaders() {
  const headers = { Authorization: `Bearer ${state.token}` };
  if (state.activeOrgId) headers["x-jugglework-org-id"] = state.activeOrgId;
  return headers;
}

function startSelectedStream(generation) {
  const controlSession = state.controlSession;
  state.remoteEventBuffer = [];
  state.remoteStream = createRemoteSessionStream({
    url: `${apiRoot()}/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}/events`,
    headers: streamHeaders,
    onState(value, detail) {
      if (generation !== state.controlGeneration) return;
      state.remoteStreamState = value;
      if (detail) log(value === "ERROR" ? "error" : "info", `SSE ${value}`, { message: detail.message });
      renderRemoteBrowser();
    },
    async onRecord(record) {
      if (generation !== state.controlGeneration) return;
      let envelope;
      try { envelope = JSON.parse(record.data); } catch { return requestSelectedRecovery("malformed_json", generation); }
      if (!state.remoteModel?.installed) {
        if (state.remoteEventBuffer.length >= 1000) return requestSelectedRecovery("buffer_overflow", generation);
        state.remoteEventBuffer.push({ envelope, id: record.id });
        return;
      }
      await applySelectedEnvelope(envelope, record.id, generation);
    },
    async onResync(reason) {
      if (generation === state.controlGeneration) void recreateSelectedControlSession(generation);
    },
    onPoll: () => refreshSelectedSnapshot(generation, true),
    onPermanentError(error) { if (generation === state.controlGeneration) toast(error.message); },
    onClosed() { if (generation === state.controlGeneration) void recreateSelectedControlSession(generation); },
    onLog(message, error) { if (generation === state.controlGeneration) log("info", message, { message: error?.message }); },
  });
  state.remoteStream.start();
}

async function applySelectedEnvelope(envelope, sseId, generation) {
  if (generation !== state.controlGeneration) return;
  try {
    const result = applyRemoteSessionEvent(state.remoteModel, envelope, sseId);
    state.remoteModel = result.state;
    state.snapshot = result.state.snapshot;
    state.activeRunId = result.state.activeRun?.runId || null;
    applyRenderEffects(result.effects);
    if (result.effects.some((effect) => effect.type === "resync")) void requestSelectedRecovery("event_requested", generation);
  } catch (error) {
    if (error instanceof RemoteStateError) {
      if (!state.remoteRecovery) await requestSelectedRecovery(error.message, generation);
      throw error;
    }
    else throw error;
  }
}

async function installSelectedSnapshot(snapshot, commandId, recovery, generation) {
  const deadline = Date.now() + 5_000;
  let boundaryIndex = -1;
  while (generation === state.controlGeneration && boundaryIndex < 0 && Date.now() < deadline) {
    boundaryIndex = state.remoteEventBuffer.findIndex(({ envelope }) => envelope.commandId === commandId &&
      envelope.data?.type === "command.lifecycle" && ["succeeded", "failed", "rejected", "expired", "cancelled"].includes(envelope.data.status));
    if (boundaryIndex < 0) await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  if (generation !== state.controlGeneration) return;
  if (boundaryIndex < 0) throw new Error("Snapshot command lifecycle boundary timed out");
  const boundary = state.remoteEventBuffer[boundaryIndex];
  if (boundary.envelope.data.status !== "succeeded") throw new Error("Snapshot command lifecycle boundary failed");
  const result = establishRemoteSnapshotBaseline(state.remoteModel, snapshot, boundary.envelope, boundary.id, commandId);
  state.remoteModel = result.state;
  state.snapshot = result.state.snapshot;
  state.activeRunId = result.state.activeRun?.runId || null;
  renderSnapshot();
  const buffered = state.remoteEventBuffer.slice(boundaryIndex + 1);
  state.remoteEventBuffer = [];
  for (const record of buffered) await applySelectedEnvelope(record.envelope, record.id, state.controlGeneration);
  if (recovery && state.remoteStreamState !== "POLLING") state.remoteStreamState = "LIVE";
  renderRemoteBrowser();
}

async function refreshSelectedSnapshot(generation, recovery = false) {
  if (generation !== state.controlGeneration || !state.controlSession) return;
  while (state.controlBusy && generation === state.controlGeneration) await new Promise((resolve) => window.setTimeout(resolve, 100));
  if (generation !== state.controlGeneration || !state.controlSession) return;
  const { selectedWorkspaceId: workspaceId, selectedSessionId: sessionId } = state;
  state.remoteModel = { ...state.remoteModel, installed: false };
  const completed = await runRemoteOperation("session.snapshot", { workspaceId, sessionId }, { workspaceId, sessionId }, { selected: true, withCommand: true });
  if (generation === state.controlGeneration) await installSelectedSnapshot(completed.result, completed.commandId, recovery, generation);
}

function requestSelectedRecovery(reason, generation) {
  if (generation !== state.controlGeneration) return Promise.resolve();
  if (state.remoteRecovery) return state.remoteRecovery;
  state.remoteStreamState = "RESYNCING";
  renderRemoteBrowser();
  state.remoteRecovery = refreshSelectedSnapshot(generation, true)
    .catch((error) => {
      if (generation !== state.controlGeneration) return;
      log("error", "快照恢复失败", { reason, message: error.message });
      void recreateSelectedControlSession(generation);
    })
    .finally(() => { if (generation === state.controlGeneration) state.remoteRecovery = null; });
  return state.remoteRecovery;
}

async function recreateSelectedControlSession(generation) {
  if (generation !== state.controlGeneration || !state.selectedWorkspaceId || !state.selectedSessionId) return;
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  closeSelectedControlSession();
  await selectRemoteSession(sessionId);
  if (state.selectedWorkspaceId !== workspaceId) closeSelectedControlSession();
}

async function abortRemoteRun() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !state.activeRunId) return;
  try {
    await runRemoteOperation("session.abort", { workspaceId, sessionId, expectedRunId: state.activeRunId }, { workspaceId, sessionId }, { selected: true });
    log("success", "Abort 已请求", { runId: state.activeRunId });
    toast("Abort 请求已发送");
    state.activeRunId = null;
  } catch (error) {
    log("error", "Abort 失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "Abort 失败");
  } finally {
    renderRemoteBrowser();
  }
}

function renderRemoteBrowser() {
  const operations = advertisedOperations();
  const unsafe = state.controlBusy || ["RESYNCING", "CLOSED", "ERROR"].includes(state.remoteStreamState);
  const buttonElements = [...document.querySelectorAll("[data-operation]")];
  for (const button of buttonElements) {
    const operation = button.dataset.operation;
    if (operation === "workspace.list") {
      button.disabled = state.controlBusy || !operations.includes("workspace.list");
    } else if (operation === "session.list") {
      button.disabled = state.controlBusy || !state.selectedWorkspaceId || !operations.includes("session.list");
    } else if (operation === "session.snapshot") {
      button.disabled = state.controlBusy || !state.selectedSessionId || !operations.includes("session.snapshot");
    } else if (operation === "session.prompt") {
      button.disabled = unsafe || !state.selectedSessionId || !operations.includes("session.prompt");
    } else if (operation === "session.abort") {
      button.disabled = unsafe || !state.activeRunId || !operations.includes("session.abort");
    }
  }
  const sendButton = element("sendPromptButton");
  if (sendButton) sendButton.disabled = unsafe || !state.selectedSessionId;
  element("workspaceCount").textContent = String(state.workspaces.length);
  element("sessionCount").textContent = String(state.sessions.length);
  element("snapshotStatus").textContent = state.remoteStreamState;
  element("snapshotStatus").className = `stream-state ${state.remoteStreamState.toLowerCase()}`;

  const workspaces = element("workspaceList");
  workspaces.innerHTML = "";
  if (!state.workspaces.length) workspaces.innerHTML = `<div class="browser-empty ${state.controlBusy ? "browser-loading" : ""}">${state.controlBusy ? "正在读取 Desktop…" : "点击 workspace.list 读取远程可见工作区"}</div>`;
  for (const workspace of state.workspaces) {
    const button = document.createElement("button");
    button.className = `browser-item ${workspace.id === state.selectedWorkspaceId ? "selected" : ""}`;
    button.innerHTML = "<strong></strong><small></small>";
    button.querySelector("strong").textContent = workspace.name;
    button.querySelector("small").textContent = workspace.id;
    button.addEventListener("click", () => void selectRemoteWorkspace(workspace.id));
    workspaces.append(button);
  }

  const sessions = element("sessionList");
  sessions.innerHTML = "";
  if (!state.sessions.length) sessions.innerHTML = `<div class="browser-empty ${state.controlBusy ? "browser-loading" : ""}">${state.selectedWorkspaceId ? "此工作区暂无会话或正在读取" : "选择工作区后读取会话"}</div>`;
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `browser-item ${session.id === state.selectedSessionId ? "selected" : ""}`;
    button.innerHTML = "<strong></strong><small></small>";
    button.querySelector("strong").textContent = session.title;
    button.querySelector("small").textContent = `${session.status} · ${new Date(session.updatedAt).toLocaleString("zh-CN")}`;
    button.addEventListener("click", () => void selectRemoteSession(session.id));
    sessions.append(button);
  }
}

function renderSnapshot() {
  const root = element("snapshot");
  root.innerHTML = "";
  const snapshot = state.snapshot;
  const model = state.remoteModel;
  if (!snapshot) {
    root.innerHTML = `<div class="browser-empty ${state.controlBusy ? "browser-loading" : ""}">${state.controlBusy ? "正在等待 Desktop 快照…" : "选择会话后读取只读快照"}</div>`;
    return;
  }
  const header = document.createElement("div");
  header.className = "snapshot-header";
  header.innerHTML = "<strong></strong><span></span>";
  header.querySelector("strong").textContent = snapshot.session?.title || "Session";
  header.querySelector("span").textContent = `${snapshot.workspace?.name || "Workspace"} · captured ${new Date(snapshot.capturedAt).toLocaleString("zh-CN")}`;
  root.append(header);
  const summary = document.createElement("div");
  summary.className = "session-summary";
  summary.dataset.section = "status";
  root.append(summary);
  renderSessionSummary();
  const messagesSection = document.createElement("section");
  messagesSection.className = "snapshot-section";
  messagesSection.dataset.section = "messages";
  messagesSection.innerHTML = `<strong>Messages · <span></span></strong><div class="message-list"></div>`;
  const messageIds = model?.messageOrder || snapshot.messages.map((message) => message.id);
  messagesSection.querySelector("strong span").textContent = String(messageIds.length);
  for (const messageId of messageIds) messagesSection.querySelector(".message-list").append(createMessageNode(model?.messages.get(messageId) || snapshot.messages.find((message) => message.id === messageId)));
  root.append(messagesSection);
  const todos = document.createElement("section");
  todos.className = "snapshot-section";
  todos.dataset.section = "todos";
  root.append(todos);
  renderTodos();
  const interactions = document.createElement("section");
  interactions.className = "snapshot-section";
  interactions.dataset.section = "interactions";
  root.append(interactions);
  renderInteractions();
}

function domKey(value) { return encodeURIComponent(value); }

function createPartNode(part) {
  const node = document.createElement("div");
  node.dataset.partId = domKey(part.id);
  if (part.type === "tool") {
    node.className = "tool-part";
    node.textContent = `${part.name} · ${part.status}${part.title ? ` · ${part.title}` : ""}`;
  } else {
    node.className = `message-part ${part.type}`;
    node.textContent = part.text;
  }
  return node;
}

function createMessageNode(message) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.messageId = domKey(message.id);
  const role = document.createElement("div");
  role.className = "message-role";
  role.textContent = message.role;
  article.append(role);
  for (const part of message.parts) article.append(createPartNode(part));
  return article;
}

function renderTodos() {
  const root = element("snapshot").querySelector('[data-section="todos"]');
  if (!root || !state.remoteModel) return;
  root.innerHTML = `<strong>Todos · ${state.remoteModel.todoOrder.length}</strong>`;
  for (const id of state.remoteModel.todoOrder) {
    const todo = state.remoteModel.todos.get(id);
    const row = document.createElement("div");
    row.className = "todo-row";
    row.innerHTML = "<span></span><span></span>";
    row.children[0].textContent = todo.status;
    row.children[1].textContent = todo.content;
    root.append(row);
  }
}

function renderInteractions() {
  const root = element("snapshot").querySelector('[data-section="interactions"]');
  if (!root || !state.remoteModel) return;
  root.innerHTML = `<strong>Interactions · ${state.remoteModel.interactionOrder.length}</strong>`;
  for (const id of state.remoteModel.interactionOrder) {
    const item = state.remoteModel.interactions.get(id);
    const row = document.createElement("div");
    row.className = "interaction-row";
    const label = document.createElement("div");
    label.textContent = `${item.type} · ${item.status} · ${item.title}`;
    row.append(label);
    if (item.status === "pending" && item.type === "permission") {
      for (const response of item.permittedResponses) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = response === "allow_once" ? "Allow once" : "Reject";
        button.disabled = state.remoteStreamState !== "LIVE";
        button.addEventListener("click", () => void replyToInteraction(item, response));
        row.append(button);
      }
    } else if (item.status === "pending" && item.type === "question") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Answer";
      button.disabled = state.remoteStreamState !== "LIVE";
      button.addEventListener("click", () => void replyToQuestion(item));
      row.append(button);
    }
    root.append(row);
  }
}

function renderSessionSummary() {
  const root = element("snapshot").querySelector('[data-section="status"]');
  if (!root || !state.remoteModel) return;
  const status = state.remoteModel.snapshot?.session?.status || "unknown";
  const run = state.remoteModel.activeRun;
  root.innerHTML = "<strong></strong><span></span>";
  root.querySelector("strong").textContent = `SESSION ${status.toUpperCase()}`;
  root.querySelector("span").textContent = run ? `run ${run.runId} · ${run.status}` : state.remoteModel.lastError?.message || "no active run";
  root.classList.toggle("has-error", Boolean(state.remoteModel.lastError));
}

async function replyToInteraction(interaction, response) {
  try {
    await runRemoteOperation("interaction.permission.reply", { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId, interactionId: interaction.id, response }, { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId }, { selected: true });
  } catch (error) { toast(error.message || "Interaction reply failed"); }
}

async function replyToQuestion(interaction) {
  const answers = [];
  for (const question of interaction.questions) {
    const value = window.prompt(question.prompt, "");
    if (value === null) return;
    const values = question.multiple ? value.split("\n").map((item) => item.trim()).filter(Boolean) : [value];
    if (!values.length) return;
    answers.push({ questionId: question.id, values });
  }
  try {
    await runRemoteOperation("interaction.question.reply", { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId, interactionId: interaction.id, answers }, { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId }, { selected: true });
  } catch (error) { toast(error.message || "Question reply failed"); }
}

function applyRenderEffects(effects) {
  const model = state.remoteModel;
  for (const effect of effects) {
    if (effect.type === "snapshot") { renderSnapshot(); continue; }
    if (effect.type === "message.upsert") {
      const list = element("snapshot").querySelector(".message-list");
      const prior = list?.querySelector(`[data-message-id="${CSS.escape(domKey(effect.messageId))}"]`);
      const node = createMessageNode(model.messages.get(effect.messageId));
      if (prior) prior.replaceWith(node); else list?.append(node);
    } else if (effect.type === "message.remove") {
      element("snapshot").querySelector(`[data-message-id="${CSS.escape(domKey(effect.messageId))}"]`)?.remove();
    } else if (effect.type === "message.part.upsert") {
      const message = model.messages.get(effect.messageId);
      const part = message.parts.find((item) => item.id === effect.partId);
      const article = element("snapshot").querySelector(`[data-message-id="${CSS.escape(domKey(effect.messageId))}"]`);
      const prior = article?.querySelector(`[data-part-id="${CSS.escape(domKey(effect.partId))}"]`);
      const node = createPartNode(part);
      if (prior) prior.replaceWith(node); else article?.append(node);
    } else if (effect.type === "todos.replace") renderTodos();
    else if (effect.type.startsWith("interaction.")) renderInteractions();
    else if (effect.type === "session.status" || effect.type === "run.status") { renderSessionSummary(); renderRemoteBrowser(); }
  }
}

function renderReadiness() {
  readiness.innerHTML = "";
  const items = readinessItems();
  for (const item of items) {
    const node = document.createElement("div");
    node.className = `check ${item.pass ? "pass" : "fail"}`;
    node.innerHTML = `<div class="check-head"><strong></strong><span class="check-mark"></span></div><p></p>`;
    node.querySelector("strong").textContent = item.title;
    node.querySelector(".check-mark").textContent = item.pass ? "✓" : "×";
    node.querySelector("p").textContent = item.detail;
    readiness.append(node);
  }
  const allReady = items.every((item) => item.pass);
  setBadge(element("controlBadge"), allReady ? "READY" : "BLOCKED", allReady ? "good" : "warn");
  renderRemoteBrowser();
}

function logout() {
  resetRemoteBrowser();
  state.token = null;
  state.user = null;
  state.organizations = [];
  state.activeOrgId = null;
  state.featureGates = { ...DISABLED_GATES };
  state.policyVersion = null;
  state.devices = [];
  state.selectedDeviceId = null;
  element("organization").innerHTML = '<option value="">登录后加载</option>';
  element("organization").disabled = true;
  element("refreshPolicyButton").disabled = true;
  element("refreshDevicesButton").disabled = true;
  element("loginButton").classList.remove("hidden");
  element("logoutButton").classList.add("hidden");
  setBadge(element("authBadge"), "未登录", "neutral");
  renderPolicy();
  renderDevices();
  renderReadiness();
  log("info", "本地登录状态已清除");
}

function report() {
  const selected = state.devices.find((device) => device.id === state.selectedDeviceId) || null;
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    server: (() => { try { return normalizeBaseUrl(baseUrlInput.value); } catch { return "invalid"; } })(),
    cloud: state.cloud,
    authenticated: Boolean(state.token),
    user: state.user ? { id: state.user.id, account: state.user.account, email: state.user.email } : null,
    activeOrgId: state.activeOrgId,
    policyVersion: state.policyVersion,
    featureGates: state.featureGates,
    deviceCount: state.devices.length,
    selectedDevice: selected ? {
      id: selected.id,
      displayName: selected.displayName,
      presence: selected.presence,
      localControlEnabled: selected.localControlEnabled,
      appVersion: selected.appVersion,
      protocolVersion: selected.protocolVersion,
      capabilities: selected.capabilities,
    } : null,
    controllerRelayImplemented: true,
    controllerSSEImplemented: true,
    controllerStreamState: state.remoteStreamState,
  }, null, 2);
}

function wireEvents() {
  element("healthButton").addEventListener("click", checkCloud);
  baseUrlInput.addEventListener("change", () => { logout(); void checkCloud(); });
  element("loginForm").addEventListener("submit", login);
  element("logoutButton").addEventListener("click", logout);
  element("organization").addEventListener("change", () => void selectOrganization());
  element("refreshPolicyButton").addEventListener("click", () => void loadPolicy());
  element("refreshDevicesButton").addEventListener("click", () => void loadDevices());
  element("clearLogButton").addEventListener("click", () => { logElement.innerHTML = ""; });
  element("copyReportButton").addEventListener("click", async () => {
    await navigator.clipboard.writeText(report());
    toast("诊断报告已复制");
  });
  document.querySelector('[data-operation="workspace.list"]').addEventListener("click", () => void loadRemoteWorkspaces());
  document.querySelector('[data-operation="session.list"]').addEventListener("click", () => state.selectedWorkspaceId && void selectRemoteWorkspace(state.selectedWorkspaceId));
  document.querySelector('[data-operation="session.snapshot"]').addEventListener("click", () => state.selectedSessionId && void selectRemoteSession(state.selectedSessionId));
  document.querySelector('[data-operation="session.prompt"]').addEventListener("click", () => {
    if (!state.selectedSessionId) return;
    element("promptPanel").classList.remove("hidden");
    element("promptInput").focus();
  });
  document.querySelector('[data-operation="session.abort"]').addEventListener("click", () => state.activeRunId && void abortRemoteRun());
  element("cancelPromptButton").addEventListener("click", () => {
    element("promptPanel").classList.add("hidden");
    element("promptInput").value = "";
  });
  element("sendPromptButton").addEventListener("click", () => void sendRemotePrompt());
  for (const button of document.querySelectorAll("[data-login-mode]")) {
    button.addEventListener("click", () => {
      state.loginMode = button.dataset.loginMode;
      document.querySelectorAll("[data-login-mode]").forEach((node) => node.classList.toggle("active", node === button));
      element("identityLabel").textContent = state.loginMode === "email" ? "邮箱" : "账号";
      element("identity").placeholder = state.loginMode === "email" ? "输入 Cloud 邮箱" : "输入 Cloud 账号";
    });
  }
  window.setInterval(() => {
    if (state.token && element("autoRefresh").checked && !document.hidden) void loadDevices();
  }, 10_000);
}

renderPolicy();
renderReadiness();
wireEvents();
log("info", "诊断台已启动；敏感凭证不会写入浏览器存储");
void checkCloud();
