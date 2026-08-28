import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
} from "../../../test/helpers/image-fixtures.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";

function harness() {
  const launches: WorkerLaunchPlan[] = [];
  const remoteFiles = new Map<string, Buffer>();
  const environment = attachedEnvironment();
  const tunnel: WorkerTurnTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: vi.fn(),
    syncWorkspace: vi.fn(async () => {
      throw new Error("must not resync active workspace");
    }),
    stageAttachments: vi.fn(async (request) => {
      expect(request.isAuthorized()).toBe(true);
      for (const file of await fs.readdir(request.localPath, { recursive: true })) {
        const source = path.join(request.localPath, file);
        if ((await fs.stat(source)).isFile()) {
          if (!remoteFiles.has(file)) {
            remoteFiles.set(file, await fs.readFile(source));
          }
        }
      }
    }),
    quiesceWorkspace: vi.fn(async () => ({ assertActive: async () => {}, resume: async () => {} })),
    reconcileWorkspace: vi.fn(async (request) => {
      request.journal.commit(MANIFEST_REF);
      return {
        manifestRef: MANIFEST_REF,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
      };
    }),
    stop: vi.fn(async () => {}),
    launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      launches.push(structuredClone(request.plan));
      request.onDispatchReady?.();
      const leaf = openSessionManager().appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "image received" }],
          timestamp: Date.now(),
        }),
      );
      const seq = request.plan.assignment.transcript.nextSeq;
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        claim: request.turnClaim,
        transcriptSeq: seq,
        liveSeq: request.plan.assignment.liveEvents.nextSeq,
      });
      return {
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: leaf,
          transcriptNextSeq: seq + 1,
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    }),
  };
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: {
      get: () => environment,
      acquireTurnCredential: async () => credential(),
      acknowledgeCredentialDelivery: () => true,
      startTunnel: async () => tunnel,
      stopTunnel: async () => {},
      destroy: async () => environment,
    },
  });
  const runLocal = vi.fn(async () => ({ meta: { durationMs: 0 } }));
  const execute = async (input: Parameters<typeof provider.executeTurn>[1]) =>
    await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: input.runId },
      input,
      runLocal,
    );
  const inputFiles = () =>
    new Map([...remoteFiles].filter(([file]) => path.basename(file) !== ".gitignore"));
  return { launches, remoteFiles, inputFiles, tunnel, environment, execute, runLocal };
}

describe("cloud turn media boundary", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("preserves ordered managed image input, follow-up files, replay and canonical paths", async () => {
    seedActivePlacement();
    const rig = harness();
    const png = createNoisyPngBuffer(256, 256);
    expect(png.length).toBeGreaterThan(64 * 1024);
    const small = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
    const saved = await saveMediaBuffer(png, "image/png", "inbound");
    const savedInline = await saveMediaBuffer(small, "image/png", "inbound");
    const media = [
      { url: `media://inbound/${saved.id}`, contentType: "image/png" },
      { url: `media://inbound/${savedInline.id}`, contentType: "image/png" },
    ];
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: "compare in order",
        media,
        mediaImageLayout: {
          slots: [
            { kind: "offloaded", factIndex: 0 },
            { kind: "inline", factIndex: 1 },
          ],
        },
      },
    });
    const inline = {
      type: "image" as const,
      data: small.toString("base64"),
      mimeType: "image/png",
    };
    await rig.execute({
      ...turn("images-first"),
      prompt: "compare in order",
      images: [inline],
      imageOrder: ["offloaded", "inline"],
      userTurnTranscriptRecorder: recorder,
    });
    const content = rig.launches[0]?.assignment.prompt;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("missing multimodal prompt");
    }
    expect(content.filter((part) => part.type === "image").map((part) => part.data)).toEqual([
      png.toString("base64"),
      inline.data,
    ]);
    expect(rig.inputFiles().size).toBe(2);
    const promptText = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    for (const file of rig.inputFiles().keys()) {
      expect(promptText).toContain(
        path.posix.join("/worker/workspace", file.split(path.sep).join("/")),
      );
    }
    const preservedPath = [...rig.inputFiles().keys()][0]!;
    rig.remoteFiles.set(preservedPath, Buffer.from("worker edit"));

    const document = await saveMediaBuffer(
      Buffer.from("second turn document"),
      "text/plain",
      "inbound",
    );
    const followupRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: "read the file",
        media: [{ url: `media://inbound/${document.id}`, contentType: "text/plain" }],
      },
    });
    await rig.execute({
      ...turn("images-followup"),
      prompt: "read the file",
      userTurnTranscriptRecorder: followupRecorder,
    });
    expect(rig.inputFiles().size).toBe(3);
    expect(rig.remoteFiles.get(preservedPath)?.toString()).toBe("worker edit");
    expect(
      [...rig.inputFiles().values()].some((data) => data.toString() === "second turn document"),
    ).toBe(true);
    const replay = rig.launches[1]?.assignment.initialMessages.find(
      (message) => message.role === "user",
    );
    expect(
      replay?.content.filter((part) => part.type === "image").map((part) => part.data),
    ).toEqual([png.toString("base64"), inline.data]);
    expect(replay?.content).toEqual(content);
    const users = openSessionManager()
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
      );
    expect(users).toHaveLength(2);
    expect(readPersistedMediaFacts(users[0]!)).toMatchObject(media);
    expect(JSON.stringify(users)).not.toContain("/worker/workspace");
    await expect(fs.readFile(saved.path)).resolves.toEqual(png);
    await rig.execute({ ...turn("image-only"), prompt: "", images: [inline] });
    const imageOnly = rig.launches[2]!.assignment.prompt;
    expect(imageOnly).toEqual(expect.arrayContaining([inline]));
    expect(rig.inputFiles().size).toBe(4);
    expect(
      openSessionManager()
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(3);
    expect(rig.runLocal).not.toHaveBeenCalled();
    expect(rig.tunnel.syncWorkspace).not.toHaveBeenCalled();
  });

  it("restores ordered mixed input without a recorder", async () => {
    seedActivePlacement();
    const rig = harness();
    const offloaded = createSolidPngBuffer(3, 3, { r: 0, g: 0, b: 255 });
    const inline = {
      type: "image" as const,
      data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
      mimeType: "image/png",
    };
    const saved = await saveMediaBuffer(offloaded, "image/png", "inbound");
    await rig.execute({
      ...turn("raw-mixed"),
      prompt: "compare",
      images: [inline],
      imageOrder: ["inline", "offloaded"],
      media: [{ url: `media://inbound/${saved.id}`, contentType: "image/png" }],
    });
    const prompt = rig.launches[0]!.assignment.prompt;
    if (!Array.isArray(prompt)) {
      throw new Error("missing image input");
    }
    expect(prompt.filter((part) => part.type === "image").map((part) => part.data)).toEqual([
      inline.data,
      offloaded.toString("base64"),
    ]);
    await rig.execute(turn("raw-mixed-replay"));
    expect(
      rig.launches[1]!.assignment.initialMessages.find((message) => message.role === "user")
        ?.content,
    ).toEqual(prompt);
  });

  it("stages described image sources without reinjection or pruned history and rejects a retired turn before transfer", async () => {
    seedActivePlacement();
    const rig = harness();
    const unavailable = { path: path.join(root, "missing.png"), contentType: "image/png" };
    const manager = openSessionManager();
    manager.appendMessage(buildPersistedUserTurnMessage({ text: "old", media: [unavailable] }));
    for (let index = 0; index < 4; index++) {
      manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "processed" }] }),
      );
      manager.appendMessage(buildPersistedUserTurnMessage({ text: "next" }));
    }
    const png = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const saved = await saveMediaBuffer(png, "image/png", "inbound");
    const prompt = `described [media attached: ${saved.path}]`;
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: prompt,
        media: [{ path: saved.path, contentType: "image/png", hydrationSuppressed: true }],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [0],
        },
      },
    });
    await rig.execute({
      ...turn("suppressed"),
      prompt,
      userTurnTranscriptRecorder: recorder,
    });
    expect(
      rig.launches[0]?.assignment.initialMessages.some((message) =>
        message.content.some((part) => part.type === "image"),
      ),
    ).toBe(false);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect([...rig.inputFiles().values()]).toEqual([png]);
    const remotePath = path.posix.join(
      "/worker/workspace",
      [...rig.inputFiles().keys()][0]!.split(path.sep).join("/"),
    );
    expect(rig.launches[0]?.assignment.prompt).toBe(`described [media attached: ${remotePath}]`);

    const invalidRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      resolveInput: async () => {
        rig.environment.ownerEpoch++;
        return { text: "stale", media: [unavailable] };
      },
    });
    await expect(
      rig.execute({ ...turn("stale"), userTurnTranscriptRecorder: invalidRecorder }),
    ).rejects.toThrow(/placement|claim|authority|environment/);
    expect(rig.launches).toHaveLength(1);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
  });
});
