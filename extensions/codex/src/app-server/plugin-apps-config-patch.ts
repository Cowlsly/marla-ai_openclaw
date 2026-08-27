import type { CodexPluginDestructiveApprovalMode } from "./config.js";
import type { JsonObject } from "./protocol.js";

export function buildCodexPluginAppsApprovalConfigPatch(
  apps: JsonObject,
  policyApps: Record<string, { destructiveApprovalMode?: CodexPluginDestructiveApprovalMode }>,
): JsonObject {
  const requiresUserApproval = Object.values(policyApps).some(
    (policy) => policy.destructiveApprovalMode === "ask",
  );
  return { ...(requiresUserApproval ? { approvals_reviewer: "user" } : {}), apps };
}
