import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function installFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

if [ -n "\${CODESIGN_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$CODESIGN_ARGS_LOG"
fi

entitlements=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
      ;;
  esac
  target="$1"
  shift || true
done

if [ -z "$target" ]; then
  echo "missing codesign target" >&2
  exit 2
fi

if [ -n "$entitlements" ]; then
  count_file="$CODESIGN_CAPTURE_DIR/count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  copy="$CODESIGN_CAPTURE_DIR/entitlements-$count.plist"
  cp "$entitlements" "$copy"
  printf 'entitled\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\n' "$target" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

export function installTransientFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

count=0
if [ -f "$CODESIGN_COUNT_FILE" ]; then
  count="$(cat "$CODESIGN_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" >"$CODESIGN_COUNT_FILE"
if [ "\${CODESIGN_PERMANENT_FAILURE:-0}" = "1" ]; then
  echo "signing identity is not available" >&2
  exit 7
fi
if [ "$count" -le "$CODESIGN_TRANSIENT_FAILURES" ]; then
  echo "A timestamp was expected but was not found" >&2
  exit 1
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

export function installElevationFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

for arg in "$@"; do
  if [ "$arg" = "-dv" ]; then
    printf '%s\n' 'TeamIdentifier=FWJYW4S8P8' >&2
    if [ "\${CODESIGN_FAKE_NO_AUTHORITY:-0}" != "1" ]; then
      printf '%s\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2
    fi
    if [ "\${CODESIGN_FAKE_SECOND_AUTHORITY:-0}" = "1" ]; then
      printf '%s\n' 'Authority=Unexpected Secondary Authority' >&2
    fi
    for i in $(seq 1 20000); do
      printf 'Metadata-%s=value\n' "$i" >&2
    done
    if [ "\${CODESIGN_FAKE_FAIL_AFTER_METADATA:-0}" = "1" ]; then
      exit 7
    fi
    exit 0
  fi
done
exit 0
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

// SDK mach-o/{loader,fat}.h layouts; classification always uses the host's real file.
export function machoFixture(bits = 64, little = true, fat = false, fileType = 2): Buffer {
  const thin = Buffer.alloc(32);
  const write = (buffer: Buffer, value: number, offset: number) =>
    little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  write(thin, bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
  write(thin, bits === 64 ? 0x0100000c : 7, 4);
  write(thin, fileType, 12);
  if (!fat) {
    return thin;
  }
  const result = Buffer.alloc(4096 + thin.length);
  write(result, bits === 64 ? 0xcafebabf : 0xcafebabe, 0);
  write(result, 1, 4);
  write(result, bits === 64 ? 0x0100000c : 7, 8);
  if (bits === 64) {
    if (little) {
      result.writeBigUInt64LE(4096n, 16);
      result.writeBigUInt64LE(BigInt(thin.length), 24);
    } else {
      result.writeBigUInt64BE(4096n, 16);
      result.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    write(result, 12, 32);
  } else {
    write(result, 4096, 16);
    write(result, thin.length, 20);
    write(result, 12, 24);
  }
  thin.copy(result, 4096);
  return result;
}

type SigningEvent = { args: string[]; entitlements: string };
type FileEvent = { args: string[] };

export function makeSigningFixture(root: string) {
  const app = path.join(root, "Odd ' app.app");
  const worker = path.join(app, "Contents/Resources/node-worker/arm64");
  const bin = path.join(root, "bin");
  const options = path.join(root, "options.json");
  const events = path.join(root, "signing.jsonl");
  const files = path.join(root, "file.jsonl");
  const sealed = path.join(root, "sealed");
  for (const dir of [worker, bin]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(options, "{}");
  const fake = path.join(bin, "codesign");
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), target = args.at(-1);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(options)}, 'utf8'));
const ent = args.includes('--entitlements') && !args.includes('-d') ? fs.readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8') : '';
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({args, entitlements: ent}) + '\\n');
if (args.includes('-dv')) {
  if (config.metadata !== 'missing') console.error('TeamIdentifier=' + (target === config.mismatch ? 'WRONG' : 'FWJYW4S8P8'));
  console.error('Authority=' + (config.authority || 'Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'));
  if (config.metadata === 'failure' || config.metadataFailure === target) process.exit(7);
}
if (args.includes('-d')) {
  if (config.appleEvents === target) console.log('<key>com.apple.security.automation.apple-events</key>');
  if (config.entitlementFailure === target) process.exit(8);
}
if (args.includes('--verify') && config.verifyFailure === target) process.exit(9);
if (args.includes('--sign') && target === ${JSON.stringify(app)}) {
  fs.writeFileSync(${JSON.stringify(sealed)}, 'sealed');
  if (config.generated) fs.writeFileSync(config.generated, Buffer.from(config.generatedHex, 'hex'));
}
`,
  );
  chmodSync(fake, 0o755);
  const boundary = path.join(root, "boundary.py");
  writeFileSync(
    boundary,
    `import json, os, runpy, subprocess, sys
config = json.load(open(${JSON.stringify(options)}))
real_run = subprocess.run
mode = sys.argv.pop(1)
active = config.get('phase', 'before') == ('after' if os.path.exists(${JSON.stringify(sealed)}) else 'before')
fault = config.get('fault') if active else None

def classify(args, **kwargs):
    with open(${JSON.stringify(files)}, 'a') as log:
        log.write(json.dumps({'args': args}) + '\\n')
    with open(${JSON.stringify(files)}) as log:
        if sum(1 for _ in log) > config.get('maxFileCalls', 100):
            raise RuntimeError('classification process budget exceeded')
    if fault == 'spawn': raise OSError('classifier spawn failure')
    result = real_run(args, **kwargs)
    if fault == 'classifier': result.returncode = 7
    if fault == 'empty': result.stdout = b''
    if fault == 'partial': result.stdout = result.stdout.split(b'\\0')[0] + b'\\0'
    if fault == 'unterminated': result.stdout = result.stdout.rstrip(b'\\0')
    if fault == 'error-record': result.stdout = b'ERROR: cannot read\\0'
    return result

if mode == 'file':
    result = classify(['/usr/bin/file', *sys.argv[1:]], stdout=subprocess.PIPE)
    sys.stdout.buffer.write(result.stdout)
    sys.exit(result.returncode)
if fault == 'scanner':
    sys.stdout.buffer.write(b'executable\\0' + os.fsencode(config['partialPath']) + b'\\0')
    sys.exit(9)
if fault == 'walk':
    def fail_walk(*args, **kwargs): raise OSError('inventory traversal failure')
    os.scandir = fail_walk
subprocess.run = classify
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`,
  );
  const bashEnv = path.join(root, "bash-env");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bashEnv,
    `function /usr/bin/file() { command /usr/bin/python3 ${quote(boundary)} file "$@"; }
function /usr/bin/python3() { command /usr/bin/python3 ${quote(boundary)} scan "$@"; }
`,
  );
  function readEvents<T>(filename: string): T[] {
    return existsSync(filename)
      ? readFileSync(filename, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  return {
    app,
    worker,
    put(relative: string, data: Buffer | string = machoFixture()) {
      const filename = path.join(app, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, data);
      return filename;
    },
    run(config: Record<string, unknown> = {}, elevation = false, target = app) {
      writeFileSync(options, JSON.stringify(config));
      return spawnSync("/bin/bash", ["scripts/codesign-mac-app.sh", target], {
        encoding: "utf8",
        env: {
          HOME: root,
          TMPDIR: root,
          PATH: `${bin}:/usr/bin:/bin`,
          BASH_ENV: bashEnv,
          SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
          ...(elevation ? { OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host" } : {}),
        },
      });
    },
    scan(config: Record<string, unknown> = {}) {
      writeFileSync(options, JSON.stringify(config));
      return spawnSync(
        "/usr/bin/python3",
        [boundary, "scan", "scripts/lib/mac-native-inventory.py", app],
        {
          encoding: "utf8",
        },
      );
    },
    events: () => readEvents<SigningEvent>(events),
    classifications: () => readEvents<FileEvent>(files),
  };
}
