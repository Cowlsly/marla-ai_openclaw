import { root as fsRoot, sanitizeUntrustedFileName } from "../infra/fs-safe.js";

export const STAGED_INPUT_DIRECTORY_PREFIX = "media/inbound/openclaw-staged-";
export const STAGED_INPUT_GIT_PATHSPEC = `:(glob)${STAGED_INPUT_DIRECTORY_PREFIX}*/**`;
const STAGED_INPUT_GITIGNORE =
  "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";

/** Shared by producers, workspace inventories, and lossless worktree snapshots. */
export function isStagedInputPath(relativePath: string): boolean {
  return (
    relativePath.startsWith(STAGED_INPUT_DIRECTORY_PREFIX) &&
    /^[a-f0-9-]+(?:\/|$)/u.test(relativePath.slice(STAGED_INPUT_DIRECTORY_PREFIX.length))
  );
}

export function stagedInputDirectory(identity: string): string {
  return `${STAGED_INPUT_DIRECTORY_PREFIX}${identity}`;
}

export function stagedInputFileName(name: string): string {
  // A generic prefix keeps uploaded Git control filenames ordinary input files.
  return sanitizeUntrustedFileName(`input-${name}`, "input-attachment");
}

export async function ensureStagedInputDirectory(
  rootDir: string,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = await fsRoot(rootDir);
  const ignorePath = `${directory}/.gitignore`;
  if (await root.exists(directory)) {
    if ((await root.readText(ignorePath, { maxBytes: 1024 })) !== STAGED_INPUT_GITIGNORE) {
      throw new Error("Input staging directory is not owned by OpenClaw");
    }
    return;
  }
  // Never add an exclusion to an existing project directory or replace its files.
  signal?.throwIfAborted();
  await root.create(ignorePath, STAGED_INPUT_GITIGNORE, { mode: 0o600 });
}
