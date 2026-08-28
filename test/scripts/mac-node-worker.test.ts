// Exercise publication and provisioning boundaries without signing, service control, or operator state.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("Mac app worker publication", () => {
  it.each(["sign", "worker", "seal", "stage", "success"])(
    "publishes only a verified replacement (%s)",
    (failure) => {
      const root = temps.make("openclaw-worker-publication-");
      const target = path.join(root, "OpenClaw.app");
      const staged = path.join(root, "candidate.app");
      mkdirSync(target);
      mkdirSync(staged);
      writeFileSync(path.join(target, "worker"), "old signed worker");
      writeFileSync(path.join(staged, "worker"), "new signed worker");
      const packageScript = readFileSync("scripts/package-mac-app.sh", "utf8");
      const publication = packageScript.slice(
        packageScript.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]'),
      );
      const worker = path.join(staged, "Contents/Resources/node-worker/arm64/bin/node");
      mkdirSync(path.dirname(worker), { recursive: true });
      writeFileSync(worker, `#!/bin/bash\nexit ${failure === "worker" ? 6 : 0}\n`);
      chmodSync(worker, 0o755);
      const scripts = path.join(root, "scripts");
      mkdirSync(scripts);
      writeFileSync(
        path.join(scripts, "codesign-mac-app.sh"),
        `#!/bin/bash\nexit ${failure === "sign" ? 9 : 0}\n`,
      );
      chmodSync(path.join(scripts, "codesign-mac-app.sh"), 0o755);
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      set -euo pipefail
      source scripts/lib/mac-app-bundle.sh
      ROOT_DIR=${quote(root)}
      APP_ROOT=${quote(staged)}
      APP_STAGE_DIR=${quote(root)}
      BUILD_ARCHS=(arm64)
      APP_DESTINATION=${quote(target)}
      codesign_calls=0
      codesign() {
        codesign_calls=$((codesign_calls + 1))
        if [[ ${quote(failure)} == seal && "$codesign_calls" -eq 2 ]]; then return 1; fi
        return 0
      }
      stop_packaged_app_if_running() { :; }
      mv() {
        if [[ "$1" == "$APP_ROOT" && ${quote(failure)} == stage ]]; then return 7; fi
        command mv "$@"
      }
      ${publication}
    `,
        ],
        { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } },
      );
      expect(result.status, result.stderr).toBe(
        failure === "success" ? 0 : failure === "worker" ? 6 : failure === "sign" ? 9 : 1,
      );
      expect(readFileSync(path.join(target, "worker"), "utf8")).toBe(
        failure === "success" ? "new signed worker" : "old signed worker",
      );
    },
  );

  it("provisions packages without invoking the service owner or changing operator state", () => {
    const root = temps.make("openclaw-worker-provision-");
    const home = path.join(root, "home");
    const prefix = path.join(root, "private");
    const sentinel = path.join(root, "operator", ".openclaw", "state", "sentinel");
    mkdirSync(path.dirname(sentinel), { recursive: true });
    mkdirSync(home);
    writeFileSync(sentinel, "operator-owned");
    const nodeDir = path.join(prefix, "tools", "node-v24.19.0");
    mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
    // Only npm/network is replaced. The real install_openclaw implementation
    // must remain a provision-only seam even when a loaded Gateway is reported.
    symlinkSync(process.execPath, path.join(nodeDir, "bin", "node"));
    const npm = path.join(nodeDir, "bin", "npm");
    writeFileSync(
      npm,
      `#!/bin/bash
case "$1" in
  --version) echo 11.15.0 ;;
  config) echo null ;;
  install)
    mkdir -p "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist"
    touch "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js"
    ;;
  *) exit 4 ;;
esac
`,
    );
    chmodSync(npm, 0o755);
    const calls = path.join(root, "service-calls");
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `
      set -euo pipefail
      source scripts/install-cli.sh
      PREFIX=${quote(prefix)}
      OPENCLAW_VERSION=/fixture/openclaw.tgz
      is_gateway_daemon_loaded() { echo loaded >> ${quote(calls)}; return 0; }
      refresh_gateway_service_if_loaded() { echo refresh >> ${quote(calls)}; }
      install_openclaw
      test -f "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"
    `,
      ],
      {
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
          OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("operator-owned");
  });
});

describe.runIf(process.platform === "darwin")("Mac worker portability inventory", () => {
  it("audits all eight header magics through real otool regardless of file classification", async () => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-signing.js");
    const root = temps.make("openclaw-portability-native-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    for (const bits of [32, 64]) {
      for (const little of [false, true]) {
        for (const fat of [false, true]) {
          const filename = path.join(root, `${bits}-${little}-${fat} addon`);
          writeFileSync(filename, machoFixture(bits, little, fat, 6));
        }
      }
    }
    symlinkSync("node", path.join(root, "internal-link"));
    expect(auditMacWorkerPortability(root, node)).toBe(9);
  });

  it("propagates otool rejection of Java sharing the fat magic", async () => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-signing.js");
    const root = temps.make("openclaw-portability-java-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    writeFileSync(path.join(root, "Java.class"), Buffer.from("cafebabe0000003d0001", "hex"));
    expect(() => auditMacWorkerPortability(root, node)).toThrow(/otool/);
  });

  it.each(["file", "directory", "dangling"])(
    "rejects %s symlinks outside the worker",
    async (kind) => {
      const { auditMacWorkerPortability } =
        await import("../../scripts/lib/mac-worker-portability.mjs");
      const { machoFixture } = await import("../helpers/mac-signing.js");
      const parent = temps.make("openclaw-portability-link-");
      const root = path.join(parent, "runtime");
      mkdirSync(root);
      const node = path.join(root, "node");
      writeFileSync(node, machoFixture());
      const external = path.join(parent, "external");
      if (kind === "directory") {
        mkdirSync(external);
      }
      if (kind === "file") {
        writeFileSync(external, "outside");
      }
      symlinkSync(external, path.join(root, "link"));
      expect(() => auditMacWorkerPortability(root, node)).toThrow(
        kind === "dangling" ? /ENOENT/ : /symlink escapes/,
      );
    },
  );

  it.each(
    [
      "/usr/lib/libSystem.B.dylib",
      "/opt/homebrew/lib/nonportable.dylib",
      "/usr/lib/../../opt/homebrew/lib/nonportable.dylib",
      "/System/Library/../../opt/homebrew/lib/nonportable.dylib",
      "@loader_path/../../outside.dylib",
    ].flatMap((library) => ["thin", "fat64"].map((format) => ({ library, format }))),
  )("audits load dependencies after inventory ($format, $library)", async ({ library, format }) => {
    const { auditMacWorkerPortability } =
      await import("../../scripts/lib/mac-worker-portability.mjs");
    const { machoFixture } = await import("../helpers/mac-signing.js");
    const root = temps.make("openclaw-portability-load-");
    const node = path.join(root, "node");
    writeFileSync(node, machoFixture());
    const addon = path.join(root, "addon");
    const header = machoFixture(64, true, false, 6);
    const name = Buffer.from(library + "\0");
    const command = Buffer.alloc(Math.ceil((24 + name.length) / 8) * 8);
    command.writeUInt32LE(0xc, 0); // LC_LOAD_DYLIB
    command.writeUInt32LE(command.length, 4);
    command.writeUInt32LE(24, 8);
    name.copy(command, 24);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(command.length, 20);
    const thin = Buffer.concat([header, command]);
    // On-disk fat headers are big endian; the arm64 slice is little endian.
    const payload =
      format === "fat64"
        ? Buffer.concat([machoFixture(64, false, true, 6).subarray(0, 4096), thin])
        : thin;
    if (format === "fat64") {
      payload.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    writeFileSync(addon, payload);
    const load = spawnSync("/usr/bin/otool", ["-l", addon], { encoding: "utf8" });
    expect(load.status, load.stderr).toBe(0);
    expect(load.stdout).toContain(`name ${library} (offset 24)`);
    if (library === "/usr/lib/libSystem.B.dylib") {
      expect(auditMacWorkerPortability(root, node)).toBe(2);
    } else {
      expect(() => auditMacWorkerPortability(root, node)).toThrow(/Nonportable LC_LOAD_DYLIB/);
    }
  });
});
