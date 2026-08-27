import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";
import type { JsonObject } from "./protocol.js";

export function resolveCodexThreadApprovalsReviewer(
  appServer: CodexAppServerRuntimeOptions,
  config?: JsonObject,
): CodexAppServerRuntimeOptions["approvalsReviewer"] {
  return config?.approvals_reviewer === "user" ? "user" : appServer.approvalsReviewer;
}
