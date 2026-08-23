import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  ensureExtensionRelayDaemonProcess,
  isRelayPortServed,
} from "./extension-relay-daemon-spawn.js";

const ENTRY = "/opt/openclaw/dist/extensions/browser/relay-daemon-entry.js";

describe("ensureExtensionRelayDaemonProcess", () => {
  it("skips when no relay credential exists", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      port: 18_799,
      entryPath: ENTRY,
      readToken: () => null,
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("skipped");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("reports running without spawning when the port is already served", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      port: 18_799,
      entryPath: ENTRY,
      readToken: () => "a".repeat(64),
      probe: async () => true,
      spawnProcess,
    });
    expect(status).toBe("running");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns the daemon entry with the resolved port", async () => {
    const spawnProcess = vi.fn();
    const status = await ensureExtensionRelayDaemonProcess({
      port: 19_123,
      entryPath: ENTRY,
      execPath: "/usr/bin/node",
      readToken: () => "a".repeat(64),
      probe: async () => false,
      spawnProcess,
    });
    expect(status).toBe("spawned");
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/node", [ENTRY, "--port", "19123"]);
  });
});

describe("isRelayPortServed", () => {
  it("detects a listening loopback server and a closed port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      expect(await isRelayPortServed(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    expect(await isRelayPortServed(port)).toBe(false);
  });
});
