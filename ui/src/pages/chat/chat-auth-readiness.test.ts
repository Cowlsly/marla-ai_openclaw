import { expect, it } from "vitest";
import { getRuntimeConfig } from "../../../../src/config/io.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { createLifecycleEventBroadcastHandler } from "../../../../src/gateway/server-session-events.js";
import { loadGatewaySessionEntryReadOnly } from "../../../../src/gateway/session-utils.js";
import { applySessionModelSelection } from "../../../../src/model-picker/apply-session-model-selection.js";
import { onSessionLifecycleEvent } from "../../../../src/sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";

it("refreshes a retained pane from a persisted profile-only selection through the Gateway lifecycle broadcaster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const model = { provider: "anthropic", id: "claude-opus-4-6", name: "Model" };
    const sessionKey = "agent:main:profile";
    const otherKey = "agent:main:other";
    const entry = {
      sessionId: "profile-session",
      updatedAt: 1,
      providerOverride: model.provider,
      modelOverride: model.id,
      modelOverrideSource: "user" as const,
      modelOverrideRouteResolution: "resolved" as const,
      authProfileOverride: "anthropic:missing",
      authProfileOverrideSource: "user" as const,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: otherKey },
      { ...entry, sessionId: "other-session" },
    );
    const request = makeRequestMock({
      "chat.metadata": async (params: unknown) => {
        const selected = loadGatewaySessionEntryReadOnly(
          (params as { sessionKey: string }).sessionKey,
          { agentId: "main" },
        ).entry;
        const available = selected?.authProfileOverride === "anthropic:restored";
        return {
          commands: [],
          models: [
            { ...model, available, ...(available ? {} : { unavailableReason: "missing-auth" }) },
          ],
        };
      },
      "sessions.list": async () => ({ sessions: [], defaults: {}, count: 0, path: "", ts: 0 }),
    });
    const client = createTestGatewayClient(request);
    const retained = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft",
      client,
    }) as ChatPageHost;
    const sibling = makeChatHost({ sessionKey: otherKey, client }) as ChatPageHost;
    await refreshChatMetadata(retained);
    await refreshChatMetadata(sibling);
    expect(retained.chatModelCatalog[0]?.available).toBe(false);
    const transcript = retained.chatMessages;
    const unsubscribe = onSessionLifecycleEvent(
      createLifecycleEventBroadcastHandler({
        sessionEventSubscribers: { getAll: () => new Set(["reader"]) },
        chatAbortControllers: new Map(),
        broadcastToConnIds: (event, payload) => {
          handlePageGatewayEvent(retained, { type: "event", event, payload });
          handlePageGatewayEvent(sibling, { type: "event", event, payload });
        },
      }),
    );
    try {
      await expect(
        applySessionModelSelection({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          currentProvider: model.provider,
          currentModel: model.id,
          defaultProvider: model.provider,
          defaultModel: model.id,
          modelCatalog: [model],
          canPersistStickyModelSelection: false,
          markLiveSwitchPending: true,
          request: {
            provider: model.provider,
            model: model.id,
            isDefault: false,
            profileOverride: "anthropic:restored",
            runtime: { kind: "unchanged" },
          },
        }),
      ).resolves.toMatchObject({ status: "applied", changed: true });
      await waitForFast(() => expect(retained.chatModelCatalog[0]?.available).toBe(true));
      expect(sibling.chatModelCatalog[0]?.available).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(3);
      expect(retained.chatMessage).toBe("Keep this draft");
      expect(retained.chatMessages).toBe(transcript);
    } finally {
      unsubscribe();
      retireChatMetadataRequests(retained);
      retireChatMetadataRequests(sibling);
    }
  });
});
