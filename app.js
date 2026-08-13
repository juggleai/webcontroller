import { applyRemoteSessionEvent, createRemoteSessionState, establishRemoteSnapshotBaseline, scheduleRemoteStateRecovery } from "./remote-session-state.js";
import { createRemoteSessionStream } from "./remote-session-stream.js";
import { controlSessionExpiry, createCloudRequestError, createRenewalState, isMutationOperation, transitionRenewal } from "./control-session-renewal.js";
import { createBrowserNotificationController, notificationForDeviceTransition, notificationForRemoteEvent, notificationForStreamTransition } from "./remote-notifications.js";
import { canCreateSession, normalizeSessionTitle, SessionCreationMachine } from "./session-creation.js";
import {
  commandAAD,
  encryptRemoteControlPayload,
  formatE2EEFingerprint,
  sha256Hex,
} from "./remote-e2ee.js";
import { immutableEncryptionBinding, negotiateEncryptedControlSession } from "./e2ee-negotiation.js";
import { decryptControllerCommandTerminal, decryptControllerEventEnvelope } from "./remote-e2ee-envelope.js";
import { createPendingEnqueueState, isDefinitiveEnqueueOutcome, prepareEnqueueSubmission, resolveBusyMode, validRemotePrompt } from "./busy-session-state.js";
import { decideWorkspaceActivation } from "./workspace-selection.js";

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
  controlRenewal: createRenewalState(),
  workspaces: [],
  sessions: [],
  selectedWorkspaceId: null,
  selectedSessionId: null,
  snapshot: null,
  controlGeneration: 0,
  controlBusy: false,
  sessionCreationAttempt: null,
  activeRunId: null,
  activeRunGeneration: 0,
  pendingEnqueues: createPendingEnqueueState(100, window.localStorage),
  remoteModel: null,
  remoteStream: null,
  remoteStreamState: "CLOSED",
  remoteConnectionEpoch: 0,
  remoteEventBuffer: [],
  remoteRecovery: null,
  encryptedSessions: new Map(),
  encryptedCommandAttempts: new Map(),
};

const element = (id) => document.getElementById(id);
const baseUrlInput = element("baseUrl");
const logElement = element("log");
const gateList = element("gateList");
const deviceList = element("deviceList");
const readiness = element("readiness");
const notifications = createBrowserNotificationController({
  focus() {
    window.focus();
    element("remoteBrowser")?.scrollIntoView({ block: "start", behavior: "smooth" });
  },
});

const sessionCreation = new SessionCreationMachine({
  currentContext() {
    const device = selectedDevice();
    return {
      deviceId: state.selectedDeviceId,
      controlGeneration: state.controlGeneration,
      workspaceId: state.selectedWorkspaceId,
      accountId: state.user?.id ?? null,
      organizationId: state.activeOrgId,
      encryptionBinding: state.sessionCreationAttempt?.controlSession
        ? immutableEncryptionBinding(state.sessionCreationAttempt.controlSession, state.encryptedSessions.get(state.sessionCreationAttempt.controlSession.id))
        : null,
    };
  },
  createKey: () => crypto.randomUUID(),
  openControlSession,
  async renewControlSession(controlSession) {
    const renewed = await request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}/renew`, {
      method: "POST",
      body: { schemaVersion: 1 },
    });
    if (renewed?.id !== controlSession.id || renewed.deviceId !== controlSession.deviceId || renewed.status !== "active") {
      throw new Error("Workspace control session renewal response is invalid");
    }
    return renewed;
  },
  executeCreate: runSessionCreationCommand,
  resumeCommand: resumeSessionCreationCommand,
  listSessions: refreshRemoteSessions,
  establishBaseline: (sessionId) => selectRemoteSession(sessionId, { propagateFailure: true }),
  disposeControlSession(controlSession) {
    dropEncryptedControlSession(controlSession?.id);
    return request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}`, { method: "DELETE" });
  },
  onChange(attempt) {
    state.sessionCreationAttempt = attempt;
    renderSessionCreationGuidance();
    renderRemoteBrowser();
  },
});

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

function showView(name) {
  const views = {
    login: element("loginView"),
    devices: element("deviceView"),
    detail: element("detailView"),
  };
  for (const [key, node] of Object.entries(views)) node?.classList.toggle("hidden", key !== name);
  document.body.dataset.view = name;
  window.scrollTo(0, 0);
}

function showDeviceList() {
  resetRemoteBrowser();
  showView("devices");
  renderDevices();
}

function openDeviceDetail(deviceId) {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device || device.presence !== "online") return;
  if (state.selectedDeviceId !== device.id) {
    resetRemoteBrowser();
    state.pendingEnqueues.clear();
  }
  state.selectedDeviceId = device.id;
  state.workspaces = [];
  state.sessions = [];
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  element("detailPageTitle").textContent = device.displayName || device.id;
  element("detailDeviceMeta").textContent = `${device.platform || "Desktop"} · app ${device.appVersion || "—"} · online`;
  showView("detail");
  renderReadiness();
  void loadRemoteWorkspaces();
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
    throw createCloudRequestError(payload, response.status);
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
    element("loginCloudDot").className = `status-dot ${response.ok ? "online" : "error"}`;
    element("loginCloudStatus").textContent = response.ok ? "Cloud 已连接" : "Cloud 响应异常";
  } catch (error) {
    metric(0, "FAILED", "bad");
    metric(1, "FAILED", "bad");
    metric(2, "UNKNOWN", "bad");
    element("cloudPulse").className = "pulse error";
    element("cloudLabel").textContent = "连接失败";
    element("loginCloudDot").className = "status-dot error";
    element("loginCloudStatus").textContent = "Cloud 连接失败";
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
    log("success", "登录成功，token 已保存在页面内存");
    await loadOrganizations();
    showView("devices");
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
  fenceAuthenticatedOperationalState();
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
  resetRemoteBrowser();
  state.activeOrgId = organizationId;
  state.selectedDeviceId = null;
  fenceAuthenticatedOperationalState();
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
  const selectedBeforeRefresh = state.selectedDeviceId;
  const previousDevices = new Map(state.devices.map((device) => [device.id, device]));
  const activeDeviceId = state.selectedSessionId ? state.selectedDeviceId : null;
  try {
    const payload = await request("/v1/desktop-devices");
    state.devices = Array.isArray(payload?.items) ? payload.items : [];
    const attempt = state.sessionCreationAttempt;
    if (attempt && !state.devices.some((device) => device.id === attempt.deviceId)) sessionCreation.fence();
    if (activeDeviceId) {
      notifications.notify(notificationForDeviceTransition(
        previousDevices.get(activeDeviceId),
        state.devices.find((device) => device.id === activeDeviceId),
        { active: state.selectedDeviceId === activeDeviceId && Boolean(state.selectedSessionId) },
      ));
    }
    if (!state.selectedDeviceId || !state.devices.some((device) => device.id === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices.find((device) => device.presence === "online")?.id || state.devices[0]?.id || null;
    }
    if (selectedBeforeRefresh && state.selectedDeviceId !== selectedBeforeRefresh) state.pendingEnqueues.clear();
    if (state.controlSession && state.controlSession.deviceId !== state.selectedDeviceId) resetRemoteBrowser();
  } catch {
    state.devices = [];
    state.selectedDeviceId = null;
    if (selectedBeforeRefresh) state.pendingEnqueues.clear();
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
  const onlineCount = state.devices.filter((device) => device.presence === "online").length;
  element("onlineDeviceCount").textContent = String(onlineCount);
  element("totalDeviceCount").textContent = `${state.devices.length} 台设备`;
  if (state.devices.length === 0) {
    deviceList.innerHTML = `<div class="empty-state"><div class="radar"></div><strong>未发现 Desktop 设备</strong><span>设备可能尚未注册，或不属于当前组织</span></div>`;
    return;
  }
  for (const device of state.devices) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `device ${device.presence || "offline"}`;
    item.dataset.deviceId = device.id;
    item.disabled = Boolean(state.sessionCreationAttempt) || device.presence !== "online";
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
      <div class="device-operations"></div>
      <div class="device-enter"><span>${device.presence === "online" ? "打开控制台" : "当前不可用"}</span><span aria-hidden="true">→</span></div>`;
    item.querySelector("strong").textContent = device.displayName || device.id;
    item.querySelector("small").textContent = device.id;
    item.querySelector(".badge").textContent = String(device.presence || "offline").toUpperCase();
    const meta = item.querySelector(".device-meta");
    for (const value of [device.platform, `app ${device.appVersion || "—"}`, `protocol v${device.protocolVersion || 0}`, `generation ${device.connectionGeneration || 0}`]) {
      const chip = document.createElement("span");
      chip.textContent = value;
      meta.append(chip);
    }
    if (device.payloadEncryption?.signingIdentity?.fingerprint) {
      const fingerprint = document.createElement("code");
      fingerprint.className = "device-fingerprint";
      fingerprint.title = "Compare through an independent channel. This page cannot defend against actively malicious Cloud-delivered JavaScript.";
      fingerprint.textContent = `identity ${formatE2EEFingerprint(device.payloadEncryption.signingIdentity.fingerprint)}`;
      meta.append(fingerprint);
    }
    const operationNode = item.querySelector(".device-operations");
    operationNode.innerHTML = operations.length
      ? `operations: <code></code>`
      : "operations: none advertised";
    if (operations.length) operationNode.querySelector("code").textContent = operations.join(", ");
    item.addEventListener("click", () => openDeviceDetail(device.id));
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

function authenticatedOperationalScope() {
  let serverOrigin;
  try { serverOrigin = new URL(normalizeBaseUrl(baseUrlInput.value)).origin; } catch { return null; }
  return state.user?.id && state.activeOrgId
    ? { serverOrigin, accountId: state.user.id, organizationId: state.activeOrgId }
    : null;
}

function selectedOperationalScope(deviceId, workspaceId, sessionId) {
  const authenticated = authenticatedOperationalScope();
  return authenticated ? { ...authenticated, deviceId, workspaceId, sessionId } : null;
}

function fenceAuthenticatedOperationalState() {
  const authenticated = authenticatedOperationalScope();
  if (authenticated) state.pendingEnqueues.fenceAuthentication(authenticated);
  else state.pendingEnqueues.clear();
}

function dropEncryptedControlSession(controlSessionId) {
  if (!controlSessionId) return;
  state.encryptedSessions.delete(controlSessionId);
  for (const key of state.encryptedCommandAttempts.keys()) {
    if (key.startsWith(`${controlSessionId}\0`)) state.encryptedCommandAttempts.delete(key);
  }
}

function advertisedOperations(device = selectedDevice()) {
  return Array.isArray(device?.capabilities?.operations)
    ? device.capabilities.operations.flatMap((entry) => typeof entry?.operation === "string" && entry?.payloadVersions?.includes?.(1) ? [entry.operation] : [])
    : [];
}

function resetRemoteBrowser() {
  sessionCreation.fence();
  state.controlGeneration += 1;
  const prior = state.controlSession;
  state.remoteStream?.stop("CLOSED");
  state.remoteStream = null;
  state.controlSession = null;
  state.controlRenewal = createRenewalState();
  state.workspaces = [];
  state.sessions = [];
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.snapshot = null;
  state.remoteModel = null;
  state.remoteEventBuffer = [];
  state.remoteRecovery = null;
  state.remoteStreamState = "CLOSED";
  state.remoteConnectionEpoch = 0;
  state.controlBusy = false;
  state.pendingEnqueues.setScope(null);
  state.encryptedSessions.clear();
  state.encryptedCommandAttempts.clear();
  if (prior?.id && state.token) void request(`/v1/desktop-control-sessions/${encodeURIComponent(prior.id)}`, { method: "DELETE" }).catch(() => undefined);
  renderRemoteBrowser();
  renderSnapshot();
}

async function openControlSession({ workspaceId = null, sessionId = null } = {}) {
  const device = selectedDevice();
  if (!device || device.presence !== "online" || device.localControlEnabled !== true) throw new Error("Desktop 当前不可控制");
  const encryptionRequired = state.featureGates.payloadEncryption === true;
  const desktopEncryption = device.payloadEncryption;
  if (encryptionRequired && (desktopEncryption?.mode !== "e2ee-v1" || !device.capabilities?.features?.includes?.("payload.e2ee-v1"))) {
    throw new Error("Desktop did not advertise required end-to-end encryption");
  }
  if (encryptionRequired) {
    const negotiated = await negotiateEncryptedControlSession({ device, workspaceId, sessionId, request });
    state.encryptedSessions.set(negotiated.controlSession.id, negotiated.encryption);
    return negotiated.controlSession;
  }
  const session = await request("/v1/desktop-control-sessions", {
    method: "POST",
    body: {
      schemaVersion: 1, deviceId: device.id, workspaceId, sessionId, mode: "view",
    },
  });
  if (!session?.id || session.deviceId !== device.id) throw new Error("Control session 响应无效");
  if (session.payloadEncryption?.mode === "e2ee-v1") {
    throw new Error("Unexpected encrypted control session");
  }
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

async function decryptCommandTerminal(controlSession, operation, terminal) {
  return decryptControllerCommandTerminal({
    terminal,
    encryption: state.encryptedSessions.get(controlSession.id) || null,
    controlSessionId: controlSession.id,
    deviceId: controlSession.deviceId,
    operation,
  });
}

async function executeRemoteCommand(controlSession, operation, argumentsValue, generation, idempotencyKey = crypto.randomUUID(), onCommand = null) {
  let created;
  try {
    const encryption = state.encryptedSessions.get(controlSession.id);
    const workspaceId = typeof argumentsValue.workspaceId === "string" ? argumentsValue.workspaceId : null;
    const sessionId = typeof argumentsValue.sessionId === "string" ? argumentsValue.sessionId : null;
    const plaintextRequest = { operation, payloadVersion: 1, arguments: argumentsValue };
    let encryptedPayload = null;
    let payloadHash = null;
    if (encryption) {
      const attemptKey = `${controlSession.id}\0${idempotencyKey}`;
      const canonicalRequest = JSON.stringify(plaintextRequest);
      const prior = state.encryptedCommandAttempts.get(attemptKey);
      if (prior && prior.canonicalRequest !== canonicalRequest) throw new Error("Idempotency key conflicts with a prior encrypted command");
      if (prior) ({ encryptedPayload, payloadHash } = prior);
      else {
        encryptedPayload = await encryptRemoteControlPayload({
          key: encryption.outboundKey,
          aad: commandAAD({ controlSessionId: controlSession.id, deviceId: controlSession.deviceId, operation, workspaceId, sessionId, idempotencyKey, desktopKeyId: encryption.desktopKeyId, desktopStatementHash: encryption.desktopStatementHash, controllerKeyId: encryption.controllerKeyId }),
          value: plaintextRequest,
        });
        payloadHash = await sha256Hex(JSON.stringify(encryptedPayload));
        state.encryptedCommandAttempts.set(attemptKey, { canonicalRequest, encryptedPayload, payloadHash });
      }
    }
    created = await request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}/commands`, {
      method: "POST",
      body: encryption ? {
        schemaVersion: 1, operation, payloadVersion: 1, idempotencyKey,
        payloadEncryption: { mode: "e2ee-v1", desktopKeyId: encryption.desktopKeyId, controllerKeyId: encryption.controllerKeyId },
        routing: { workspaceId, sessionId, payloadHash }, encryptedPayload,
      } : { schemaVersion: 1, operation, payloadVersion: 1, arguments: argumentsValue, idempotencyKey },
    });
  } catch (error) {
    const definitiveClientRejection = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 500 &&
      error?.code !== "idempotency_conflict";
    error.ambiguousMutation = isMutationOperation(operation) && !definitiveClientRejection;
    error.definitiveNonEnqueued = definitiveClientRejection;
    throw error;
  }
  if (!created?.commandId || created.controlSessionId !== controlSession.id || created.deviceId !== controlSession.deviceId || created.idempotencyKey !== idempotencyKey) {
    const error = new Error("Command 创建响应无效");
    error.ambiguousMutation = isMutationOperation(operation);
    throw error;
  }
  onCommand?.(created.commandId, created.controlSessionId);
  log("info", "command 已创建", { commandId: created.commandId, status: created.status });
  let terminal;
  try {
    terminal = await waitForCommand(created.controlSessionId, created.commandId, generation);
  } catch (error) {
    error.ambiguousMutation = isMutationOperation(operation);
    throw error;
  }
  return completeRemoteCommand(operation, created.controlSessionId, created.commandId, terminal);
}

async function completeRemoteCommand(operation, controlSessionId, commandId, terminal) {
  const controlSession = {
    id: controlSessionId,
    deviceId: state.controlSession?.deviceId || selectedDevice()?.id,
  };
  const encryption = state.encryptedSessions.get(controlSessionId);
  if (terminal?.payloadEncryption?.mode === "e2ee-v1" && !encryption) {
    if (terminal.status === "succeeded") return { commandId, result: null, reconcile: true };
    const error = new Error(terminal.controlSignal?.errorCode || `Command ${terminal.status}`);
    if (typeof terminal.controlSignal?.errorCode === "string") error.code = terminal.controlSignal.errorCode;
    error.safeTerminal = true;
    throw error;
  }
  try {
    terminal = await decryptCommandTerminal(controlSession, operation, terminal);
  } catch (error) {
    error.safeTerminal = true;
    throw error;
  }
  if (terminal.status !== "succeeded") {
    const error = new Error(terminal.error?.message || terminal.error?.code || `Command ${terminal.status}`);
    if (typeof terminal.error?.code === "string") error.code = terminal.error.code;
    error.safeTerminal = true;
    throw error;
  }
  if (terminal.result?.operation !== operation) {
    const error = new Error("Command terminal result operation is invalid");
    error.safeTerminal = true;
    throw error;
  }
  return { commandId, result: terminal.result.result, reconcile: false };
}

async function resumeRemoteCommand(operation, controlSessionId, commandId, generation) {
  const terminal = await waitForCommand(controlSessionId, commandId, generation);
  return completeRemoteCommand(operation, controlSessionId, commandId, terminal);
}

async function runSessionCreationCommand({ controlSession, arguments: argumentsValue, idempotencyKey, onCommand }) {
  if (state.controlBusy) throw new Error("Another remote operation is in progress");
  const generation = state.controlGeneration;
  state.controlBusy = true;
  renderRemoteBrowser();
  try {
    const completed = await executeRemoteCommand(controlSession, "session.create", argumentsValue, generation, idempotencyKey, onCommand);
    return completed.result;
  } finally {
    if (generation === state.controlGeneration) state.controlBusy = false;
    renderRemoteBrowser();
  }
}

async function resumeSessionCreationCommand(controlSession, commandId) {
  if (state.controlBusy) throw new Error("Another remote operation is in progress");
  const generation = state.controlGeneration;
  state.controlBusy = true;
  renderRemoteBrowser();
  try {
    const terminal = await decryptCommandTerminal(controlSession, "session.create", await waitForCommand(controlSession.id, commandId, generation));
    if (terminal.status !== "succeeded" || terminal.result?.operation !== "session.create") {
      const error = new Error(terminal.error?.message || terminal.error?.code || `Command ${terminal.status}`);
      if (typeof terminal.error?.code === "string") error.code = terminal.error.code;
      throw error;
    }
    return terminal.result.result;
  } finally {
    if (generation === state.controlGeneration) state.controlBusy = false;
    renderRemoteBrowser();
  }
}

function applyRenewalEvent(event) {
  const result = transitionRenewal(state.controlRenewal, event);
  state.controlRenewal = result.state;
  renderRemoteBrowser();
  renderInteractions();
  return result;
}

async function runRemoteOperation(operation, argumentsValue, scope, { selected = false, withCommand = false, idempotencyKey, onCommand, resume = null } = {}) {
  if (state.controlBusy) throw new Error("已有远程读取正在进行");
  const device = selectedDevice();
  const ops = advertisedOperations(device);
  if (!ops.includes(operation)) throw new Error(`Desktop 未广告 ${operation}（当前广告：${ops.join(", ") || "无"}）`);
  state.controlBusy = true;
  const generation = state.controlGeneration;
  let disposable = null;
  if (selected && isMutationOperation(operation)) applyRenewalEvent({ type: "command_started", operation });
  renderRemoteBrowser();
  try {
    const session = selected ? state.controlSession : (disposable = await openControlSession(scope));
    if (!session || generation !== state.controlGeneration) throw new Error("操作已取消");
    const completed = resume
      ? await resumeRemoteCommand(operation, resume.controlSessionId, resume.commandId, generation)
      : await executeRemoteCommand(session, operation, argumentsValue, generation, idempotencyKey, onCommand);
    return withCommand ? completed : completed.result;
  } catch (error) {
    if (selected && isMutationOperation(operation)) {
      const decision = applyRenewalEvent({ type: "command_failed", operation, errorCode: error?.code });
      if (decision.effects.includes("offer_renewal")) {
        log("info", "Cloud 要求在再次执行写操作前续期 control session", { operation });
      } else if (decision.effects.includes("recreate_session")) {
        window.setTimeout(() => void recreateSelectedControlSession(state.controlGeneration), 0);
      }
    }
    throw error;
  } finally {
    if (disposable?.id) {
      dropEncryptedControlSession(disposable.id);
      void request(`/v1/desktop-control-sessions/${encodeURIComponent(disposable.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (generation === state.controlGeneration) state.controlBusy = false;
    renderRemoteBrowser();
  }
}

async function loadRemoteWorkspaces() {
  if (state.sessionCreationAttempt) return;
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

function collapseRemoteWorkspace() {
  closeSelectedControlSession();
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.sessions = [];
  state.snapshot = null;
  renderRemoteBrowser();
  renderSnapshot();
}

async function selectRemoteWorkspace(workspaceId) {
  if (state.sessionCreationAttempt && state.selectedWorkspaceId !== workspaceId) return;
  if (state.selectedWorkspaceId !== workspaceId) {
    if (state.selectedWorkspaceId) state.pendingEnqueues.clear();
    closeSelectedControlSession();
  }
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

async function refreshRemoteSessions(workspaceId) {
  const result = await runRemoteOperation("session.list", { workspaceId }, { workspaceId });
  if (state.selectedWorkspaceId !== workspaceId) throw new Error("Selected workspace changed during refresh");
  state.sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  log("success", "session.list 完成", { count: state.sessions.length });
  renderRemoteBrowser();
  return state.sessions;
}

function renderSessionCreationGuidance() {
  const node = element("createSessionGuidance");
  const attempt = state.sessionCreationAttempt;
  let message = "";
  if (attempt?.status === "reauthentication_required") {
    message = "Reauthentication is required. Retry explicitly to renew the retained workspace control session and reuse the same attempt key.";
  } else if (attempt?.status === "ambiguous") {
    message = "Creation outcome is ambiguous. Use session.list to reconcile this retained attempt on its original device and workspace.";
  } else if (attempt?.status === "reconciliation_required") {
    message = "Creation requires reconciliation. Use session.list on the original device and workspace; no new key or title-based selection is allowed.";
  } else if (["submitting", "polling", "reconciling"].includes(attempt?.status)) {
    message = "Creation is in progress. Device and workspace selection are locked until it reaches a safe state.";
  }
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

async function createRemoteSession(event) {
  event.preventDefault();
  if (["submitting", "polling", "reconciling"].includes(state.sessionCreationAttempt?.status)) return;
  const workspaceId = state.selectedWorkspaceId;
  const titleValue = element("sessionTitleInput").value;
  if (!canCreateSession({
    workspaceId,
    device: selectedDevice(),
    featureGates: state.featureGates,
    operations: advertisedOperations(),
    controlBusy: state.controlBusy,
    attempt: state.sessionCreationAttempt?.status === "reauthentication_required" ? null : state.sessionCreationAttempt,
  })) return;

  try {
    if (!state.sessionCreationAttempt && state.controlSession) {
      closeSelectedControlSession();
      state.selectedSessionId = null;
      state.snapshot = null;
      renderSnapshot();
    }
    const result = await sessionCreation.submit({ title: titleValue });
    if (result.status !== "succeeded") return;
    element("createSessionForm").classList.add("hidden");
    element("sessionTitleInput").value = "";
    toast("Empty session created; send a prompt separately when ready");
  } catch (error) {
    log("error", "session.create 失败", { message: error instanceof Error ? error.message : "unknown" });
    if (state.sessionCreationAttempt?.status === "ambiguous") {
      toast("Outcome ambiguous; refresh sessions before retrying");
    } else if (state.sessionCreationAttempt?.status === "reauthentication_required") {
      toast("Reauthentication required; retry explicitly when ready");
    } else {
      toast(error instanceof Error ? error.message : "Session creation failed");
    }
    renderSessionCreationGuidance();
  } finally {
    renderRemoteBrowser();
  }
}

async function selectRemoteSession(sessionId, { propagateFailure = false } = {}) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) return;
  if (state.selectedSessionId === sessionId && state.controlSession) {
    try {
      await requestSelectedRecovery("manual_refresh", state.controlGeneration, propagateFailure);
    } catch (error) {
      if (propagateFailure) throw error;
    }
    return;
  }
  if (state.selectedSessionId && state.selectedSessionId !== sessionId) state.pendingEnqueues.clear();
  if (state.controlSession && state.selectedSessionId !== sessionId) closeSelectedControlSession();
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
      if (propagateFailure) throw new Error("Session selection was fenced before its baseline was established");
      return;
    }
    state.controlSession = controlSession;
    state.pendingEnqueues.setScope(selectedOperationalScope(controlSession.deviceId, workspaceId, sessionId));
    state.controlRenewal = createRenewalState();
    state.remoteModel = createRemoteSessionState({ controlSessionId: controlSession.id, deviceId: controlSession.deviceId, workspaceId, sessionId });
    startSelectedStream(generation);
    const completed = await runRemoteOperation("session.snapshot", { workspaceId, sessionId }, { workspaceId, sessionId }, { selected: true, withCommand: true });
    if (generation !== state.controlGeneration || state.selectedSessionId !== sessionId) {
      if (propagateFailure) throw new Error("Session selection was fenced before its baseline was established");
      return;
    }
    await installSelectedSnapshot(completed.result, completed.commandId, false, generation);
    log("success", "session.snapshot 完成", { messages: completed.result?.messages?.length || 0, todos: completed.result?.todos?.length || 0 });
  } catch (error) {
    log("error", "session.snapshot 失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "读取会话快照失败");
    if (propagateFailure) throw error;
  }
  renderRemoteBrowser();
}

async function sendRemotePrompt() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;
  const prompt = element("promptInput").value.trim();
  const selectedWhenBusy = element("whenBusySelect").value;
  const whenBusy = resolveBusyMode(selectedWhenBusy, selectedDevice());
  if (selectedWhenBusy !== whenBusy) {
    toast("Desktop 未独立声明该运行中会话能力");
    return;
  }
  if (!validRemotePrompt(prompt)) {
    toast("Prompt 必须为非空且不超过 200,000 UTF-8 字节");
    return;
  }
  element("sendPromptButton").disabled = true;
  const priorAttempt = whenBusy === "enqueue" ? state.pendingEnqueues.attempt() : null;
  const submission = whenBusy === "enqueue"
    ? prepareEnqueueSubmission(priorAttempt, { createKey: () => crypto.randomUUID(), controlSessionId: state.controlSession?.id })
    : { idempotencyKey: crypto.randomUUID(), resume: null, attempt: null };
  const idempotencyKey = submission.idempotencyKey;
  let commandId = submission.resume?.commandId || null;
  let controlSessionId = submission.resume?.controlSessionId || state.controlSession?.id;
  if (submission.attempt) state.pendingEnqueues.beginAttempt(submission.attempt);
  try {
    const result = await runRemoteOperation("session.prompt", { workspaceId, sessionId, prompt, whenBusy }, { workspaceId, sessionId }, {
      selected: true,
      withCommand: true,
      idempotencyKey,
      resume: submission.resume,
      onCommand: (id, commandScopeId) => {
        commandId = id;
        controlSessionId = commandScopeId;
        if (whenBusy === "enqueue") state.pendingEnqueues.setAttemptCommand(id, commandScopeId);
      },
    });
    if (whenBusy === "enqueue") state.pendingEnqueues.clearAttempt();
    if (result.reconcile) {
      await requestSelectedRecovery("enqueue_attempt_recovered", state.controlGeneration, true);
    } else if (result.result.disposition === "started") {
      const admitted = result.result;
      state.activeRunId = admitted.runId;
      state.activeRunGeneration = admitted.generation;
    } else if (result.result.disposition === "enqueued") {
      const admitted = result.result;
      state.pendingEnqueues.add({ id: admitted.pendingOperationId, mode: whenBusy, position: admitted.position, status: "pending" });
    }
    element("promptInput").value = "";
    log("success", "Prompt 已提交", { disposition: result.result?.disposition || "recovered", pendingOperationId: result.result?.pendingOperationId || null });
    toast(result.result?.disposition === "enqueued" ? "Prompt 已在 Desktop 本机持久排队" : "Prompt 已提交到 Desktop");
  } catch (error) {
    if (whenBusy === "enqueue" && error?.code === "idempotency_conflict") {
      state.pendingEnqueues.clearAttempt();
      try {
        await requestSelectedRecovery("enqueue_attempt_idempotency_conflict", state.controlGeneration, true);
        element("promptInput").value = "";
        log("success", "已从重复排队提交恢复会话状态", { idempotencyKey });
        toast("已恢复先前排队提交的会话状态");
        return;
      } catch (recoveryError) {
        log("error", "排队提交已存在，但快照恢复失败", { message: recoveryError instanceof Error ? recoveryError.message : "unknown" });
        toast("先前提交已被接受，但快照恢复失败");
        return;
      }
    }
    if (whenBusy === "enqueue" && (isDefinitiveEnqueueOutcome({ error }) || (!commandId && error?.ambiguousMutation !== true))) {
      state.pendingEnqueues.clearAttempt();
    }
    if (whenBusy === "enqueue" && commandId) {
      log("warning", "排队结果待恢复", { commandId, idempotencyKey });
    }
    log("error", "Prompt 提交失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "Prompt 提交失败");
  } finally {
    element("sendPromptButton").disabled = false;
    renderRemoteBrowser();
  }
}

async function cancelPendingRemoteOperation(pendingOperationId) {
  const pending = state.pendingEnqueues.list().find((item) => item.id === pendingOperationId);
  if (!pending || !state.controlSession) return;
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;
  try {
    const result = await runRemoteOperation("session.pending.cancel", {
      workspaceId,
      sessionId,
      pendingOperationId: pending.id,
    }, { workspaceId, sessionId }, { selected: true });
    if (!["cancelled", "already_cancelled", "not_cancellable"].includes(result.status)) {
      throw new Error("Desktop returned an invalid pending cancellation result");
    }
    state.pendingEnqueues.remove(pending.id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "取消排队操作失败");
  }
}

function closeSelectedControlSession() {
  state.controlGeneration += 1;
  state.remoteStream?.stop("CLOSED");
  state.remoteStream = null;
  const prior = state.controlSession;
  dropEncryptedControlSession(prior?.id);
  state.controlSession = null;
  state.controlRenewal = createRenewalState();
  state.remoteModel = null;
  state.remoteEventBuffer = [];
  state.remoteRecovery = null;
  state.remoteStreamState = "CLOSED";
  state.remoteConnectionEpoch = 0;
  state.activeRunId = null;
  state.pendingEnqueues.setScope(null);
  if (prior?.id && state.token) void request(`/v1/desktop-control-sessions/${encodeURIComponent(prior.id)}`, { method: "DELETE" }).catch(() => undefined);
}

async function renewSelectedControlSession() {
  const controlSession = state.controlSession;
  if (!controlSession || state.controlBusy) return;
  const generation = state.controlGeneration;
  if (controlSessionExpiry(controlSession).state === "expired") {
    applyRenewalEvent({ type: "renew_failed", errorCode: "control_session_expired" });
    toast("Control session 已过期，正在创建新 session 并读取快照");
    await recreateSelectedControlSession(generation);
    return;
  }
  const requested = applyRenewalEvent({ type: "renew_requested" });
  if (!requested.effects.includes("renew_session")) return;
  try {
    const renewed = await request(`/v1/desktop-control-sessions/${encodeURIComponent(controlSession.id)}/renew`, {
      method: "POST",
      body: { schemaVersion: 1 },
    });
    if (generation !== state.controlGeneration || state.controlSession?.id !== controlSession.id) return;
    if (renewed?.id !== controlSession.id || renewed.deviceId !== controlSession.deviceId || renewed.status !== "active") {
      throw new Error("Control session 续期响应无效");
    }
    state.controlSession = renewed;
    const encryption = state.encryptedSessions.get(controlSession.id);
    if (encryption) {
      if (renewed.payloadEncryption?.mode !== "e2ee-v1" || renewed.payloadEncryption.desktopKeyId !== encryption.desktopKeyId ||
          renewed.payloadEncryption.controllerKeyId !== encryption.controllerKeyId || renewed.payloadEncryption.desktopPublicKey !== encryption.desktopPublicKey) {
        throw new Error("Renewed control session changed its encryption binding");
      }
    }
    const result = applyRenewalEvent({ type: "renew_succeeded" });
    log("success", "Control session 已续期", {
      authenticatedAt: renewed.authenticatedAt,
      lastActiveAt: renewed.lastActiveAt,
      expiresAt: renewed.expiresAt,
    });
    toast(result.effects.includes("tell_user_to_retry") ? "身份证明已续期，请重试刚才的操作" : "Control session 已续期");
  } catch (error) {
    if (generation !== state.controlGeneration) return;
    const result = applyRenewalEvent({ type: "renew_failed", errorCode: error?.code });
    if (result.effects.includes("recreate_session")) {
      toast("原 control session 已关闭，正在创建新 session 并读取快照");
      await recreateSelectedControlSession(generation);
      return;
    }
    log("error", "Control session 续期失败", { message: error instanceof Error ? error.message : "unknown" });
    toast(error instanceof Error ? error.message : "Control session 续期失败");
  }
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
      const previous = state.remoteStreamState;
      state.remoteStreamState = value;
      if (value === "LIVE" && previous !== "LIVE") state.remoteConnectionEpoch += 1;
      notifications.notify(notificationForStreamTransition(previous, value, {
        active: Boolean(state.controlSession),
        closed: detail?.closed === true,
        controlSessionId: state.controlSession?.id,
        transitionId: state.remoteConnectionEpoch,
      }));
      if (detail) log(value === "ERROR" ? "error" : "info", `SSE ${value}`, { message: detail.message });
      renderRemoteBrowser();
    },
    async onRecord(record) {
      if (generation !== state.controlGeneration) return;
      let envelope;
      try { envelope = JSON.parse(record.data); } catch { return requestSelectedRecovery("malformed_json", generation); }
      try { envelope = await decryptSelectedEventEnvelope(envelope); }
      catch { return requestSelectedRecovery("encrypted_event_invalid", generation); }
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

async function decryptSelectedEventEnvelope(envelope) {
  const encryption = state.controlSession ? state.encryptedSessions.get(state.controlSession.id) : null;
  return decryptControllerEventEnvelope(envelope, encryption || null);
}

async function applySelectedEnvelope(envelope, sseId, generation) {
  if (generation !== state.controlGeneration) return;
  try {
    const previousModel = state.remoteModel;
    const result = applyRemoteSessionEvent(previousModel, envelope, sseId);
    state.remoteModel = result.state;
    state.snapshot = result.state.snapshot;
    state.activeRunId = result.state.activeRun?.runId || null;
    notifications.notify(notificationForRemoteEvent(previousModel, result.state, envelope, result.effects));
    applyRenderEffects(result.effects);
    if (result.effects.some((effect) => effect.type === "resync")) void requestSelectedRecovery("event_requested", generation);
  } catch (error) {
    if (scheduleRemoteStateRecovery(error, {
      recoveryInFlight: Boolean(state.remoteRecovery),
      requestRecovery: (reason) => requestSelectedRecovery(reason, generation),
    })) {
      log("info", "增量事件缺少安全基线，已切换到快照恢复", { reason: error.message });
      return;
    }
    throw error;
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
  state.pendingEnqueues.replace((snapshot.pendingOperations || []).map((pending) => ({
    id: pending.id,
    position: pending.position,
    mode: pending.mode,
    status: pending.status,
  })));
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

function requestSelectedRecovery(reason, generation, propagateFailure = false) {
  if (generation !== state.controlGeneration) return Promise.resolve();
  if (state.remoteRecovery) return state.remoteRecovery;
  state.remoteStreamState = "RESYNCING";
  renderRemoteBrowser();
  let recoveryPromise;
  recoveryPromise = refreshSelectedSnapshot(generation, true)
    .catch((error) => {
      if (generation !== state.controlGeneration) return;
      log("error", "快照恢复失败", { reason, message: error.message });
      if (propagateFailure) throw error;
      void recreateSelectedControlSession(generation);
    })
    .finally(() => {
      if (generation === state.controlGeneration && state.remoteRecovery === recoveryPromise) state.remoteRecovery = null;
    });
  // Publish the in-flight recovery before any command lifecycle can be
  // consumed. Otherwise an immediate stream event can recursively start a
  // second snapshot command for the same missing baseline.
  state.remoteRecovery = recoveryPromise;
  return recoveryPromise;
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
  const expiry = controlSessionExpiry(state.controlSession);
  const renewalBlocksMutation = ["renew_required", "renewing", "renew_failed", "recreating"].includes(state.controlRenewal.phase) || expiry.state === "expired";
  const unsafe = state.controlBusy || renewalBlocksMutation || ["RESYNCING", "CLOSED", "ERROR"].includes(state.remoteStreamState);
  const buttonElements = [...document.querySelectorAll("[data-operation]")];
  for (const button of buttonElements) {
    const operation = button.dataset.operation;
    if (operation === "workspace.list") {
      button.disabled = state.controlBusy || Boolean(state.sessionCreationAttempt) || !operations.includes("workspace.list");
    } else if (operation === "session.list") {
      const canReconcile = ["ambiguous", "reconciliation_required"].includes(state.sessionCreationAttempt?.status);
      button.disabled = state.controlBusy || (!canReconcile && Boolean(state.sessionCreationAttempt)) || !state.selectedWorkspaceId || !operations.includes("session.list");
    } else if (operation === "session.create") {
      button.disabled = !canCreateSession({
        workspaceId: state.selectedWorkspaceId,
        device: selectedDevice(),
        featureGates: state.featureGates,
        operations,
        controlBusy: state.controlBusy,
        attempt: state.sessionCreationAttempt,
      });
    } else if (operation === "session.snapshot") {
      button.disabled = state.controlBusy || !state.selectedSessionId || !operations.includes("session.snapshot");
    } else if (operation === "session.prompt") {
      button.disabled = unsafe || !state.selectedSessionId || !operations.includes("session.prompt");
    } else if (operation === "session.abort") {
      button.disabled = unsafe || !state.activeRunId || !operations.includes("session.abort");
    }
  }
  const prompt = element("promptInput")?.value.trim() || "";
  const sendButton = element("sendPromptButton");
  if (sendButton) sendButton.disabled = unsafe || !state.selectedSessionId || !prompt;
  const pendingStatus = element("pendingOperationStatus");
  const pendingHandles = state.pendingEnqueues.list();
  pendingStatus.innerHTML = "";
  pendingStatus.classList.toggle("hidden", pendingHandles.length === 0);
  for (const pending of pendingHandles) {
    const row = document.createElement("div");
    row.className = "pending-operation-row";
    const label = document.createElement("span");
    label.textContent = `Desktop queue #${pending.position} · ${pending.id}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消排队操作";
    cancel.disabled = unsafe;
    cancel.addEventListener("click", () => void cancelPendingRemoteOperation(pending.id));
    row.append(label, cancel);
    pendingStatus.append(row);
  }
  const createButton = element("createSessionButton");
  let validTitle = false;
  try {
    normalizeSessionTitle(element("sessionTitleInput").value);
    validTitle = true;
  } catch {}
  if (createButton) createButton.disabled = !canCreateSession({
    workspaceId: state.selectedWorkspaceId,
    device: selectedDevice(),
    featureGates: state.featureGates,
    operations,
    controlBusy: state.controlBusy,
    attempt: state.sessionCreationAttempt?.status === "reauthentication_required" ? null : state.sessionCreationAttempt,
  }) || !validTitle;
  const creationActive = Boolean(state.sessionCreationAttempt);
  element("sessionTitleInput").disabled = creationActive;
  element("cancelCreateSessionButton").disabled = creationActive;
  element("workspaceCount").textContent = String(state.workspaces.length);
  element("sessionCount").textContent = String(state.sessions.length);
  element("snapshotStatus").textContent = state.remoteStreamState;
  element("snapshotStatus").className = `stream-state ${state.remoteStreamState.toLowerCase()}`;
  renderControlSessionStatus(expiry);

  const stage = element("sessionStage");
  stage.classList.toggle("hidden", !state.selectedSessionId);
  element("sessionStageTitle").textContent = state.sessions.find((session) => session.id === state.selectedSessionId)?.title || "Session";
  element("sessionStageMeta").textContent = state.selectedSessionId
    ? `${state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.name || "Workspace"} · ${state.remoteStreamState.toLowerCase()}`
    : "—";

  const workspaces = element("workspaceList");
  workspaces.innerHTML = "";
  if (!state.workspaces.length) workspaces.innerHTML = `<div class="browser-empty ${state.controlBusy ? "browser-loading" : ""}">${state.controlBusy ? "正在读取 Desktop 工作区…" : "当前 Desktop 没有可见工作区"}</div>`;
  for (const workspace of state.workspaces) {
    const expanded = workspace.id === state.selectedWorkspaceId;
    const group = document.createElement("section");
    group.className = `workspace-group ${expanded ? "expanded" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-row";
    button.setAttribute("aria-expanded", String(expanded));
    button.innerHTML = '<span class="workspace-chevron">›</span><span class="workspace-icon">⌘</span><span class="workspace-copy"><strong></strong><small></small></span><span class="workspace-session-total"></span>';
    button.querySelector("strong").textContent = workspace.name;
    button.querySelector("small").textContent = workspace.id;
    button.querySelector(".workspace-session-total").textContent = expanded && state.sessions.length ? `${state.sessions.length}` : "";
    button.disabled = creationActive;
    button.addEventListener("click", () => {
      const action = decideWorkspaceActivation({ selectedWorkspaceId: state.selectedWorkspaceId, requestedWorkspaceId: workspace.id, controlBusy: state.controlBusy });
      if (action === "collapse") {
        collapseRemoteWorkspace();
        return;
      }
      if (action === "ignore") return;
      void selectRemoteWorkspace(workspace.id);
    });
    group.append(button);
    if (expanded) {
      const sessions = document.createElement("div");
      sessions.className = "workspace-sessions";
      if (!state.sessions.length) sessions.innerHTML = `<div class="workspace-sessions-empty ${state.controlBusy ? "browser-loading" : ""}">${state.controlBusy ? "正在读取 Sessions…" : "此工作区暂无 Session"}</div>`;
      for (const session of state.sessions) {
        const sessionButton = document.createElement("button");
        sessionButton.type = "button";
        sessionButton.className = `session-row ${session.id === state.selectedSessionId ? "selected" : ""}`;
        sessionButton.innerHTML = '<span class="session-row-line"></span><span class="session-row-copy"><strong></strong><small></small></span><span class="session-row-state"></span>';
        sessionButton.querySelector("strong").textContent = session.title || "Untitled session";
        sessionButton.querySelector("small").textContent = new Date(session.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        sessionButton.querySelector(".session-row-state").textContent = session.status || "idle";
        sessionButton.disabled = creationActive;
        sessionButton.addEventListener("click", () => void selectRemoteSession(session.id));
        sessions.append(sessionButton);
      }
      group.append(sessions);
    }
    workspaces.append(group);
  }
}

function formatRemaining(remainingMs) {
  if (!Number.isFinite(remainingMs)) return "unknown expiry";
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (seconds < 60) return `${seconds}s remaining`;
  return `${Math.ceil(seconds / 60)}m remaining`;
}

function renderControlSessionStatus(expiry = controlSessionExpiry(state.controlSession)) {
  const root = element("controlSessionStatus");
  const button = element("renewControlSessionButton");
  if (!root || !button) return;
  if (!state.controlSession) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden", "warning", "danger", "success");
  const phase = state.controlRenewal.phase;
  let title = "Control session active";
  let detail = `${formatRemaining(expiry.remainingMs)} · current login bearer is the reauthentication proof`;
  let showButton = expiry.state === "approaching";
  if (phase === "renew_required") {
    title = "Reauthentication required";
    detail = "Renew once with the current login, then explicitly retry the blocked operation.";
    root.classList.add("warning");
    showButton = true;
  } else if (phase === "renewing") {
    title = "Renewing control session";
    detail = "The blocked mutation will not be replayed.";
    root.classList.add("warning");
    showButton = true;
  } else if (phase === "retry_required") {
    title = "Reauthenticated";
    detail = "Renewal succeeded. Retry the prior operation when ready; it was not replayed.";
    root.classList.add("success");
  } else if (phase === "renew_failed") {
    title = "Renewal failed";
    detail = "No mutation was replayed. Recreate the selected control session if needed.";
    root.classList.add("danger");
  } else if (phase === "recreating" || expiry.state === "expired") {
    title = "Control session expired";
    detail = "Creating a new scoped session and loading a fresh snapshot.";
    root.classList.add("danger");
  } else if (expiry.state === "approaching") {
    title = "Control session expires soon";
    root.classList.add("warning");
  }
  element("controlSessionStatusTitle").textContent = title;
  element("controlSessionStatusDetail").textContent = detail;
  button.classList.toggle("hidden", !showButton);
  button.disabled = state.controlBusy || phase === "renewing" || phase === "recreating" || expiry.state === "expired";
  button.textContent = phase === "renewing" ? "Renewing…" : "Renew session";
}

function renderSnapshot() {
  const root = element("snapshot");
  root.innerHTML = "";
  const snapshot = state.snapshot;
  const model = state.remoteModel;
  if (!snapshot) {
    root.innerHTML = `<div class="browser-empty ${state.controlBusy ? "browser-loading" : ""}">${state.controlBusy ? "正在等待 Desktop 会话历史…" : "选择 Session 后查看会话"}</div>`;
    return;
  }
  element("sessionStageTitle").textContent = snapshot.session?.title || "Session";
  element("sessionStageMeta").textContent = `${snapshot.workspace?.name || "Workspace"} · ${new Date(snapshot.capturedAt).toLocaleString("zh-CN")}`;
  const summary = document.createElement("div");
  summary.className = "session-summary";
  summary.dataset.section = "status";
  root.append(summary);
  renderSessionSummary();
  const messagesSection = document.createElement("section");
  messagesSection.className = "snapshot-section";
  messagesSection.dataset.section = "messages";
  messagesSection.innerHTML = `<div class="history-marker"><span></span>Conversation history<span></span></div><div class="message-list"></div>`;
  const messageIds = model?.messageOrder || snapshot.messages.map((message) => message.id);
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
  article.className = `message message-${message.role}`;
  article.dataset.messageId = domKey(message.id);
  const role = document.createElement("div");
  role.className = "message-role";
  role.textContent = message.role === "user" ? "You" : "JuggleWork";
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
        button.disabled = state.remoteStreamState !== "LIVE" || ["renew_required", "renewing", "renew_failed", "recreating"].includes(state.controlRenewal.phase);
        button.addEventListener("click", () => void replyToInteraction(item, response));
        row.append(button);
      }
    } else if (item.status === "pending" && item.type === "question") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Answer";
      button.disabled = state.remoteStreamState !== "LIVE" || ["renew_required", "renewing", "renew_failed", "recreating"].includes(state.controlRenewal.phase);
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

function renderNotificationPermission() {
  const button = element("notificationButton");
  const permission = notifications.permission();
  const labels = {
    default: "启用安全通知",
    granted: "通知已启用",
    denied: "通知已拒绝",
    unsupported: "浏览器不支持通知",
  };
  button.textContent = labels[permission] || labels.unsupported;
  button.disabled = permission !== "default";
}

function logout() {
  void sessionCreation.disposeAndClear();
  resetRemoteBrowser();
  state.pendingEnqueues.clear();
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
  setBadge(element("authBadge"), "未登录", "neutral");
  renderPolicy();
  renderDevices();
  renderReadiness();
  log("info", "本地登录状态已清除");
  showView("login");
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
  element("deviceLogoutButton").addEventListener("click", logout);
  element("backToDevicesButton").addEventListener("click", showDeviceList);
  element("closeSessionButton").addEventListener("click", () => {
    closeSelectedControlSession();
    state.selectedSessionId = null;
    state.snapshot = null;
    renderRemoteBrowser();
    renderSnapshot();
  });
  element("organization").addEventListener("change", () => void selectOrganization());
  element("refreshPolicyButton").addEventListener("click", () => void loadPolicy());
  element("refreshDevicesButton").addEventListener("click", () => void loadDevices());
  element("clearLogButton").addEventListener("click", () => { logElement.innerHTML = ""; });
  element("copyReportButton").addEventListener("click", async () => {
    await navigator.clipboard.writeText(report());
    toast("诊断报告已复制");
  });
  element("notificationButton").addEventListener("click", async () => {
    await notifications.requestPermission();
    renderNotificationPermission();
  });
  document.querySelector('[data-operation="workspace.list"]').addEventListener("click", () => void loadRemoteWorkspaces());
  document.querySelector('[data-operation="session.list"]').addEventListener("click", () => {
    if (!state.selectedWorkspaceId) return;
    if (["ambiguous", "reconciliation_required"].includes(state.sessionCreationAttempt?.status)) {
      void sessionCreation.reconcile().catch((error) => {
        log("error", "session.create reconciliation failed", { message: error.message });
        toast(error.message);
      });
      return;
    }
    void refreshRemoteSessions(state.selectedWorkspaceId).catch((error) => {
      log("error", "session.list 刷新失败", { message: error instanceof Error ? error.message : "unknown" });
      toast(error instanceof Error ? error.message : "读取会话失败");
    });
  });
  document.querySelector('[data-operation="session.create"]').addEventListener("click", () => {
    element("createSessionForm").classList.remove("hidden");
    element("sessionTitleInput").focus();
  });
  document.querySelector('[data-operation="session.snapshot"]').addEventListener("click", () => state.selectedSessionId && void selectRemoteSession(state.selectedSessionId));
  document.querySelector('[data-operation="session.prompt"]').addEventListener("click", () => {
    if (!state.selectedSessionId) return;
    element("promptInput").focus();
  });
  document.querySelector('[data-operation="session.abort"]').addEventListener("click", () => state.activeRunId && void abortRemoteRun());
  element("cancelPromptButton").addEventListener("click", () => {
    element("promptInput").value = "";
    renderRemoteBrowser();
  });
  element("promptInput").addEventListener("input", renderRemoteBrowser);
  element("promptInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!element("sendPromptButton").disabled) void sendRemotePrompt();
  });
  element("sendPromptButton").addEventListener("click", () => void sendRemotePrompt());
  element("createSessionForm").addEventListener("submit", (event) => void createRemoteSession(event));
  element("sessionTitleInput").addEventListener("input", renderRemoteBrowser);
  element("cancelCreateSessionButton").addEventListener("click", () => {
    element("createSessionForm").classList.add("hidden");
    if (!state.sessionCreationAttempt) element("sessionTitleInput").value = "";
  });
  element("renewControlSessionButton").addEventListener("click", () => void renewSelectedControlSession());
  for (const button of document.querySelectorAll("[data-login-mode]")) {
    button.addEventListener("click", () => {
      state.loginMode = button.dataset.loginMode;
      document.querySelectorAll("[data-login-mode]").forEach((node) => node.classList.toggle("active", node === button));
      element("identityLabel").textContent = state.loginMode === "email" ? "邮箱" : "账号";
      element("identity").placeholder = state.loginMode === "email" ? "输入 Cloud 邮箱" : "输入 Cloud 账号";
    });
  }
  window.setInterval(() => {
    if (state.token && element("autoRefresh").checked && (!document.hidden || state.selectedSessionId)) void loadDevices();
    if (state.controlSession) renderRemoteBrowser();
  }, 10_000);
}

renderPolicy();
renderReadiness();
renderNotificationPermission();
wireEvents();
log("info", "诊断台已启动；敏感凭证不会写入浏览器存储");
void checkCloud();
