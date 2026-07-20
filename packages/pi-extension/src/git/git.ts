import { spawnText } from "../spawn";

// ── Commands ────────────────────────────────────────────────────────

export async function hasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await spawn(["git", "status", "--porcelain"], { cwd });
  return stdout.trim().length > 0;
}

export async function hasRemotes(cwd: string): Promise<boolean> {
  const { stdout } = await spawn(["git", "remote"], { cwd });
  return stdout.trim().length > 0;
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await spawn(["git", "add", "-A"], { cwd });
  await spawn(["git", "commit", "-m", message], { cwd });
}

export async function diffStat(cwd: string): Promise<string[]> {
  // Stage everything first so new/deleted files appear in the diff
  await spawn(["git", "add", "-A"], { cwd });
  const { stdout } = await spawn(["git", "diff", "--cached", "--name-only"], { cwd });
  return stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

export async function push(cwd: string): Promise<void> {
  await spawn(["git", "push", "origin", "HEAD"], { cwd });
}

// Record/unit separators from our `--format`, so the trace parser can split commit
// metadata from the patch that `-L` appends without colliding with journal text.
const LOG_FORMAT = "%x1e%H%x1f%cI%x1f%s";

/**
 * Return `git log -L<start>,<end>:<relPath>` output: every commit that touched that
 * (inclusive, 1-based) line range in `relPath`, newest first, each as our formatted
 * metadata line followed by the range's unified diff. `relPath` is relative to `cwd`
 * (the git root). Returns "" when there is no history (no commits yet, path untracked,
 * not a repo) or git is unavailable, so callers can treat it as an empty trace.
 */
export async function logLineRange(cwd: string, relPath: string, startLine: number, endLine: number): Promise<string> {
  const { exitCode, stdout } = await spawn(
    ["git", "log", "--no-color", `-L${startLine},${endLine}:${relPath}`, `--format=${LOG_FORMAT}`],
    { cwd },
  );
  // A non-zero exit (no history, but also any genuine git failure) is treated as an
  // empty trace: the tool cannot distinguish "no commits" from a rarer git error here,
  // and either way there is no history to show.
  return exitCode === 0 ? stdout : "";
}

// ── Internals ───────────────────────────────────────────────────────

async function spawn(
  cmd: string[],
  opts: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await spawnText(cmd, opts);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { exitCode: 127, stdout: "", stderr: `Command not found: ${cmd[0]}` };
    }
    throw err;
  }
}
