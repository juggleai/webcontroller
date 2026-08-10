import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canCreateSession,
  normalizeSessionTitle,
  SessionCreationMachine,
  sessionCreationArguments,
  workspaceCreationScope,
} from "../session-creation.js";

const baseContext = { deviceId: "device-1", connectionGeneration: 4, controlGeneration: 7, workspaceId: "workspace-1", accountId: "account-1", organizationId: "org-1", encryptionBinding: "control-1\0desktop-1\0statement-1\0controller-1" };

function harness(overrides = {}) {
  let context = { ...baseContext };
  let keys = 0;
  const calls = [];
  const dependencies = {
    currentContext: () => ({ ...context }),
    createKey: () => `key-${++keys}`,
    openControlSession: async (scope) => {
      calls.push(["open", scope]);
      return { id: "control-1", deviceId: context.deviceId };
    },
    renewControlSession: async (session) => {
      calls.push(["renew", session.id]);
      return session;
    },
    executeCreate: async ({ controlSession, arguments: args, idempotencyKey, onCommand }) => {
      calls.push(["create", controlSession.id, args, idempotencyKey]);
      onCommand("command-1");
      return { sessionId: "created-1" };
    },
    resumeCommand: async (session, commandId) => {
      calls.push(["resume", session.id, commandId]);
      return { sessionId: "created-1" };
    },
    listSessions: async (workspaceId) => {
      calls.push(["list", workspaceId]);
      return [{ id: "created-1" }];
    },
    establishBaseline: async (sessionId) => calls.push(["baseline", sessionId]),
    disposeControlSession: async (session) => calls.push(["dispose", session.id]),
    ...overrides,
  };
  const machine = new SessionCreationMachine(dependencies);
  return { machine, calls, setContext: (patch) => { context = { ...context, ...patch }; }, keyCount: () => keys };
}

test("success creates, exactly reconciles, establishes a baseline, then disposes", async () => {
  const { machine, calls } = harness();
  assert.deepEqual(await machine.submit({ title: " New session " }), { status: "succeeded", sessionId: "created-1" });
  assert.equal(machine.attempt, null);
  assert.deepEqual(calls.map(([name]) => name), ["open", "create", "list", "baseline", "dispose"]);
  assert.deepEqual(calls[1].slice(1), ["control-1", { workspaceId: "workspace-1", title: "New session" }, "key-1"]);
});

test("reauthentication renews the same disposable session and reuses the same key", async () => {
  let executions = 0;
  const { machine, calls, keyCount } = harness({
    executeCreate: async ({ controlSession, idempotencyKey, onCommand }) => {
      calls.push(["create", controlSession.id, idempotencyKey]);
      if (++executions === 1) {
        const error = new Error("reauthenticate");
        error.code = "control_session_reauthentication_required";
        throw error;
      }
      onCommand("command-1");
      return { sessionId: "created-1" };
    },
  });
  await assert.rejects(machine.submit({ title: "Title" }), /reauthenticate/);
  assert.equal(machine.attempt.status, "reauthentication_required");
  assert.equal(machine.attempt.controlSession.id, "control-1");
  await machine.submit({ title: "Title" });
  assert.equal(keyCount(), 1);
  assert.deepEqual(calls.filter(([name]) => name === "open").length, 1);
  assert.deepEqual(calls.filter(([name]) => name === "create").map((call) => call.slice(1)), [
    ["control-1", "key-1"],
    ["control-1", "key-1"],
  ]);
  assert.deepEqual(calls.find(([name]) => name === "renew"), ["renew", "control-1"]);
});

test("post-commit list timeout retains and explicit reconciliation completes", async () => {
  let lists = 0;
  const { machine, calls } = harness({
    listSessions: async () => {
      calls.push(["list"]);
      if (++lists === 1) throw new Error("list timeout");
      return [{ id: "created-1" }];
    },
  });
  await assert.rejects(machine.submit({ title: "Title" }), /list timeout/);
  assert.equal(machine.attempt.status, "reconciliation_required");
  assert.equal(machine.attempt.sessionId, "created-1");
  assert.equal(calls.some(([name]) => name === "dispose"), false);
  await machine.reconcile();
  assert.equal(machine.attempt, null);
});

test("invalid successful result remains blocked and retained", async () => {
  const { machine, calls } = harness({ executeCreate: async ({ onCommand }) => { onCommand("command-1"); return { nope: true }; } });
  await assert.rejects(machine.submit({ title: "Title" }), /invalid result/);
  assert.equal(machine.attempt.status, "reconciliation_required");
  assert.equal(machine.attempt.mayHaveCommitted, true);
  assert.equal(calls.some(([name]) => name === "dispose"), false);
});

test("an uncertain command submission remains ambiguous and retained", async () => {
  const uncertain = new Error("HTTP 500 after submission");
  uncertain.status = 500;
  uncertain.code = "request_failed";
  uncertain.ambiguousMutation = true;
  const { machine, calls } = harness({ executeCreate: async () => { throw uncertain; } });
  await assert.rejects(machine.submit({ title: "Title" }), /HTTP 500/);
  assert.equal(machine.attempt.status, "ambiguous");
  assert.equal(calls.some(([name]) => name === "dispose"), false);
});

test("an authoritative pre-commit terminal failure releases the disposable session", async () => {
  const terminal = new Error("rejected");
  terminal.safeTerminal = true;
  const { machine, calls } = harness({ executeCreate: async () => { throw terminal; } });
  await assert.rejects(machine.submit({ title: "Title" }), /rejected/);
  assert.equal(machine.attempt, null);
  assert.deepEqual(calls.find(([name]) => name === "dispose"), ["dispose", "control-1"]);
});

test("an absent exact ID remains blocked and never selects by title", async () => {
  const { machine, calls } = harness({ listSessions: async () => [{ id: "other", title: "Title" }] });
  await assert.rejects(machine.submit({ title: "Title" }), /absent/);
  assert.equal(machine.attempt.status, "reconciliation_required");
  assert.equal(calls.some(([name]) => name === "baseline"), false);
});

test("device, control generation, workspace, account, organization, and encryption binding changes fence completions", async () => {
  for (const patch of [
    { deviceId: "device-2" },
    { controlGeneration: 8 },
    { workspaceId: "workspace-2" },
    { accountId: "account-2" },
    { organizationId: "org-2" },
    { encryptionBinding: "control-1\0desktop-2\0statement-2\0controller-2" },
  ]) {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const testHarness = harness({ executeCreate: async ({ onCommand }) => { onCommand("command-1"); await waiting; return { sessionId: "created-1" }; } });
    const promise = testHarness.machine.submit({ title: "Title" });
    await new Promise((resolve) => setImmediate(resolve));
    testHarness.setContext(patch);
    release();
    await assert.rejects(promise, /context changed/);
    assert.equal(testHarness.machine.attempt.status, "reconciliation_required");
    assert.equal(testHarness.calls.some(([name]) => name === "list"), false);
  }
});

test("ordinary Desktop connection generation changes do not fence encrypted reconciliation", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const fixture = harness({ executeCreate: async ({ onCommand }) => { onCommand("command-1"); await waiting; return { sessionId: "created-1" }; } });
  const pending = fixture.machine.submit({ title: "Title" });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.setContext({ connectionGeneration: 99 });
  release();
  assert.deepEqual(await pending, { status: "succeeded", sessionId: "created-1" });
});

test("baseline failure retains reconciliation state and does not claim success", async () => {
  const { machine, calls } = harness({ establishBaseline: async () => { throw new Error("SSE baseline failed"); } });
  await assert.rejects(machine.submit({ title: "Title" }), /baseline failed/);
  assert.equal(machine.attempt.status, "reconciliation_required");
  assert.equal(calls.some(([name]) => name === "dispose"), false);
});

test("duplicate submit is blocked while the first execution is pending", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { machine, keyCount } = harness({ executeCreate: async ({ onCommand }) => { onCommand("command-1"); await waiting; return { sessionId: "created-1" }; } });
  const first = machine.submit({ title: "Title" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await machine.submit({ title: "Title" })).status, "duplicate_blocked");
  assert.equal(keyCount(), 1);
  release();
  await first;
});

test("eligibility and Unicode scalar title validation are exact", () => {
  const enabled = {
    workspaceId: "workspace-1",
    device: { presence: "online", localControlEnabled: true },
    featureGates: { enrollment: true, readOnlyControl: true, sessionMutation: true },
    operations: ["session.create"],
    controlBusy: false,
    attempt: null,
  };
  assert.equal(canCreateSession(enabled), true);
  for (const status of ["submitting", "polling", "ambiguous", "reconciliation_required", "reconciling", "reauthentication_required"]) {
    assert.equal(canCreateSession({ ...enabled, attempt: { status } }), false);
  }
  assert.equal(normalizeSessionTitle("😀".repeat(120)), "😀".repeat(120));
  assert.throws(() => normalizeSessionTitle("😀".repeat(121)), /120 Unicode code points/);
  assert.throws(() => normalizeSessionTitle("bad\u0000title"), /control characters/);
  assert.throws(() => normalizeSessionTitle("\tTitle"), /control characters/);
  assert.throws(() => normalizeSessionTitle("bad\ud800title"), /scalar values/);
  assert.deepEqual(sessionCreationArguments("workspace-1", "Title"), { workspaceId: "workspace-1", title: "Title" });
  assert.deepEqual(workspaceCreationScope("workspace-1"), { workspaceId: "workspace-1", sessionId: null });
});
