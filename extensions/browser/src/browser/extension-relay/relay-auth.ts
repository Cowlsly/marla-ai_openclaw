/**
 * Extension relay auth material.
 *
 * The relay authenticates the loopback link between OpenClaw and the paired
 * Chrome extension with a host-local secret. It is persisted per machine in the
 * credentials dir, so the gateway host and every browser node host each own an
 * independent token — the extension pairs with whichever machine runs its
 * Chrome, and no gateway credential ever has to travel to a node.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSecretFileAtomic, tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("extension-relay");

const RELAY_SECRET_FILE = "browser-extension-relay.secret";
const RELAY_SECRET_REREAD_ATTEMPTS = 50;
const RELAY_SECRET_REREAD_DELAY_MS = 10;
const PRIVATE_SECRET_FILE_MODE = 0o600;

// resolveOAuthDir returns `${stateDir}/credentials`, the shared credentials dir.
function resolveExtensionRelaySecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), RELAY_SECRET_FILE);
}

function normalizeToken(raw: string): string | null {
  const value = raw.trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/**
 * The relay secret is the whole auth model: anyone who can read it drives the
 * user's real browser, and loopback is not a trust boundary on a multi-user
 * host. The fs-safe reader rejects symlinks/hardlinks but does not re-check the
 * file mode or owner on read, so a secret whose permissions drifted
 * group/other-readable (loosened umask, restore, shared home) would still be
 * trusted. Classify the file's privacy before use.
 */
export type RelaySecretPrivacy = "ok" | "heal" | "refuse";

/**
 * Pure privacy decision for a secret file's stat. `heal`: we own it but the
 * mode is too broad — tighten to 0600 and continue. `refuse`: owned by another
 * user (never trust a foreign-owned credential). Windows uses ACLs, not POSIX
 * mode bits, and the create path establishes them, so it is always `ok` here.
 */
export function classifyRelaySecretPrivacy(
  stat: { uid: number; mode: number },
  selfUid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): RelaySecretPrivacy {
  if (platform === "win32" || selfUid === undefined) {
    return "ok";
  }
  if (stat.uid !== selfUid) {
    return "refuse";
  }
  return (stat.mode & 0o077) === 0 ? "ok" : "heal";
}

/**
 * Return the secret path only when it is safe to read: absent (caller handles
 * null), already private, or self-healable by tightening our own file's mode.
 * Refuses a foreign-owned or unhealable file so a world-readable credential is
 * never trusted.
 */
function resolveUsableRelaySecretPath(env: NodeJS.ProcessEnv): string | null {
  const secretPath = resolveExtensionRelaySecretPath(env);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(secretPath);
  } catch (err) {
    // Absent is the normal "not paired yet" case; let the reader return null.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? secretPath : null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    log.warn("ignoring extension relay secret: not a regular file");
    return null;
  }
  const decision = classifyRelaySecretPrivacy(stat, process.getuid?.());
  if (decision === "refuse") {
    log.warn("ignoring extension relay secret: owned by another user");
    return null;
  }
  if (decision === "heal") {
    try {
      fs.chmodSync(secretPath, PRIVATE_SECRET_FILE_MODE);
      log.warn("tightened extension relay secret permissions to 0600");
    } catch {
      log.warn("ignoring extension relay secret: permissions are too broad and could not be fixed");
      return null;
    }
  }
  return secretPath;
}

/** Read the host-local relay token, or null when it has not been created yet. */
export function readExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const secretPath = resolveUsableRelaySecretPath(env);
  if (!secretPath) {
    return null;
  }
  return normalizeToken(tryReadSecretFileSync(secretPath, "browser extension relay secret") ?? "");
}

/**
 * Read the host-local relay token, creating it on first use. Called from relay
 * startup and `openclaw browser extension pair` — both run on the machine that
 * hosts the browser, so they resolve the same per-host secret.
 *
 * The create is atomic (O_CREAT|O_EXCL): the gateway service and the pair CLI
 * are separate processes that can race on a fresh host, and a non-atomic
 * read-then-write would let each mint a distinct token (relay expects one, the
 * printed pairing string carries the other → 401). On EEXIST the winner's token
 * is re-read.
 */
export async function ensureExtensionRelayToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const secretPath = resolveExtensionRelaySecretPath(env);
  const existing = readExtensionRelayToken(env);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    await createSecretFileAtomic({
      rootDir: path.dirname(secretPath),
      filePath: secretPath,
      content: `${token}\n`,
    });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "secret-exists") {
      throw err;
    }
    // Another process created it first; its exclusive async write may still be
    // finishing after the final name appears, so adopt it with a bounded reread.
    // Reuse the hardened sync read so a foreign-owned file is never adopted here.
    for (let attempt = 0; attempt < RELAY_SECRET_REREAD_ATTEMPTS; attempt += 1) {
      const winner = readExtensionRelayToken(env);
      if (winner) {
        return winner;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RELAY_SECRET_REREAD_DELAY_MS);
      });
    }
    throw new Error("extension relay secret exists but is unreadable/malformed", { cause: err });
  }
}

/** Resolve the relay token for config (read-only; null until first ensured). */
export function resolveExtensionRelayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return readExtensionRelayToken(env);
}
