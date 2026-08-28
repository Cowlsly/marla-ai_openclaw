import { describe, expect, it, vi } from "vitest";
import { BILLING_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import {
  setupAgentRunnerExecutionTestState,
  createMockReplyOperation,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  expectBlockReplyCall,
  createMinimalRunAgentTurnParams,
  createTestFallbackSummaryError,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

const state = setupAgentRunnerExecutionTestState();

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function createNotifyUserRun() {
  const followupRun = createFollowupRun();
  followupRun.run.config = {
    agents: { defaults: { compaction: { notifyUser: true } } },
  };
  return followupRun;
}

describe("executeAgentTurn: compaction events", () => {
  it("keeps compaction start notices silent by default", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn({ opts: { onBlockReply } }, { commandBody: "hello" });

    expect(result.kind).toBe("success");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps compaction callbacks active when notices are silent by default", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      {
        opts: {
          onBlockReply,
          onCompactionStart,
          onCompactionEnd,
        },
      },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("logs Codex app-server compaction completion while notices stay silent by default", async () => {
    const onBlockReply = vi.fn();
    const consoleLog = vi.fn();
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: consoleLog,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    try {
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run("openai", "gpt-5.5", initialFallbackAttemptOptions(params)),
          provider: "openai",
          model: "gpt-5.5",
          attempts: [{ provider: "anthropic", model: "claude", error: "rate limit" }],
        }),
      );
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        await params.onAgentEvent?.({
          stream: "compaction",
          data: {
            phase: "start",
            backend: "codex-app-server",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compaction-1",
          },
        });
        await params.onAgentEvent?.({
          stream: "compaction",
          data: {
            phase: "end",
            completed: true,
            backend: "codex-app-server",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compaction-1",
          },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      });

      const result = await executeTestTurn({ opts: { onBlockReply } });

      expect(result.kind).toBe("success");
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(consoleLog.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "codex app-server auto-compaction succeeded for openai/gpt-5.5; refreshed session context",
      );
    } finally {
      loggingState.rawConsole = null;
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("preserves successful compaction in a later fallback failure", async () => {
    const { replyOperation, retainFailureUntilCompleteMock } = createMockReplyOperation();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompaction?.({ kind: "succeeded", count: 1 });
      throw new Error("LLM request timed out.");
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("openai", "gpt-5.6-luna", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      throw createTestFallbackSummaryError({
        message:
          "All models failed (2): openai/gpt-5.6-luna: LLM request timed out. (timeout) | anthropic/claude-sonnet-4-6: billing unavailable (billing)",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.6-luna",
            error: "LLM request timed out.",
            reason: "timeout",
          },
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            error: "billing unavailable",
            reason: "billing",
          },
        ],
      });
    });

    const result = await executeTestTurn({ replyOperation });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(
      `⚠️ Context compaction succeeded, but the later model request still failed. ${BILLING_ERROR_USER_MESSAGE.replace(/^⚠️\s*/u, "")}`,
    );
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledOnce();
  });

  it("emits a compaction start notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("emits a compaction completion notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("delivers compaction hook messages alongside notifyUser notices (#90185)", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start", messages: ["Hook before"] },
      });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true, messages: ["Hook after"] },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(4);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "Hook before",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 2, {
      text: "Hook after",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 3, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });

  it("fires both notifyUser notices alongside onCompactionStart / onCompactionEnd callbacks (#87107)", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      {
        followupRun: createNotifyUserRun(),
        opts: { onBlockReply, onCompactionStart, onCompactionEnd },
      },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    // Internal callbacks (Control UI etc.) and the user-channel notifyUser
    // notices are independent audiences; both must fire when opted in.
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction complete",
      isCompactionNotice: true,
    });
  });

  it("emits an incomplete compaction notice when compaction ends without completing", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: false },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expectBlockReplyCall(onBlockReply, 0, {
      text: "🧹 Compacting context...",
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onBlockReply, 1, {
      text: "🧹 Compaction incomplete",
      isCompactionNotice: true,
    });
  });

  it("uses the compaction notice fallback when no block-reply dispatcher is wired", async () => {
    const onCompactionNoticePayload = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun() },
      { commandBody: "hello", onCompactionNoticePayload },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expectBlockReplyCall(onCompactionNoticePayload, 0, {
      text: "🧹 Compacting context...",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onCompactionNoticePayload, 1, {
      text: "🧹 Compaction complete",
      replyToId: "msg",
      replyToCurrent: true,
      isCompactionNotice: true,
    });
  });
});
