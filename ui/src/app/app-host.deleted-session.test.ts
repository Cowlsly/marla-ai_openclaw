/* @vitest-environment jsdom */

import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

type DeletedSessionShell = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  routeState: { routeId?: RouteId; location?: RouteLocation };
  didConsiderNativeRouteRestore: boolean;
  replaceChatWithCurrentSession: () => void;
  updateRouteState: (state: ReturnType<typeof selectShellRouteState>) => void;
  observeDeletedSessions: (state: ApplicationContext["sessions"]["state"]) => void;
  recoverDeletedActiveSession: (state: ApplicationContext["sessions"]["state"]) => void;
};

const mainKey = "agent:main:main";
const deletedKey = "agent:main:deleted-thread";

function createSessionRecoveryShell(params: {
  activeSessionKey: string;
  agentIds?: string[];
  sessionKeys: string[];
  deletedSessionKeys?: string[];
  sessions?: ApplicationContext["sessions"];
}) {
  const replace = vi.fn();
  const setSessionKey = vi.fn();
  const shell = document.createElement("openclaw-app-shell") as unknown as DeletedSessionShell;
  shell.runtime = {
    context: {
      basePath: "",
      agents: {
        state: {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            agents: (params.agentIds ?? ["main"]).map((id) => ({ id })),
          },
        },
      },
      agentSelection: { set: vi.fn(), state: { selectedId: "main" } },
      gateway: {
        setSessionKey,
        snapshot: { client: null, hello: null, phase: "connected" },
      },
      sessions: params.sessions ?? {
        deletionState: (key: string) =>
          params.deletedSessionKeys?.includes(key) ? "confirmed" : undefined,
        state: {
          deletedSessions: (params.deletedSessionKeys ?? []).map((key) => ({
            agentId: "main",
            key,
            retireBeforeRevision: Date.now(),
          })),
          result: { sessions: params.sessionKeys.map((key) => ({ key })) },
        },
      },
      replace,
    } as unknown as ApplicationContext,
  };
  shell.activeSessionKey = params.activeSessionKey;
  shell.routeState = { routeId: "chat" };
  return { replace, setSessionKey, shell };
}

afterEach(() => {
  document.body.replaceChildren();
  resetAppHostTestGlobals();
});

describe("OpenClaw shell deleted-session recovery", () => {
  it.each(["rejection", "batch interruption", "different-client batch rejection"] as const)(
    "navigates on delete intent and visibly reports %s without replacing newer navigation",
    async (failure) => {
      const response = createDeferred<{ deleted: boolean }>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.delete") {
          return response.promise;
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        return sessionsResult([], 1);
      });
      const { gateway, publish } = createGatewayHarness({
        request,
      } as unknown as GatewayBrowserClient);
      const sessions = createSessionCapability(gateway);
      const { shell, replace } = createSessionRecoveryShell({
        activeSessionKey: deletedKey,
        sessionKeys: [deletedKey, mainKey],
        sessions,
      });
      const stop = sessions.subscribe((state) => shell.recoverDeletedActiveSession(state));
      const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
      try {
        const operation =
          failure === "rejection"
            ? sessions.delete(deletedKey)
            : sessions.deleteMany([{ key: deletedKey }, { key: "agent:main:unsent" }]);
        expect(shell.activeSessionKey).toBe(mainKey);
        expect(sessions.deletionState(deletedKey)).toBe("pending");
        expect(sessions.state.deletedSessions).toEqual([]);
        expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
        shell.activeSessionKey = "agent:main:another-thread";
        replace.mockClear();
        if (failure === "rejection") {
          response.reject(new Error("delete rejected"));
          await expect(operation).rejects.toThrow("delete rejected");
        } else {
          publish(false);
          publish(
            true,
            failure === "different-client batch rejection"
              ? ({ request } as unknown as GatewayBrowserClient)
              : gateway.snapshot.client,
          );
          if (failure === "different-client batch rejection") {
            response.reject(new Error("old client rejected deletion"));
          } else {
            response.resolve({ deleted: true });
          }
          await operation;
          expect(
            request.mock.calls.filter(([method]) => method === "sessions.delete"),
          ).toHaveLength(1);
        }
        expect(shell.activeSessionKey).toBe("agent:main:another-thread");
        expect(replace).not.toHaveBeenCalled();
        if (failure === "different-client batch rejection") {
          expect(toast.textContent).toBe("");
          expect(sessions.state.error).toBeNull();
        } else {
          await vi.waitFor(() =>
            expect(toast.textContent).toContain(
              failure === "rejection" ? "delete rejected" : "Gateway connection replaced",
            ),
          );
        }
      } finally {
        stop();
        sessions.dispose();
      }
    },
  );

  it.each([false, true])(
    "preserves the replacement when confirmation selected its predecessor (previously deleted: %s)",
    async (previouslyDeleted) => {
      const response = createDeferred<{ deleted: boolean }>();
      const replacement = {
        key: deletedKey,
        sessionId: "replacement",
        kind: "direct" as const,
        updatedAt: 2,
      };
      let listed = previouslyDeleted ? { ...replacement, sessionId: "predecessor" } : replacement;
      const request = vi.fn(async (method: string) =>
        method === "sessions.delete" ? response.promise : sessionsResult([listed], 2),
      );
      const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const sessions = createSessionCapability(gateway);
      await sessions.refresh({ force: true });
      if (previouslyDeleted) {
        sessions.reconcileChanged({ sessionKey: deletedKey, reason: "delete" });
        listed = replacement;
        await sessions.refresh({ force: true });
      }
      const { shell, replace } = createSessionRecoveryShell({
        activeSessionKey: deletedKey,
        sessionKeys: [deletedKey],
        sessions,
      });
      const stop = sessions.subscribe((state) => shell.recoverDeletedActiveSession(state));
      const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
      const operation = sessions.delete(deletedKey, { expectedSessionId: "predecessor" });
      try {
        expect(shell.activeSessionKey).toBe(deletedKey);
        expect(replace).not.toHaveBeenCalled();
        expect(sessions.state.result?.sessions).toEqual([replacement]);
        expect(request).toHaveBeenCalledWith(
          "sessions.delete",
          expect.objectContaining({ key: deletedKey, expectedSessionId: "predecessor" }),
          expect.any(Object),
        );
        response.reject(new Error("Session identity changed"));
        await expect(operation).rejects.toThrow("Session identity changed");
        await vi.waitFor(() => expect(toast.textContent).toContain("Session identity changed"));
        expect(shell.activeSessionKey).toBe(deletedKey);
        expect(sessions.state.result?.sessions).toEqual([replacement]);
      } finally {
        response.resolve({ deleted: false });
        await operation.catch(() => {});
        stop();
        sessions.dispose();
      }
    },
  );

  it("retires an externally observed batch once and shows one actionable cleanup failure", async () => {
    const gatewayUrl = "ws://gateway.test";
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${deletedKey}\u0000agent:main`]: {
            draft: "retire me",
            draftRevision: 1,
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );
    const shell = document.createElement("openclaw-app-shell") as unknown as DeletedSessionShell;
    const deletedSessions = [
      { key: deletedKey, agentId: "main", retireBeforeRevision: Date.now() },
    ];
    const state = {
      deletedSessions,
      result: { sessions: [] },
    } as unknown as ApplicationContext["sessions"]["state"];
    shell.runtime = {
      context: {
        agents: { state: { agentsList: null } },
        chatAttachmentHandoff: createChatAttachmentHandoff(),
        gateway: {
          snapshot: {
            assistantAgentId: "main",
            client: { gatewayUrl, recoveryScopeReady: false },
            hello: null,
          },
        },
      } as unknown as ApplicationContext,
    };
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));

    shell.observeDeletedSessions({
      ...state,
      deletedSessions: [],
    });
    await import("../lib/chat/composer-draft-retirement.runtime.ts");
    expect(
      storage.getItem(`openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`),
    ).toContain("retire me");
    shell.observeDeletedSessions(state);
    shell.observeDeletedSessions(state);

    await vi.waitFor(() => {
      const stored = JSON.parse(
        storage.getItem(`openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`) ??
          "{}",
      ) as { sessions?: Record<string, { draft?: string; queue?: unknown[] }> };
      expect(stored.sessions?.[`${deletedKey}\u0000agent:main`]).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(toast.textContent).toContain(
        "Session deleted; browser draft remains. Clear site data.",
      );
    });
    expect(toast.querySelectorAll(".app-toast")).toHaveLength(1);
  });

  it("replaces an unresolvable session with the owning agent's main chat", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("preserves the owning non-default agent when its session is deleted", () => {
    const researchKey = "agent:research:main";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: "agent:research:deleted-thread",
      agentIds: ["main", "research"],
      sessionKeys: [mainKey, researchKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(researchKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/research" });
  });

  it("recovers to a known agent when the deleted session's owner was removed", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: "agent:retired:deleted-thread",
      agentIds: ["main"],
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("does not replace a main route with the same deleted main session", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: mainKey,
      deletedSessionKeys: [mainKey],
      sessionKeys: [mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a resolvable active session when a different chat route is not found", () => {
    const existingKey = "agent:main:existing-thread";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: existingKey,
      sessionKeys: [existingKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/chat/main/existing-thread",
    });
  });

  it("keeps an active session outside the filtered list when another route fails", () => {
    const existingKey = "agent:main:outside-window";
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: existingKey,
      sessionKeys: [mainKey],
    });
    shell.routeState = {
      routeId: "chat",
      location: { pathname: "/chat/main/unrelated-missing", search: "", hash: "" },
    };

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/chat/main/outside-window",
    });
  });

  it("honors a deleted session event before its stale cached row is refreshed", () => {
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      deletedSessionKeys: [deletedKey],
      sessionKeys: [deletedKey, mainKey],
    });

    shell.replaceChatWithCurrentSession();

    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });

  it("rejects a late route commit for a session already marked deleted", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const { replace, setSessionKey, shell } = createSessionRecoveryShell({
      activeSessionKey: deletedKey,
      deletedSessionKeys: [deletedKey],
      sessionKeys: [mainKey],
    });
    shell.didConsiderNativeRouteRestore = true;
    const location = {
      pathname: "/chat/main/deleted-thread",
      search: "",
      hash: "",
    } satisfies RouteLocation;
    const routerState = {
      location,
      resolvedLocation: location,
      status: "success",
      matches: [
        {
          routeId: "chat",
          location,
          data: { kind: "session", sessionKey: deletedKey },
        },
      ],
      pendingMatches: [],
      cachedMatches: [],
    } as unknown as RouterState<RouteId>;

    shell.updateRouteState(selectShellRouteState(routerState));

    expect(shell.activeSessionKey).toBe(mainKey);
    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });
});
