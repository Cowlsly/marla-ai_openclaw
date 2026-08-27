// Extension relay host-local token secret.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecretFileAtomic } from "openclaw/plugin-sdk/secret-file";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureExtensionRelayToken,
  readExtensionRelayToken,
  resolveExtensionRelayToken,
} from "./relay-auth.js";

vi.mock("openclaw/plugin-sdk/secret-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/secret-file")>();
  return { ...actual, createSecretFileAtomic: vi.fn(actual.createSecretFileAtomic) };
});

let stateDir = "";
const prevStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-")));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = prevStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("extension relay host-local secret", () => {
  it("returns null before the secret is created", () => {
    expect(readExtensionRelayToken()).toBeNull();
    expect(resolveExtensionRelayToken()).toBeNull();
  });

  it("creates a 64-hex secret on ensure and persists it privately", async () => {
    const token = await ensureExtensionRelayToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const secretPath = path.join(stateDir, "credentials", "browser-extension-relay.secret");
    expect(fs.existsSync(secretPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
  });

  it("is stable across calls (does not rotate on read)", async () => {
    const first = await ensureExtensionRelayToken();
    await expect(ensureExtensionRelayToken()).resolves.toBe(first);
    expect(readExtensionRelayToken()).toBe(first);
  });

  it("adopts the first writer's token under concurrent creation", async () => {
    const [first, second] = await Promise.all([
      ensureExtensionRelayToken(),
      ensureExtensionRelayToken(),
    ]);
    expect(second).toBe(first);
    expect(readExtensionRelayToken()).toBe(first);
  });

  it("waits for an exclusive first writer to finish its secret", async () => {
    const winner = "ab".repeat(32);
    let finishWrite = Promise.resolve();
    vi.mocked(createSecretFileAtomic).mockImplementationOnce(async ({ rootDir, filePath }) => {
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, "", { mode: 0o600 });
      finishWrite = new Promise<void>((resolve) => {
        setTimeout(() => {
          fs.writeFileSync(filePath, winner);
          resolve();
        }, 25);
      });
      throw Object.assign(new Error("another process created the secret"), {
        code: "secret-exists",
      });
    });
    try {
      await expect(ensureExtensionRelayToken()).resolves.toBe(winner);
      expect(readExtensionRelayToken()).toBe(winner);
    } finally {
      await finishWrite;
    }
  });

  it("gives different hosts (state dirs) different secrets", async () => {
    const a = await ensureExtensionRelayToken();
    const otherDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-2-")),
    );
    try {
      const b = await ensureExtensionRelayToken({ ...process.env, OPENCLAW_STATE_DIR: otherDir });
      expect(b).not.toBe(a);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  const secretFilePath = (): string =>
    path.join(stateDir, "credentials", "browser-extension-relay.secret");

  it.runIf(process.platform !== "win32").each([0o644, 0o660])(
    "self-heals a secret with mode %i to 0600 and still reads it",
    async (mode) => {
      const token = await ensureExtensionRelayToken();
      const secretPath = secretFilePath();
      fs.chmodSync(secretPath, mode);
      // Reading tightens the mode back to private and still returns the token.
      expect(readExtensionRelayToken()).toBe(token);
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a foreign-owned secret without changing it",
    async () => {
      const token = await ensureExtensionRelayToken();
      const secretPath = secretFilePath();
      const owner = fs.statSync(secretPath).uid;
      vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
      expect(readExtensionRelayToken()).toBeNull();
      await expect(ensureExtensionRelayToken()).rejects.toThrow("unreadable/malformed");
      expect(fs.readFileSync(secretPath, "utf8").trim()).toBe(token);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a broad-mode secret when tightening fails",
    async () => {
      await ensureExtensionRelayToken();
      fs.chmodSync(secretFilePath(), 0o644);
      vi.spyOn(fs, "chmodSync").mockImplementation(() => {
        throw new Error("permission denied");
      });
      expect(readExtensionRelayToken()).toBeNull();
    },
  );

  it("refuses a symlinked secret", async () => {
    const token = await ensureExtensionRelayToken();
    const secretPath = secretFilePath();
    const realTarget = path.join(stateDir, "elsewhere.secret");
    fs.renameSync(secretPath, realTarget);
    fs.symlinkSync(realTarget, secretPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readExtensionRelayToken()).toBeNull();
  });
});
