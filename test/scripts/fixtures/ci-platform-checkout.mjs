import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../../../src/shared/pid-alive.ts";

const [mode, root, policyScenario, ...args] = process.argv.slice(2);
const [policy, startupFault] = policyScenario.split("/");
const linux = policy.startsWith("linux:");
const scenario = linux ? policy.slice("linux:".length) : policy;
const fixture = fileURLToPath(import.meta.url);
const workspace = path.join(root, "workspace");
const lease = path.join(root, "lease");
const recordsDir = path.join(root, "pids");
const eventsFile = path.join(root, "events.jsonl");
const commandsFile = path.join(root, "commands.jsonl");
const failureFile = path.join(root, "fixture-error.json");

function publish(name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
}

function record(pid, role, attempt = 0) {
  publish(`pids/${pid}.json`, { pid, role, attempt });
}

function records() {
  return fs
    .readdirSync(recordsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(recordsDir, file), "utf8")));
}

function boundary(name) {
  const owned = records();
  fs.appendFileSync(
    eventsFile,
    `${JSON.stringify({
      name,
      alive: owned.filter((entry) => entry.attempt > 0 && isPidAlive(entry.pid)),
      sentinelAlive: owned.some((entry) => entry.role === "sentinel" && isPidAlive(entry.pid)),
    })}\n`,
  );
}

async function until(predicate, label, timeout = Infinity) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(10);
  }
}

function observe(child) {
  let outcome;
  const exited = new Promise((resolve) => {
    const finish = (value) => {
      outcome ??= value;
      resolve(outcome);
    };
    // Subscribe immediately after spawn; errors are outcomes, not unhandled
    // rejections while a caller is still waiting for readiness.
    child.once("error", (error) => finish({ error: String(error) }));
    child.once("exit", (code, signal) => finish({ code, signal }));
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
    }
  });
  return { exited, getOutcome: () => outcome };
}

async function untilReady(predicate, label, observed) {
  // The supervisor's existing 45-second lifetime owns startup; releasing its
  // lease stops these waits without borrowing from the real cleanup allowance.
  await until(() => {
    if (!fs.existsSync(lease)) {
      throw new Error(`Fixture stopped before ${label}`);
    }
    if (fs.existsSync(failureFile)) {
      throw new Error(JSON.parse(fs.readFileSync(failureFile, "utf8")));
    }
    const outcome = observed.getOutcome();
    if (outcome) {
      throw new Error(`Fixture process ended before ${label}: ${JSON.stringify(outcome)}`);
    }
    // Check current state after installing terminal observers: readiness may
    // already exist, but an exited process must never count as ready.
    return predicate();
  }, label);
}

function launch(role, attempt) {
  const child = spawn(process.execPath, [fixture, role, root, policyScenario, String(attempt)], {
    stdio: "ignore",
  });
  const observed = observe(child);
  child.unref();
  return observed;
}

function holdLease() {
  // Orphans stop themselves when the supervisor releases the lease; no PID discovery/kills.
  // The independent ceiling also covers a supervisor killed before it can unlink the lease.
  const deadline = Date.now() + 60_000;
  setInterval(() => {
    if (!fs.existsSync(lease) || Date.now() >= deadline) {
      process.exit(0);
    }
  }, 20);
  if (!fs.existsSync(lease)) {
    process.exit(0);
  }
}

function insideWorkspace(target) {
  const resolved = path.resolve(target);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Fixture command escaped workspace: ${target}`);
  }
  return resolved;
}

async function command() {
  holdLease();
  record(process.pid, mode);
  if (mode === "sentinel") {
    return;
  }
  if (mode === "find") {
    insideWorkspace(args[0]);
    // Observe before the real deletion, while prior Git children can still write.
    boundary("delete");
    const result = spawnSync("/usr/bin/find", args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (mode === "child" || mode === "grandchild") {
    const attempt = Number(args[0]);
    process.on("SIGTERM", () => {});
    record(process.pid, mode, attempt);
    if (mode === "child") {
      // Fault injection crosses the former two-second fetch and four-second
      // readiness clocks without delaying an assertion or teardown.
      if (startupFault === "slow-grandchild" && attempt === 3) {
        await delay(4_100);
      }
      const grandchild = launch("grandchild", attempt);
      await untilReady(
        () => fs.existsSync(path.join(root, `ready-${attempt}.json`)),
        "grandchild readiness",
        grandchild,
      );
      publish(`tree-ready-${attempt}.json`, attempt);
    } else {
      publish(`ready-${attempt}.json`, attempt);
    }
    return;
  }
  if (mode !== "git") {
    throw new Error(`Unexpected fixture mode: ${mode}`);
  }
  let cwd = workspace;
  while (args[0] === "-C" || args[0] === "-c") {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "-C") {
      cwd = insideWorkspace(value);
    }
  }
  fs.appendFileSync(commandsFile, `${JSON.stringify({ cwd, args })}\n`);
  const operation = args.shift();
  if (operation === "init") {
    boundary("init");
    if (startupFault === "slow-init" && cwd === workspace) {
      await delay(4_100);
    }
    fs.mkdirSync(insideWorkspace(args[0]), { recursive: true });
    if (linux && cwd === workspace) {
      if (fs.readdirSync(workspace).length !== 0) {
        throw new Error("Previous checkout survived workspace deletion");
      }
      fs.writeFileSync(path.join(workspace, ".previous-checkout"), "owned\n");
    }
  } else if (operation === "fetch") {
    const counter = path.join(root, "attempt.json");
    const attempt = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, "utf8")) + 1 : 1;
    boundary(`fetch:${attempt}`);
    publish("attempt.json", attempt);
    record(process.pid, "parent", attempt);
    const child = launch("child", attempt);
    await untilReady(
      () => fs.existsSync(path.join(root, `tree-ready-${attempt}.json`)),
      "tree readiness",
      child,
    );
    if (scenario.startsWith("cancel-")) {
      // Cancellation starts only after both descendant readiness waits settled;
      // this disposition never advances the logical fetch clock.
      publish(`cancel-ready-${attempt}.json`, attempt);
      return;
    }
    if (scenario === "early-leader-exit") {
      process.exit(0);
    }
    if (scenario === "recovery" && attempt >= 3) {
      process.exit(0);
    }
    if (scenario === "harness-timeout" && cwd === workspace) {
      process.exit(0);
    }
    if (scenario === "harness-recovery" && (cwd === workspace || attempt > 2)) {
      process.exit(0);
    }
    if (scenario === "checkout-failure") {
      process.exit(0);
    }
    if (scenario === "git-failure") {
      process.exit(23);
    }
    if (scenario === "git-exit-124") {
      process.exit(124);
    }
    // One immutable tick per hanging attempt avoids replacing a file while
    // native Windows Python may have it open for a deadline read.
    publish(`fetch-clock/${attempt}.json`, attempt);
    return;
  } else if (operation === "checkout") {
    boundary(cwd === workspace ? "checkout" : "harness-checkout");
    if (scenario === "checkout-failure") {
      process.exit(23);
    }
    if (linux || cwd !== workspace) {
      const action = path.join(cwd, ".github/actions/setup-node-env");
      fs.mkdirSync(action, { recursive: true });
      fs.writeFileSync(path.join(action, "action.yml"), "fixture\n");
    }
  } else if (!["config", "remote", "sparse-checkout", "fetch"].includes(operation)) {
    throw new Error(`Unexpected fake git command: ${operation}`);
  }
  process.exit(0);
}

async function supervise() {
  fs.mkdirSync(recordsDir);
  fs.writeFileSync(eventsFile, "");
  fs.writeFileSync(commandsFile, "");
  fs.writeFileSync(lease, "owned\n");
  fs.mkdirSync(path.join(root, "fetch-clock"));
  const bin = path.join(root, "bin");
  const commandPath = `${bin}${path.delimiter}${process.env.PATH}`;
  const home = path.join(root, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  // Git Bash accepts forward-slash native paths; native Node records native Windows PIDs.
  const shellPath = (value) => value.replaceAll("\\", "/");
  const gitArgs = [process.execPath, fixture, "git", root, policyScenario];
  // Python's native Windows Popen needs a batch/executable entrypoint, not a
  // Bash shebang. Do not shadow it with an extensionless script on Windows.
  if (process.platform === "win32") {
    const argv = gitArgs.map((value) => `"${value}"`);
    fs.writeFileSync(path.join(bin, "git.cmd"), `@echo off\r\n${argv.join(" ")} %*\r\n`);
  } else {
    const argv = gitArgs.map((value) => quote(shellPath(value)));
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, {
      mode: 0o755,
    });
  }
  if (linux) {
    const argv = [process.execPath, fixture, "find", root, policyScenario].map(quote);
    fs.writeFileSync(path.join(bin, "find"), `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, {
      mode: 0o755,
    });
  }
  if (scenario === "cleanup-failure") {
    // Fail the real POSIX inspection boundary, without a production injection hook.
    fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  if (scenario.startsWith("non-executable-")) {
    fs.chmodSync(path.join(bin, scenario.slice("non-executable-".length)), 0o644);
  }
  const output = fs.openSync(path.join(root, "workflow.log"), "w");
  let shell;
  let stopping;
  const report = {
    code: null,
    boundaries: [],
    readyAttempts: [],
    cleanupRemaining: [],
    ownedProcesses: [],
    commands: [],
    output: "",
  };
  const stop = (error) => {
    stopping ??= (async () => {
      if (error) {
        report.error = String(error);
      }
      fs.rmSync(lease, { force: true });
      if (shell && shell.exitCode === null && shell.signalCode === null) {
        // Only this fixture's still-owned detached shell group may be signaled.
        if (process.platform === "win32") {
          const taskkill = path.join(process.env.SystemRoot, "System32", "taskkill.exe");
          spawnSync(taskkill, ["/PID", String(shell.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 2_000,
            killSignal: "SIGKILL",
          });
        } else {
          try {
            process.kill(-shell.pid, "SIGKILL");
          } catch (err) {
            if (err.code !== "ESRCH") {
              throw err;
            }
          }
        }
      }
      try {
        await until(
          () => records().every((entry) => !isPidAlive(entry.pid)),
          "fixture cleanup",
          4_000,
        );
      } catch (err) {
        report.error ??= String(err);
      }
      report.cleanupRemaining = records().filter((entry) => isPidAlive(entry.pid));
      report.ownedProcesses = records();
      report.boundaries = fs
        .readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      report.readyAttempts = fs
        .readdirSync(root)
        .filter((name) => /^ready-\d+\.json$/u.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")))
        .toSorted((left, right) => left - right);
      report.commands = fs
        .readFileSync(commandsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      report.output = fs.readFileSync(path.join(root, "workflow.log"), "utf8");
      publish("report.json", report);
      fs.closeSync(output);
      process.exit(report.error ? 1 : 0);
    })();
    return stopping;
  };
  process.once("disconnect", () => void stop("test parent disconnected"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => void stop(`supervisor received ${signal}`));
  }
  setTimeout(() => void stop("fixture deadline exceeded"), 45_000);
  try {
    if (process.platform !== "win32") {
      // A noexec mount can make PATH skip mocks and select real tools. Verify
      // resolution and executability before the workflow gets any chance to run.
      const preflight = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'for mock in "$@"; do resolved=$(command -v "${mock##*/}") || resolved=; if [[ "$resolved" != "$mock" || ! -x "$mock" ]]; then printf "mock unavailable: %s (resolved: %s)\\n" "$mock" "$resolved" >&2; exit 1; fi; done',
          "checkout-fixture",
          path.join(bin, "git"),
          ...(linux ? [path.join(bin, "find")] : []),
        ],
        {
          cwd: workspace,
          env: { PATH: commandPath },
          encoding: "utf8",
          timeout: 2_000,
          killSignal: "SIGKILL",
        },
      );
      if (preflight.error || preflight.status !== 0) {
        const detail =
          preflight.error?.message || preflight.stderr.trim() || `exit ${preflight.status}`;
        throw new Error(`Fixture setup: mock command resolution failed: ${detail}`);
      }
    }
    const sentinel = spawn(process.execPath, [fixture, "sentinel", root, policyScenario], {
      detached: true,
      stdio: "ignore",
    });
    await untilReady(
      () => records().some((entry) => entry.role === "sentinel"),
      "sentinel readiness",
      observe(sentinel),
    );
    if (stopping) {
      return;
    }
    const checkoutScript = shellPath(path.join(root, "checkout.sh"));
    // Git for Windows' Bash launcher prepends real Git to PATH. Reassert the
    // fixture's command boundary inside Bash so the test cannot contact GitHub.
    const shellArgs =
      process.platform === "win32"
        ? [
            "-c",
            'export PATH="$(cygpath -u "$1"):$PATH"; source "$2"',
            "checkout-fixture",
            bin,
            checkoutScript,
          ]
        : [checkoutScript];
    shell = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", ...shellArgs], {
      cwd: workspace,
      detached: true,
      stdio: ["ignore", output, output],
      env: {
        PATH: commandPath,
        HOME: home,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        GITHUB_WORKSPACE: shellPath(workspace),
        RUNNER_OS: linux ? "Linux" : process.platform === "win32" ? "Windows" : "macOS",
        PATHEXT: process.env.PATHEXT,
        CHECKOUT_REPO: "fixture/checkout",
        CHECKOUT_SHA: "a".repeat(40),
        CHECKOUT_BASE_SHA: linux && scenario === "early-leader-exit" ? "c".repeat(40) : "",
        WORKFLOW_SHA: "b".repeat(40),
      },
    });
    const observed = observe(shell);
    if (shell.pid) {
      record(shell.pid, "shell");
    }
    if (scenario.startsWith("cancel-")) {
      await untilReady(
        () => fs.existsSync(path.join(root, "cancel-ready-1.json")),
        "cancellation readiness",
        observed,
      );
      // exec replaces Bash on POSIX: this is the owner, not the Git group.
      shell.kill(scenario.slice("cancel-".length));
    }
    const outcome = await observed.exited;
    if (outcome.error) {
      throw new Error(outcome.error);
    }
    report.code = outcome.code;
    boundary("exit");
    if (fs.existsSync(failureFile)) {
      throw new Error(JSON.parse(fs.readFileSync(failureFile, "utf8")));
    }
    await stop();
  } catch (error) {
    await stop(error);
  }
}

if (mode === "supervise") {
  await supervise();
} else {
  try {
    await command();
  } catch (error) {
    publish("fixture-error.json", String(error));
    process.exit(1);
  }
}
