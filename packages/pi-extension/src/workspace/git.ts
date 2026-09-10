// Git on the workspace repo. Ported from packages/desktop/src/main/git.ts.
//
// Best-effort by design: git may be missing and an unversioned workspace is
// still a working one -- failures are logged to stderr, never thrown. (stdout is
// the MCP JSON-RPC channel, so diagnostics must go to stderr.)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Run one git subcommand. Resolves true when it succeeded. */
function git(args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (err) => {
      if (err) process.stderr.write(`[accountant24-mcp] git ${args.join(" ")} failed: ${err.message}\n`);
      resolve(!err);
    });
  });
}

/** `git init` unless the directory is already a repo. True when a repo was created. */
export async function initRepo(cwd: string): Promise<boolean> {
  if (existsSync(join(cwd, ".git"))) return false;
  return git(["init"], cwd);
}

/** Stage everything and commit it. Best-effort: a no-op when git is missing or
 *  there is nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<void> {
  if (!(await git(["add", "-A"], cwd))) return;
  await git(["commit", "-m", message], cwd);
}
