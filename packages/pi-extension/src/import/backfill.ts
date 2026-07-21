// Surgical tag backfill for existing ledger transactions that a dedup fallback match
// identified but couldn't cleanly re-import: adds/updates just the `import_id` and
// `original_description` comment tags on the transaction already on disk, so a future
// re-import of the same statement (in the same source format) matches it exactly instead of
// relying on the weaker fallback again. Nothing else about the transaction is touched --
// not its payee, its displayed description, nor any other tag (see dedup.ts's
// ReconcileOutput.backfillTarget for how a target is identified, and why only these two
// fields are safe to rewrite here).

import type { SourcePos } from "../ledger/source-pos";
import { transactionEndLine } from "../ledger/source-pos";

export interface BackfillResult {
  newContent: string;
  /** False when both tags already held these exact values -- nothing to write. */
  changed: boolean;
}

/**
 * Insert or update the `import_id` and `original_description` tag lines on the transaction
 * at `location` within `content`. An existing tag line's value is replaced in place
 * (preserving its position); a missing tag is inserted as a new comment line immediately
 * after the transaction header, matching the order the importer itself writes new
 * transactions in (import_id first, then original_description).
 */
export function backfillTransaction(
  content: string,
  location: SourcePos,
  importId: string,
  description: string,
): BackfillResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let lines = content.split(/\r?\n/);
  let bodyStart = location.startLine; // 0-based index of the first line after the header
  let endLine = transactionEndLine(lines, location.startLine); // 1-based, exclusive-safe below

  const indent = lines[bodyStart]?.match(/^\s+/)?.[0] ?? "    ";

  const id = upsertTag(lines, bodyStart, endLine, indent, "import_id", importId);
  lines = id.lines;
  bodyStart = id.bodyStart;
  endLine = id.endLine;

  const desc = upsertTag(lines, bodyStart, endLine, indent, "original_description", description);
  lines = desc.lines;

  return { newContent: lines.join(eol), changed: id.changed || desc.changed };
}

interface UpsertResult {
  lines: string[];
  bodyStart: number;
  endLine: number;
  changed: boolean;
}

/**
 * Find a `; <name>: <value>` comment line within [bodyStart, endLine) (0-based, end
 * exclusive) and replace its value, or insert a new one right at bodyStart if absent.
 * Returns updated body boundaries, since an insertion shifts every later line down by one.
 */
function upsertTag(
  lines: string[],
  bodyStart: number,
  endLine: number,
  indent: string,
  name: string,
  value: string,
): UpsertResult {
  const re = new RegExp(`^(\\s*;\\s*${name}\\s*:\\s*)(.*)$`);
  for (let idx = bodyStart; idx < endLine; idx++) {
    const m = lines[idx]?.match(re);
    if (!m) continue;
    if (m[2] === value) return { lines, bodyStart, endLine, changed: false };
    lines[idx] = `${m[1]}${value}`;
    return { lines, bodyStart, endLine, changed: true };
  }
  lines.splice(bodyStart, 0, `${indent}; ${name}: ${value}`);
  return { lines, bodyStart: bodyStart + 1, endLine: endLine + 1, changed: true };
}
