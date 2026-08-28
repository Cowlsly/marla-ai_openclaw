import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveEmbeddedAgentMessageInjectionTarget,
  type EmbeddedAgentMessageInjectionTarget,
} from "../../agents/embedded-agent-runner/runs.js";
import type { GatewayRequestHandlers } from "./types.js";

export function resolveOwnedActiveTalkClientInjectionTarget(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): EmbeddedAgentMessageInjectionTarget | undefined {
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return undefined;
  }
  for (const [runId, entry] of params.context.chatAbortControllers) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      const target = resolveEmbeddedAgentMessageInjectionTarget({
        runId,
        sessionId: entry.sessionId,
      });
      if (target) {
        return target;
      }
    }
  }
  return undefined;
}
