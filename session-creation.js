const ACTIVE_STATES = new Set([
  "submitting",
  "polling",
  "reauthentication_required",
  "ambiguous",
  "reconciliation_required",
  "reconciling",
]);

export function normalizeSessionTitle(value) {
  const rawTitle = String(value ?? "");
  for (const character of rawTitle) {
    const codePoint = character.codePointAt(0);
    if (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error("Session title must contain valid Unicode scalar values");
    }
  }
  if (/\p{Cc}/u.test(rawTitle)) throw new Error("Session title must not contain Unicode control characters");
  const title = rawTitle.trim();
  if (!title) throw new Error("Session title is required");
  if ([...title].length > 120) throw new Error("Session title must be at most 120 Unicode code points");
  return title;
}

export function canCreateSession({ workspaceId, device, featureGates, operations, controlBusy, attempt }) {
  return Boolean(
    workspaceId &&
    device?.presence === "online" &&
    device?.localControlEnabled === true &&
    featureGates?.enrollment === true &&
    featureGates?.readOnlyControl === true &&
    featureGates?.sessionMutation === true &&
    operations?.includes("session.create") &&
    !controlBusy &&
    !ACTIVE_STATES.has(attempt?.status),
  );
}

export function createdSessionId(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).length !== 1 || typeof result.sessionId !== "string" || !result.sessionId) {
    throw new Error("session.create returned an invalid result");
  }
  return result.sessionId;
}

export function selectCreatedSession(sessions, sessionId) {
  const match = Array.isArray(sessions) ? sessions.find((session) => session?.id === sessionId) : null;
  if (!match) throw new Error("Created session is absent from the refreshed session list");
  return match.id;
}

export function workspaceCreationScope(workspaceId) {
  return { workspaceId, sessionId: null };
}

export function sessionCreationArguments(workspaceId, title) {
  return { workspaceId, title: normalizeSessionTitle(title) };
}

function sameContext(attempt, context) {
  return attempt.deviceId === context.deviceId &&
    attempt.controlGeneration === context.controlGeneration &&
    attempt.workspaceId === context.workspaceId &&
    attempt.accountId === context.accountId &&
    attempt.organizationId === context.organizationId &&
    (attempt.encryptionBinding === null || attempt.encryptionBinding === context.encryptionBinding);
}

export class SessionCreationMachine {
  constructor(dependencies) {
    this.dependencies = dependencies;
    this.attempt = null;
    this.running = false;
  }

  update(patch) {
    this.attempt = this.attempt ? { ...this.attempt, ...patch } : null;
    this.dependencies.onChange?.(this.attempt);
  }

  currentContext() {
    return this.dependencies.currentContext();
  }

  assertCurrent() {
    if (!this.attempt || !sameContext(this.attempt, this.currentContext())) {
      if (this.attempt) this.update({ status: "reconciliation_required", reason: "context_changed" });
      const error = new Error("Creation context changed; reconciliation is required on the original device and workspace");
      error.code = "creation_context_changed";
      throw error;
    }
  }

  async disposeAndClear() {
    const session = this.attempt?.controlSession;
    this.attempt = null;
    this.dependencies.onChange?.(null);
    if (session?.id) await this.dependencies.disposeControlSession(session).catch(() => undefined);
  }

  async retainFailure(error, fallbackStatus = null) {
    if (!this.attempt) return;
    if (this.attempt.status === "reconciliation_required") return;
    if (error?.code === "control_session_reauthentication_required") {
      this.update({ status: "reauthentication_required", reason: error.code });
      return;
    }
    if (error?.safeTerminal === true && !this.attempt.mayHaveCommitted) {
      await this.disposeAndClear();
      return;
    }
    if (this.attempt.mayHaveCommitted || this.attempt.commandId || error?.ambiguousMutation || fallbackStatus) {
      this.update({ status: fallbackStatus || "ambiguous", reason: error?.code || error?.message || "unknown" });
      return;
    }
    await this.disposeAndClear();
  }

  async submit(input) {
    if (this.running) return { status: "duplicate_blocked", attempt: this.attempt };
    const context = this.currentContext();
    const title = normalizeSessionTitle(input?.title);
    if (!context.workspaceId) throw new Error("A workspace must be selected");
    if (this.attempt) {
      if (this.attempt.status !== "reauthentication_required" || !sameContext(this.attempt, context) || this.attempt.title !== title) {
        return { status: "duplicate_blocked", attempt: this.attempt };
      }
    } else {
      this.attempt = {
        deviceId: context.deviceId,
        controlGeneration: context.controlGeneration,
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        organizationId: context.organizationId,
        encryptionBinding: null,
        title,
        idempotencyKey: this.dependencies.createKey(),
        controlSession: null,
        commandId: null,
        sessionId: null,
        mayHaveCommitted: false,
        status: "submitting",
        reason: null,
      };
      this.dependencies.onChange?.(this.attempt);
    }

    this.running = true;
    try {
      this.assertCurrent();
      if (!this.attempt.controlSession) {
        const controlSession = await this.dependencies.openControlSession(workspaceCreationScope(this.attempt.workspaceId));
        this.assertCurrent();
        if (controlSession.deviceId !== this.attempt.deviceId) throw new Error("Control session device mismatch");
        this.update({ controlSession, encryptionBinding: this.currentContext().encryptionBinding });
      } else {
        const controlSession = await this.dependencies.renewControlSession(this.attempt.controlSession);
        this.assertCurrent();
        if (controlSession.id !== this.attempt.controlSession.id || controlSession.deviceId !== this.attempt.deviceId) {
          throw new Error("Renewed control session identity mismatch");
        }
        this.update({ controlSession, status: "submitting", reason: null });
      }
      return await this.executeAndReconcile();
    } catch (error) {
      await this.retainFailure(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  async executeAndReconcile() {
    this.update({ status: "polling" });
    const result = await this.dependencies.executeCreate({
      controlSession: this.attempt.controlSession,
      arguments: sessionCreationArguments(this.attempt.workspaceId, this.attempt.title),
      idempotencyKey: this.attempt.idempotencyKey,
      onCommand: (commandId) => this.update({ commandId }),
    });
    this.assertCurrent();
    this.update({ mayHaveCommitted: true, status: "reconciling" });
    let sessionId;
    try {
      sessionId = createdSessionId(result);
    } catch (error) {
      await this.retainFailure(error, "reconciliation_required");
      throw error;
    }
    this.update({ sessionId });
    return this.reconcileKnownResult();
  }

  async reconcileKnownResult() {
    try {
      this.assertCurrent();
      this.update({ status: "reconciling" });
      const sessions = await this.dependencies.listSessions(this.attempt.workspaceId);
      this.assertCurrent();
      selectCreatedSession(sessions, this.attempt.sessionId);
      await this.dependencies.establishBaseline(this.attempt.sessionId, this.attempt);
      this.assertCurrent();
      const sessionId = this.attempt.sessionId;
      await this.disposeAndClear();
      return { status: "succeeded", sessionId };
    } catch (error) {
      await this.retainFailure(error, "reconciliation_required");
      throw error;
    }
  }

  async reconcile() {
    if (this.running) return { status: "duplicate_blocked", attempt: this.attempt };
    if (!this.attempt || !["ambiguous", "reconciliation_required"].includes(this.attempt.status)) {
      return { status: "nothing_to_reconcile", attempt: this.attempt };
    }
    this.assertCurrent();
    this.running = true;
    try {
      if (!this.attempt.sessionId && this.attempt.commandId) {
        const result = await this.dependencies.resumeCommand(this.attempt.controlSession, this.attempt.commandId);
        this.assertCurrent();
        this.update({ mayHaveCommitted: true });
        try {
          this.update({ sessionId: createdSessionId(result) });
        } catch (error) {
          await this.retainFailure(error, "reconciliation_required");
          throw error;
        }
      }
      if (!this.attempt.sessionId) {
        await this.dependencies.listSessions(this.attempt.workspaceId);
        this.assertCurrent();
        const error = new Error("The authoritative session ID is unavailable; the attempt remains blocked");
        await this.retainFailure(error, "reconciliation_required");
        throw error;
      }
      return await this.reconcileKnownResult();
    } finally {
      this.running = false;
    }
  }

  fence() {
    if (!this.attempt) return;
    this.update({ status: "reconciliation_required", reason: "context_changed" });
  }
}
