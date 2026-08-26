import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

vi.mock("@openclaw/crabline", async (importOriginal) => {
  const crabline = await importOriginal<typeof import("@openclaw/crabline")>();
  return {
    ...crabline,
    async startOpenClawCrablineAdapter(
      ...args: Parameters<typeof crabline.startOpenClawCrablineAdapter>
    ) {
      const adapter = await crabline.startOpenClawCrablineAdapter(...args);
      return {
        ...adapter,
        createAgentDelivery(input: Parameters<typeof adapter.createAgentDelivery>[0]) {
          return { ...adapter.createAgentDelivery(input), threadId: "provider-thread" };
        },
      };
    },
  };
});

it("keeps the provider-resolved thread authoritative over the logical target", async () => {
  await withTempDir("qa-crabline-delivery-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
      },
      state: createQaBusState(),
    });

    try {
      expect(transport.buildAgentDelivery({ target: "thread:-1001234567890/42" }).threadId).toBe(
        "provider-thread",
      );
    } finally {
      await transport.cleanup?.();
    }
  });
});
