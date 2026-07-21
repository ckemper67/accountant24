import { isAbsolute, relative, resolve } from "node:path";
import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../config";
import { resolveSafePath } from "./paths";

// Shared parsing of an hledger transaction's on-disk location, used by both the
// modify tool (to edit the right lines) and the trace tool (to walk their git
// history). Kept in one place so the two agree on how `hledger print -O json`
// `tsourcepos` metadata maps to a file + line range.

/** An hledger transaction's location on disk. */
export interface SourcePos {
  /** Absolute path to the journal file the transaction lives in. */
  file: string;
  /** 1-based line of the transaction's first (header) line. */
  startLine: number;
}

/**
 * Parse hledger's `tsourcepos` (from `hledger print -O json`) into an absolute file
 * path and the 1-based header line, or null when the shape is unexpected or the file
 * resolves outside the ledger dir.
 *
 * `tsourcepos` is a two-element array `[start, end]`, each `{ sourceName, sourceLine,
 * sourceColumn }`. The header line is the start position's `sourceLine`.
 */
export function parseSourcePos(tsourcepos: unknown): SourcePos | null {
  if (!Array.isArray(tsourcepos) || tsourcepos.length === 0) return null;
  const start = tsourcepos[0];
  if (!start || typeof start.sourceName !== "string" || typeof start.sourceLine !== "number") {
    return null;
  }
  const file = resolveSourceFile(start.sourceName);
  if (!file) return null;
  return { file, startLine: start.sourceLine };
}

/**
 * Resolve an hledger source path to an absolute path, confirming it lives inside the
 * ledger dir. Note: hledger reports canonicalized (symlink-resolved) paths, so if
 * ACCOUNTANT24_HOME is itself a symlinked path the containment check fails and the
 * transaction is silently dropped. The production default (`~/Accountant24`) is a real
 * path, so this does not occur in practice; it only surfaces with a symlinked home.
 */
export function resolveSourceFile(sourceName: string): string | null {
  const abs = isAbsolute(sourceName) ? sourceName : resolve(ACCOUNTANT24_HOME, sourceName);
  try {
    resolveSafePath(relative(LEDGER_DIR, abs), LEDGER_DIR);
  } catch {
    return null;
  }
  return abs;
}

/**
 * Given a journal file's lines and a transaction's 1-based header line, return the
 * 1-based line number of the transaction's last line. A transaction runs from its
 * header down to the last indented (posting or comment) line, ending at the first
 * blank or non-indented line — the same block extent hledger and the modify tool use.
 */
export function transactionEndLine(lines: string[], startLine: number): number {
  let end = startLine;
  // lines is 0-based; the header is at index startLine-1, postings follow it.
  for (let idx = startLine; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") break; // blank line ends the transaction
    if (!/^\s/.test(line)) break; // non-indented line ends the transaction
    end = idx + 1; // idx is 0-based; record the 1-based line number
  }
  return end;
}
