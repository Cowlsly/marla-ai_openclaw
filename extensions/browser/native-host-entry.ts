import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  parseBrowserNativeHostOrigins,
  runBrowserNativeHost,
} from "./src/browser/extension-native-host.js";
import {
  buildBrowserExtensionPairing,
  firstExtensionRelayPort,
} from "./src/browser/extension-pairing.js";
import { ensureExtensionRelayDaemonProcess } from "./src/browser/extension-relay-daemon-spawn.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const { callerOrigin, expectedOrigins } = parseBrowserNativeHostOrigins(process.argv.slice(2));
  let responseFrame: Buffer | undefined;
  await runBrowserNativeHost({
    manifestPath: requiredArgument("--manifest"),
    launcherPath: requiredArgument("--launcher"),
    callerOrigin,
    expectedOrigins,
    input: process.stdin,
    write: (frame) => {
      responseFrame = frame;
    },
    buildPairing: async () =>
      await buildBrowserExtensionPairing({
        cfg: getRuntimeConfig(),
        localTransport: "gateway",
      }),
    // The daemon entry is built as this entry's sibling, so resolve it from
    // this file's own location rather than a shared chunk path.
    ensureRelay: async () =>
      await ensureExtensionRelayDaemonProcess({
        port: firstExtensionRelayPort(getRuntimeConfig()),
        entryPath: fileURLToPath(new URL("./relay-daemon-entry.js", import.meta.url)),
      }),
  });
  const response = responseFrame;
  if (!response) {
    throw new Error("Native host produced no response frame");
  }
  await new Promise<void>((resolve) => {
    process.stdout.write(response, () => resolve());
  });
}

void main().catch(() => {
  process.exitCode = 1;
});
