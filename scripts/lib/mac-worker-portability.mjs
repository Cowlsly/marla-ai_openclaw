import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The verifier owns containment and loader policy; inventory only observes types.
export function auditMacWorkerPortability(runtime, node) {
  const inside = (candidate) => candidate === runtime || candidate.startsWith(`${runtime}/`);
  const systemLibrary = (candidate) => {
    // A system-looking prefix must not hide a load path that escapes with ../.
    const normalized = path.normalize(candidate);
    return normalized.startsWith("/usr/lib/") || normalized.startsWith("/System/Library/");
  };
  function expandLoaderPath(value, filename) {
    return value
      .replace(/^@loader_path(?=\/|$)/u, path.dirname(filename))
      .replace(/^@executable_path(?=\/|$)/u, path.dirname(node));
  }
  function loadCommands(filename) {
    const output = execFileSync("/usr/bin/otool", ["-l", filename], { encoding: "utf8" });
    return output.split(/Load command \d+\n/u).flatMap((block) => {
      const command = /^\s*cmd (LC_\w+)$/mu.exec(block)?.[1];
      // LC_ID_DYLIB is an install ID, not a file the loader will open.
      if (!command || !/^LC_(?:LOAD.*DYLIB|REEXPORT_DYLIB|RPATH)$/u.test(command)) {
        return [];
      }
      const value = /^\s*(?:name|path) (.+) \(offset \d+\)$/mu.exec(block)?.[1];
      if (!value) {
        throw new Error(`Unreadable native load command in ${filename}`);
      }
      return [{ command, value }];
    });
  }

  const output = execFileSync(
    "/usr/bin/python3",
    [fileURLToPath(new URL("./mac-native-inventory.py", import.meta.url)), runtime],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const records = output.split("\0");
  if (records.pop() !== "" || records.length % 2 !== 0) {
    throw new Error("Incomplete worker native inventory");
  }
  const native = [];
  for (let index = 0; index < records.length; index += 2) {
    const kind = records[index];
    const filename = records[index + 1];
    if (!filename || !inside(filename)) {
      throw new Error("Invalid worker inventory path");
    }
    if (kind === "symlink") {
      if (!inside(fs.realpathSync(filename))) {
        throw new Error(`Worker symlink escapes bundle: ${filename}`);
      }
    } else if (kind === "executable" || kind === "library" || kind === "candidate") {
      native.push(filename);
    } else {
      throw new Error(`Invalid worker inventory kind: ${kind}`);
    }
  }
  const nodeRpaths = loadCommands(node).filter(({ command }) => command === "LC_RPATH");
  for (const filename of native) {
    const commands = loadCommands(filename);
    const rpaths = [...nodeRpaths, ...commands.filter(({ command }) => command === "LC_RPATH")];
    for (const { command, value } of commands) {
      const candidates = value.startsWith("@rpath/")
        ? rpaths.map(({ value: prefix }) =>
            path.join(expandLoaderPath(prefix, filename), value.slice(7)),
          )
        : [expandLoaderPath(value, filename)];
      if (
        !candidates.some(
          (candidate) =>
            systemLibrary(candidate) ||
            (path.isAbsolute(candidate) &&
              inside(path.resolve(candidate)) &&
              fs.existsSync(candidate) &&
              inside(fs.realpathSync(candidate))),
        )
      ) {
        throw new Error(`Nonportable ${command} in ${filename}: ${value}`);
      }
    }
  }
  return native.length;
}
