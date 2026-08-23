import { createSubsystemLogger } from "../logging/subsystem.js";
import { readExtensionRelayToken } from "./extension-relay/relay-auth.js";
import {
  type ExtensionRelayHandle,
  startExtensionRelayServer,
} from "./extension-relay/relay-server.js";

const log = createSubsystemLogger("browser").child("relay-daemon");

/** Default grace before a daemon with no extension and no CDP clients exits. */
export const RELAY_DAEMON_IDLE_EXIT_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;

export type RelayDaemonExitReason = "port-in-use" | "no-credential" | "idle" | "stopped";

export type RelayDaemonRun = {
  /** Resolves when the daemon decides to exit; the caller owns process.exit. */
  done: Promise<RelayDaemonExitReason>;
  /** Bound relay port when the server started; null when startup was refused. */
  port: number | null;
  stop: () => void;
};

/**
 * Run the standalone extension relay daemon: one loopback relay server with no
 * Gateway. The daemon stays alive while the paired extension holds its relay
 * connection or a CDP client is attached, and exits once both sides have been
 * gone for the idle grace so an idle daemon never outlives Chrome.
 */
export async function runExtensionRelayDaemon(params: {
  port: number;
  readToken?: () => string | null;
  idleExitMs?: number;
  pollMs?: number;
  now?: () => number;
}): Promise<RelayDaemonRun> {
  const readToken = params.readToken ?? readExtensionRelayToken;
  const now = params.now ?? Date.now;
  const idleExitMs = params.idleExitMs ?? RELAY_DAEMON_IDLE_EXIT_MS;
  const pollMs = params.pollMs ?? IDLE_POLL_MS;
  let resolveDone: (reason: RelayDaemonExitReason) => void = () => {};
  const done = new Promise<RelayDaemonExitReason>((resolve) => {
    resolveDone = resolve;
  });

  const token = readToken();
  if (!token) {
    log.warn("relay daemon refused to start: no extension relay credential");
    resolveDone("no-credential");
    return { done, port: null, stop: () => {} };
  }

  let handle: ExtensionRelayHandle;
  try {
    handle = await startExtensionRelayServer({ port: params.port, token });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
      log.info(`relay port ${params.port} is already served; standalone daemon not needed`);
      resolveDone("port-in-use");
      return { done, port: null, stop: () => {} };
    }
    throw error;
  }
  log.info(`standalone extension relay listening on 127.0.0.1:${handle.port}`);

  let lastActiveAtMs = now();
  let stopped = false;
  const finish = (reason: RelayDaemonExitReason): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(idleTimer);
    void handle.close().finally(() => resolveDone(reason));
  };
  const idleTimer = setInterval(() => {
    if (handle.bridge.extensionConnected || handle.bridge.cdpClientCount > 0) {
      lastActiveAtMs = now();
      return;
    }
    if (now() - lastActiveAtMs >= idleExitMs) {
      log.info("relay daemon idle (no extension, no CDP clients); exiting");
      finish("idle");
    }
  }, pollMs);
  idleTimer.unref?.();

  return {
    done,
    port: handle.port,
    stop: () => finish("stopped"),
  };
}
