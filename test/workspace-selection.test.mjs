import assert from "node:assert/strict";
import { test } from "node:test";

import { decideWorkspaceActivation } from "../workspace-selection.js";

test("a workspace click loads after refresh when no workspace is selected", () => {
  assert.equal(decideWorkspaceActivation({ selectedWorkspaceId: null, requestedWorkspaceId: "ws_1" }), "load");
});

test("an expanded workspace click collapses without overloading the session loader", () => {
  assert.equal(decideWorkspaceActivation({ selectedWorkspaceId: "ws_1", requestedWorkspaceId: "ws_1" }), "collapse");
  assert.equal(decideWorkspaceActivation({ selectedWorkspaceId: "ws_1", requestedWorkspaceId: "ws_2" }), "load");
});

test("workspace activation ignores duplicate clicks while a remote command is running", () => {
  assert.equal(decideWorkspaceActivation({ selectedWorkspaceId: null, requestedWorkspaceId: "ws_1", controlBusy: true }), "ignore");
});
