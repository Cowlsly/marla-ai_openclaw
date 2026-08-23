import net from "node:net";
import { describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { runExtensionRelayDaemon } from "./relay-daemon.js";

const TOKEN = relayTestKey(1);

describe("runExtensionRelayDaemon", () => {
  it("refuses to start without a relay credential", async () => {
    const run = await runExtensionRelayDaemon({ port: 0, readToken: () => null });
    expect(run.port).toBeNull();
    await expect(run.done).resolves.toBe("no-credential");
  });

  it("exits quietly when the relay port is already served", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const run = await runExtensionRelayDaemon({ port, readToken: () => TOKEN });
      expect(run.port).toBeNull();
      await expect(run.done).resolves.toBe("port-in-use");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("serves the relay until the idle grace elapses with no peers", async () => {
    const run = await runExtensionRelayDaemon({
      port: 0,
      readToken: () => TOKEN,
      idleExitMs: 60,
      pollMs: 15,
    });
    expect(run.port).toBeGreaterThan(0);
    // The bound socket answers while the daemon is alive.
    const served = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: run.port ?? 0 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(served).toBe(true);
    await expect(run.done).resolves.toBe("idle");
  });

  it("stops on demand", async () => {
    const run = await runExtensionRelayDaemon({
      port: 0,
      readToken: () => TOKEN,
      idleExitMs: 60_000,
      pollMs: 60_000,
    });
    expect(run.port).toBeGreaterThan(0);
    run.stop();
    await expect(run.done).resolves.toBe("stopped");
  });
});
