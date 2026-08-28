// Codesign Mac App tests cover codesign mac app script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { link } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  installFakeCodesign,
  installTransientFakeCodesign,
  installElevationFakeCodesign,
  makeSigningFixture,
  machoFixture,
} from "../helpers/mac-signing.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/codesign-mac-app.sh";

function entitlementTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("openclaw-entitlements"));
}

function runCodesign(args: string[], tempRoot: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tempRoot,
    },
  });
}

describe("codesign-mac-app temp file hygiene", () => {
  it("does not generate unused entitlement plist files", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('ENT_TMP_APP="$ENT_TMP_DIR/app.plist"');
    expect(script).not.toContain("ENT_TMP_BASE");
    expect(script).not.toContain("ENT_TMP_RUNTIME");
    expect(script).not.toContain("base.plist");
    expect(script).not.toContain("runtime.plist");
  });

  it("does not allocate entitlement temp files for help output", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-help-");
    const result = runCodesign(["--help"], tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not allocate entitlement temp files before app validation", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-missing-");
    const missingApp = path.join(tempRoot, "Missing.app");
    const result = runCodesign([missingApp], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("App bundle not found");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects unknown options before app validation", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-unknown-");
    const result = runCodesign(["--wat"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects extra app bundle arguments before signing", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-extra-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const result = runCodesign([app, "extra"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("cleans entitlement temp files when signing fails", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-fail-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("keeps helper signing plain and limits app entitlements to app code", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-success-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const logPath = path.join(captureDir, "codesign.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "-",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Codesign complete for ${app}`);

    const signLines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(signLines).toHaveLength(3);
    expect(signLines[0]).toBe(`plain\t${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}`);
    expect(signLines[1]).toContain(
      `entitled\t${path.join(app, "Contents", "MacOS", "OpenClaw")}\t`,
    );
    expect(signLines[2]).toContain(`entitled\t${app}\t`);
    for (const line of signLines.slice(1)) {
      const columns = line.split("\t");
      const entitlementPath = columns[2];
      const copiedEntitlementsPath = columns[3];
      const entitlementSource = expectDefined(entitlementPath, "codesign entitlement source path");
      const copiedEntitlementSource = expectDefined(
        copiedEntitlementsPath,
        "copied codesign entitlement path",
      );
      const copiedEntitlements = readFileSync(copiedEntitlementSource, "utf8");
      expect(entitlementSource).toContain("openclaw-entitlements");
      expect(existsSync(entitlementSource)).toBe(false);
      expect(copiedEntitlements).toContain("com.apple.security.automation.apple-events");
      expect(copiedEntitlements).toContain("com.apple.security.device.camera");
    }
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it.each([
    ["DISABLE_LIBRARY_VALIDATION", "forbids DISABLE_LIBRARY_VALIDATION=1"],
    ["SKIP_TEAM_ID_CHECK", "forbids SKIP_TEAM_ID_CHECK=1"],
  ])("rejects elevation-host %s bypasses before app validation", (key, diagnostic) => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-bypass-");
    const result = spawnSync("bash", [scriptPath, path.join(tempRoot, "Missing.app")], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        [key]: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("defines a closed Foundation elevation-host signing profile", () => {
    const script = readFileSync(scriptPath, "utf8");
    const elevationProfile = script.slice(
      script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]'),
      script.indexOf("else", script.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]')),
    );

    expect(script).toContain(
      'ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"',
    );
    expect(script).toContain('ELEVATION_TEAM_ID="FWJYW4S8P8"');
    expect(elevationProfile).toContain("<dict/>");
    expect(elevationProfile).not.toContain("com.apple.security.automation.apple-events");
    expect(script).toContain("verify_elevation_signature");
    expect(script).toContain('assert_no_apple_events_entitlement "$APP_BUNDLE"');
  });

  it.each(["file", "symlink"])("rejects an elevation-host CUA driver %s before signing", (kind) => {
    const tempRoot = tempDirs.make(`openclaw-codesign-elevation-cua-${kind}-`);
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const resources = path.join(app, "Contents", "Resources");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(resources, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    const cuaDriver = path.join(resources, "cua-driver");
    if (kind === "file") {
      writeFileSync(cuaDriver, "driver\n");
    } else {
      symlinkSync("/missing/cua-driver", cuaDriver);
    }
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not contain bundled CUA driver");
  });

  it("consumes complete codesign metadata under pipefail before validating authority", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-metadata-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_SECOND_AUTHORITY: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(`Codesign complete for ${app}`);
    expect(result.stderr).not.toContain("Elevation host requires");
  });

  it("preserves the precise diagnostic when codesign omits Authority", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-no-authority-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_NO_AUTHORITY: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("got 'not set'");
  });

  it("preserves a codesign failure after metadata output", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-elevation-failed-metadata-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installElevationFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_FAKE_FAIL_AFTER_METADATA: "1",
        OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).not.toContain(`Codesign complete for ${app}`);
    expect(result.stderr).toContain("Could not read codesign metadata");
  });

  it("retries only transient Apple timestamp failures", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-retry-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const countFile = path.join(tempRoot, "codesign-count");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installTransientFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_COUNT_FILE: countFile,
        CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
        CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
        CODESIGN_TRANSIENT_FAILURES: "2",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Transient Apple timestamp failure");
    expect(readFileSync(countFile, "utf8")).toBe("5");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not retry non-timestamp signing failures", () => {
    const tempRoot = tempDirs.make("openclaw-codesign-permanent-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const countFile = path.join(tempRoot, "codesign-count");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installTransientFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_COUNT_FILE: countFile,
        CODESIGN_PERMANENT_FAILURE: "1",
        CODESIGN_TIMESTAMP_RETRY_ATTEMPTS: "3",
        CODESIGN_TIMESTAMP_RETRY_DELAY_SECONDS: "0",
        CODESIGN_TRANSIENT_FAILURES: "0",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain("Transient Apple timestamp failure");
    expect(readFileSync(countFile, "utf8")).toBe("1");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it.each([
    {
      label: "Developer ID hash",
      identity: "63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1",
      timestamp: true,
    },
    {
      label: "lowercase Developer ID hash",
      identity: "63a99bff1d40e5a75c8a32b84be99d1dda6a44e1",
      timestamp: true,
    },
    {
      label: "Developer ID name",
      identity: "Developer ID Application: Example Corp (ABCDE12345)",
      timestamp: true,
    },
    {
      label: "development certificate hash",
      identity: "11AA22BB33CC44DD55EE66FF77008899AABBCCDD",
      timestamp: false,
    },
    {
      label: "unknown certificate hash",
      identity: "0123456789ABCDEF0123456789ABCDEF01234567",
      timestamp: false,
    },
    { label: "ad-hoc identity", identity: "-", timestamp: false },
    {
      label: "explicitly disabled timestamp",
      identity: "63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1",
      timestamp: false,
      mode: "off",
    },
  ])("applies automatic timestamp policy to $label", ({ identity, timestamp, mode }) => {
    const tempRoot = tempDirs.make("openclaw-codesign-timestamp-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const argsLog = path.join(captureDir, "codesign-args.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);
    const fakeSecurity = path.join(binDir, "security");
    writeFileSync(
      fakeSecurity,
      `#!/usr/bin/env bash
printf '%s\\n' \\
  '  1) 63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1 "Developer ID Application: Example Corp (ABCDE12345)"' \\
  '  2) 11AA22BB33CC44DD55EE66FF77008899AABBCCDD "Apple Development: Example Developer (ABCDE12345)"'
`,
    );
    chmodSync(fakeSecurity, 0o755);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_ARGS_LOG: argsLog,
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: path.join(captureDir, "codesign.log"),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: identity,
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
        ...(mode === undefined ? {} : { CODESIGN_TIMESTAMP: mode }),
      },
    });

    expect(result.status).toBe(0);
    const expectedFlag = timestamp ? "--timestamp" : "--timestamp=none";
    for (const args of readFileSync(argsLog, "utf8").trim().split("\n")) {
      expect(args.split(" ")).toContain(expectedFlag);
    }
  });
});

describe.runIf(process.platform === "darwin")("Mac native inventory", () => {
  const workerPath = "Contents/Resources/node-worker/arm64/";

  it.each([false, true])(
    "uses authoritative classification for all eight magics (elevation: %s)",
    (elevation) => {
      const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-formats-"));
      const expected = new Map<string, boolean>();
      const candidates: string[] = [];
      for (const bits of [32, 64]) {
        for (const little of [false, true]) {
          for (const fat of [false, true]) {
            for (const type of [2, 6]) {
              const filename = fixture.put(
                `${workerPath}-${bits}-${little}-${fat}-${type} executable\n\t'\\`,
                machoFixture(bits, little, fat, type),
              );
              candidates.push(filename);
              const classification = spawnSync("/usr/bin/file", ["-E", "-b", "--", filename], {
                encoding: "utf8",
              });
              expect(classification.status).toBe(0);
              if (classification.stdout.startsWith("Mach-O")) {
                expected.set(filename, type === 2);
              }
            }
          }
        }
      }
      for (const [name, bytes] of [
        ["Mach-O executable.txt", Buffer.from("not native code")],
        ["Java.class", Buffer.from("cafebabe0000003d0001", "hex")],
        ["truncated", Buffer.from("cffa", "hex")],
        ["fat-false-positive", Buffer.from("cafebabe", "hex")],
      ] as const) {
        fixture.put(workerPath + name, bytes);
      }
      symlinkSync(
        expectDefined(candidates[0], "native fixture"),
        path.join(fixture.worker, "native-link"),
      );
      symlinkSync("missing", path.join(fixture.worker, "dangling"));
      const result = fixture.run({}, elevation);
      expect(result.status, result.stderr).toBe(0);
      const events = fixture.events();
      const signed = events.filter(
        ({ args }) => args.includes("--sign") && args.at(-1) !== fixture.app,
      );
      expect(signed).toHaveLength(expected.size);
      expect(new Set(signed.map(({ args }) => args.at(-1)))).toEqual(new Set(expected.keys()));
      for (const { args, entitlements } of signed) {
        const target = expectDefined(args.at(-1), "signed path");
        expect(entitlements.includes("allow-jit"), target).toBe(expected.get(target));
        expect(entitlements).not.toContain("disable-library-validation");
        expect(entitlements).not.toContain("automation.apple-events");
        expect(
          events.some(
            ({ args: verify }) =>
              verify.includes("--verify") &&
              verify.includes("--strict") &&
              verify.at(-1) === target,
          ),
        ).toBe(true);
      }
      for (const { args } of events.filter(
        ({ args: query }) => query.includes("-dv") || query.includes("-d"),
      )) {
        expect(new Set([fixture.app, ...expected.keys()])).toContain(args.at(-1));
      }
      const classified = fixture.classifications().flatMap(({ args }) => args);
      for (const filename of candidates) {
        expect(classified).toContain(filename);
      }
    },
  );

  it("keeps classification process count bounded at candidate scale and never follows symlinks", async () => {
    const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-scale-"));
    for (let i = 0; i < 24; i++) {
      fixture.put(`${workerPath}native-${i}`, machoFixture(64, true, false, i % 2 ? 6 : 2));
    }
    const dataSource = path.join(path.dirname(fixture.app), "non-code-payload");
    writeFileSync(dataSource, "export {};\n");
    for (let start = 24; start < 1_024; start += 256) {
      const directory = path.join(fixture.worker, "data", String(start));
      mkdirSync(directory, { recursive: true });
      await Promise.all(
        Array.from({ length: Math.min(256, 1_024 - start) }, (_, index) =>
          link(dataSource, path.join(directory, `${start + index}.js`)),
        ),
      );
    }
    const outside = path.join(path.dirname(fixture.app), "external");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "native"), machoFixture());
    symlinkSync(outside, path.join(fixture.worker, "directory-link"));
    symlinkSync(path.join(outside, "native"), path.join(fixture.worker, "file-link"));
    symlinkSync("missing", path.join(fixture.worker, "dangling"));
    const result = fixture.scan({ maxFileCalls: 8 });
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.classifications().length).toBeLessThanOrEqual(2);
    const records = result.stdout.split("\0");
    expect(records.pop()).toBe("");
    const natives = records.filter((kind, index) => index % 2 === 0 && kind !== "symlink");
    expect(natives).toHaveLength(24);
    expect(records.filter((kind, index) => index % 2 === 0 && kind === "symlink")).toHaveLength(3);
    expect(records).not.toContain(path.join(outside, "native"));
  });

  it.each(["", "/", "///"])(
    "rejects a symlink bundle root with suffix %j before signing",
    (suffix) => {
      const root = tempDirs.make("openclaw-inventory-root-link-");
      const fixture = makeSigningFixture(root);
      fixture.put(workerPath + "node");
      const alias = path.join(root, "Alias.app");
      symlinkSync(fixture.app, alias);
      const result = fixture.run({}, false, alias + suffix);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not be a symlink");
      expect(fixture.events()).toEqual([]);
    },
  );

  it.each(["", "/", "///"])(
    "signs nested code before containers with bundle suffix %j",
    (suffix) => {
      const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-order-"));
      const helper = fixture.put("Contents/MacOS/openclaw-mlx-tts");
      const cua = fixture.put("Contents/Resources/cua-driver");
      const worker = fixture.put(workerPath + "node");
      const main = fixture.put("Contents/MacOS/OpenClaw");
      const sparkle = "Contents/Frameworks/Sparkle.framework";
      for (const member of [
        "Sparkle",
        "Autoupdate",
        "Updater.app/Contents/MacOS/Updater",
        "XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
        "XPCServices/Installer.xpc/Contents/MacOS/Installer",
      ]) {
        fixture.put(`${sparkle}/Versions/B/${member}`);
      }
      const nested = fixture.put(
        "Contents/Frameworks/Outer.framework/Versions/A/Inner.framework/inner.dylib",
        machoFixture(64, true, false, 6),
      );
      const result = fixture.run({}, false, fixture.app + suffix);
      expect(result.status, result.stderr).toBe(0);
      const signs = fixture
        .events()
        .filter(({ args }) => args.includes("--sign"))
        .map(({ args }) => args.at(-1));
      expect(signs.slice(0, 4)).toEqual([helper, cua, worker, main]);
      for (const child of signs) {
        for (const container of signs) {
          if (child && container && child.startsWith(container + "/")) {
            expect(signs.lastIndexOf(child), `${child} before ${container}`).toBeLessThan(
              signs.indexOf(container),
            );
          }
        }
      }
      expect(signs).toContain(nested);
      expect(signs.at(-1)).toBe(fixture.app);
    },
  );

  it.each([
    "mismatch",
    "metadata",
    "metadataFailure",
    "missingTeam",
    "verifyFailure",
    "authority",
    "appleEvents",
    "entitlementFailure",
  ])("fails closed on %s at the signing/audit boundary", (failure) => {
    const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-gates-"));
    const native = fixture.put(workerPath + "node");
    const config =
      failure === "missingTeam"
        ? { metadata: "missing" }
        : {
            [failure]:
              failure === "metadata"
                ? "failure"
                : failure === "authority"
                  ? "Wrong Authority"
                  : native,
          };
    const result = fixture.run(
      config,
      ["authority", "appleEvents", "entitlementFailure"].includes(failure),
    );
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stdout).not.toContain("Codesign complete");
  });

  it.each(["before", "after"])(
    "does not consume failed or partial inventory %s signing",
    (phase) => {
      for (const fault of [
        "scanner",
        "walk",
        "spawn",
        "classifier",
        "empty",
        "partial",
        "unterminated",
        "error-record",
      ]) {
        const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-failure-"));
        const native = fixture.put(workerPath + "node");
        fixture.put(workerPath + "addon", machoFixture(64, true, false, 6));
        const result = fixture.run({ fault, phase, partialPath: native });
        expect(result.status, `${phase}/${fault}: ${result.stdout}`).not.toBe(0);
        expect(result.stdout).not.toContain("Codesign complete");
        if (phase === "before") {
          expect(fixture.events().filter(({ args }) => args.includes("--sign"))).toEqual([]);
        }
      }
    },
  );

  it.each(["team", "entitlement"])(
    "audits native files created while signing the app (%s)",
    (gate) => {
      const fixture = makeSigningFixture(tempDirs.make("openclaw-inventory-fresh-"));
      fixture.put(workerPath + "node");
      const generated = path.join(fixture.worker, "generated-after-sign.node");
      const result = fixture.run(
        {
          generated,
          generatedHex: machoFixture(64, true, false, 6).toString("hex"),
          ...(gate === "team" ? { mismatch: generated } : { appleEvents: generated }),
        },
        gate === "entitlement",
      );
      expect(result.status, result.stdout).not.toBe(0);
      expect(
        fixture
          .events()
          .some(
            ({ args }) =>
              args.at(-1) === generated && args.includes(gate === "team" ? "-dv" : "-d"),
          ),
      ).toBe(true);
    },
  );
});
