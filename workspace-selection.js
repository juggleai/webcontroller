export function decideWorkspaceActivation({ selectedWorkspaceId, requestedWorkspaceId, controlBusy = false } = {}) {
  if (typeof requestedWorkspaceId !== "string" || !requestedWorkspaceId) throw new TypeError("requestedWorkspaceId is required");
  if (controlBusy) return "ignore";
  return selectedWorkspaceId === requestedWorkspaceId ? "collapse" : "load";
}
