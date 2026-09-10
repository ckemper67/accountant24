import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ACCOUNTANT24_WORKSPACE, LEDGER_DIR } from "../config";
import { logLineRange } from "../git/git";
import { runHledger } from "./hledger";
import { resolveSafePath } from "./paths";
import { parseSourcePos, transactionEndLine } from "./source-pos";

// ── Types ───────────────────────────────────────────────────────────

/** One point in a transaction's git history: how it looked, and the change that produced it. */
export interface Revision {
  /** Full commit hash. */
  commit: string;
  /** Committer date, ISO-8601. */
  date: string;
  /** Commit subject line. */
  message: string;
  /** The unified diff of this transaction's lines at this commit. */
  diff: string;
  /** The transaction's text as of this commit (the diff's post-image). */
  text: string;
}

/** The full history of a single transaction, newest revision first. */
export interface TransactionHistory {
  /** Absolute path to the journal file the transaction lives in. */
  file: string;
  /** 1-based header line of the transaction. */
  startLine: number;
  /** 1-based last line of the transaction. */
  endLine: number;
  /** The transaction's current on-disk text. */
  currentText: string;
  /** Every commit that touched the transaction's lines, newest first. The oldest is the original. */
  revisions: Revision[];
}

export interface TraceResult {
  query: string[];
  /** Number of transactions the query matched (each gets a history entry). */
  found: number;
  histories: TransactionHistory[];
}

// ── Public ──────────────────────────────────────────────────────────

/**
 * Run an hledger query and trace each matching transaction's history through the
 * workspace git repo. For every match, walk the git log of the transaction's line
 * range (`git log -L`) to collect each commit that touched it, its diff, and the
 * transaction's text at that revision. The oldest revision is the original, so an
 * erroneously edited transaction can always be recovered.
 *
 * `query` is an array of hledger query terms, each passed verbatim as one argv token
 * (see modify.ts). Read-only: no ledger lock, no writes.
 */
export async function traceTransactions(query: string[], signal?: AbortSignal): Promise<TraceResult> {
  validateQuery(query);
  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  const matches = await discover(query, mainPath, signal);

  const histories: TransactionHistory[] = [];
  for (const match of matches) {
    const content = readFileSync(match.file, "utf8");
    const lines = content.split(/\r?\n/);
    const endLine = transactionEndLine(lines, match.startLine);
    const currentText = lines.slice(match.startLine - 1, endLine).join("\n");

    // git log -L needs the path relative to the repo root (the workspace).
    const relPath = relative(ACCOUNTANT24_WORKSPACE, match.file);
    const stdout = await logLineRange(ACCOUNTANT24_WORKSPACE, relPath, match.startLine, endLine);

    histories.push({
      file: match.file,
      startLine: match.startLine,
      endLine,
      currentText,
      revisions: parseLogL(stdout),
    });
  }

  return { query, found: histories.length, histories };
}

// ── Query validation ────────────────────────────────────────────────

function validateQuery(query: string[]): void {
  if (!Array.isArray(query) || query.length === 0) {
    throw new Error("query must be a non-empty array of hledger query terms.");
  }
  for (const term of query) {
    if (!term || term.trim() === "") {
      throw new Error("query terms must not be empty.");
    }
    // Query terms never start with '-'; reject to prevent hledger option injection.
    if (term.startsWith("-")) {
      throw new Error(`Invalid query term "${term}": query terms must not start with '-'.`);
    }
  }
}

// ── Discovery ───────────────────────────────────────────────────────

async function discover(
  query: string[],
  mainPath: string,
  signal?: AbortSignal,
): Promise<Array<{ file: string; startLine: number }>> {
  // Each query element is one argv token — spaces inside a term are preserved by spawn.
  const stdout = await runHledger(["print", "-f", mainPath, ...query, "-O", "json"], {
    cwd: ACCOUNTANT24_WORKSPACE,
    signal,
  });

  let txns: unknown;
  try {
    txns = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(txns)) return [];

  const matches: Array<{ file: string; startLine: number }> = [];
  for (const tx of txns) {
    const loc = parseSourcePos(tx?.tsourcepos);
    if (!loc) continue;
    matches.push({ file: loc.file, startLine: loc.startLine });
  }
  return matches;
}

// ── git log -L parsing ──────────────────────────────────────────────

// These match git.ts's LOG_FORMAT: RS (0x1e) begins each commit's metadata line, US
// (0x1f) separates its fields. Both are control chars that never appear in journal text.
const RS = "\x1e";
const US = "\x1f";

/**
 * Parse `git log -L ... --format=<RS>%H<US>%cI<US>%s` output into a revision chain,
 * newest first. Each commit is one RS-delimited chunk: an `<RS>hash<US>date<US>subject`
 * metadata line, then the range's unified diff. The transaction's text at a revision is
 * reconstructed from the diff's post-image (context + added lines).
 *
 * Exported for direct unit testing without a git repo.
 */
export function parseLogL(stdout: string): Revision[] {
  if (!stdout) return [];
  const revisions: Revision[] = [];
  // Everything before the first RS is preamble (empty); each later chunk is one commit.
  for (const chunk of stdout.split(RS).slice(1)) {
    const nl = chunk.indexOf("\n");
    const meta = nl === -1 ? chunk : chunk.slice(0, nl);
    const body = nl === -1 ? "" : chunk.slice(nl + 1);

    const [commit, date, message] = meta.split(US);
    if (!commit) continue;

    revisions.push({
      commit,
      date: date ?? "",
      message: message ?? "",
      diff: body.replace(/\n+$/, ""),
      text: reconstructPostImage(body),
    });
  }
  return revisions;
}

/**
 * Rebuild a transaction's text at one commit from its `-L` diff hunk. A single line
 * range yields one hunk; its post-image is the context (' ') and added ('+') lines with
 * the leading marker stripped. For the creation commit the hunk is all '+', so this
 * recovers the original transaction verbatim.
 */
function reconstructPostImage(diffBody: string): string {
  const out: string[] = [];
  let inHunk = false;
  for (const line of diffBody.split("\n")) {
    if (line.startsWith("@@")) {
      if (inHunk) break; // a second hunk: the single line range is already captured
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git")) break; // next file (shouldn't occur for one range)
    if (line.startsWith("+") || line.startsWith(" ")) {
      out.push(line.slice(1));
    }
    // '-' lines are pre-image only; '\ No newline...' and blanks are ignored.
  }
  return out.join("\n").replace(/\n+$/, "");
}
