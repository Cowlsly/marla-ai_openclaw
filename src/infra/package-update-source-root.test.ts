import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function writePackageArtifact(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

async function writeSourceCheckout(packageRoot: string, version: string): Promise<void> {
  await Promise.all(
    [".git", "dist", "extensions", "src"].map((directory) =>
      fs.mkdir(path.join(packageRoot, directory), { recursive: true }),
    ),
  );
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
    fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    }),
    fs.writeFile(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8"),
  ]);
}

function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
    npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
  };
}

function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm --version") {
      return { stdout: "12.0.0\n", stderr: "", code: 0 };
    }
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

function createStagedSourceInstall(sourceRoot: string) {
  return async ({
    name,
    argv,
    cwd,
    timeoutMs,
  }: {
    name: string;
    argv: string[];
    cwd?: string;
    timeoutMs: number;
  }): Promise<PackageUpdateStepResult> => {
    expect(name).toBe("global update");
    expect(timeoutMs).toBe(1000);
    const prefixIndex = argv.indexOf("--prefix");
    const stagePrefix = argv[prefixIndex + 1];
    if (!stagePrefix) {
      throw new Error("missing staged prefix");
    }
    const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
    await fs.mkdir(stageLayout.globalRoot, { recursive: true });
    await fs.symlink(
      process.platform === "win32" ? sourceRoot : path.relative(stageLayout.globalRoot, sourceRoot),
      path.join(stageLayout.globalRoot, "openclaw"),
      process.platform === "win32" ? "junction" : undefined,
    );
    await fs.mkdir(stageLayout.binDir, { recursive: true });
    await fs.symlink(
      "../lib/node_modules/openclaw/openclaw.mjs",
      path.join(stageLayout.binDir, "openclaw"),
    );
    return {
      name,
      command: argv.join(" "),
      cwd: cwd ?? process.cwd(),
      durationMs: 1,
      exitCode: 0,
    };
  };
}

describe("package-to-Git source identity", () => {
  it("activates the exact built source checkout without package-only inventory", async () => {
    await withTestDir({ prefix: "openclaw-source-install-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceRoot = path.join(base, "checkout");
      await writePackageArtifact(packageRoot, "1.0.0");
      await writeSourceCheckout(sourceRoot, "2026.8.1");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: sourceRoot,
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: createStagedSourceInstall(sourceRoot),
        timeoutMs: 1000,
        expectedSourceRoot: sourceRoot,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2026.8.1");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
      await expect(fs.realpath(packageRoot)).resolves.toBe(await fs.realpath(sourceRoot));
    });
  });

  it("refuses a source link that resolves to a different checkout", async () => {
    await withTestDir({ prefix: "openclaw-source-mismatch-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const expectedRoot = path.join(base, "expected");
      const otherRoot = path.join(base, "other");
      await writePackageArtifact(packageRoot, "1.0.0");
      await writeSourceCheckout(expectedRoot, "2026.8.1");
      await writeSourceCheckout(otherRoot, "2026.8.1");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: otherRoot,
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: createStagedSourceInstall(otherRoot),
        timeoutMs: 1000,
        expectedSourceRoot: expectedRoot,
      });

      expect(result.failedStep?.name).toBe("global install verify");
      expect(result.steps.at(-1)?.stderrTail).toContain(
        `expected source checkout ${await fs.realpath(expectedRoot)}`,
      );
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });
});
