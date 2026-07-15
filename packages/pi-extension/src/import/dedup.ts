// Deduplication for CSV bank imports.
//
// Strategy: each imported row gets an `import_id` tag that is a deterministic hash over
// the row's identifying fields plus a per-file ordinal. Before writing, existing
// import_ids are read from the ledger via `hledger print -O json`; any incoming row whose
// import_id is already present is skipped. This dedups against transactions previously
// written by the importer (which carry the import_id tag).
//
// import_id format: "csv:<sha256-hex>"
//
// The hash covers: account | date | normalized-amount | normalized-description | ordinal.
//
// Multiset idempotency via the ordinal:
//   The ordinal (0, 1, 2, ...) is the index among rows that share the same base
//   fingerprint within the same file. Genuine same-day duplicates (e.g. two identical
//   coffee purchases) therefore get distinct import_ids (ordinal 0 and 1) instead of
//   collapsing. When the same account is re-exported, K existing copies occupy ordinals
//   0..K-1, so on re-import the first K incoming rows match existing import_ids and are
//   skipped while the remaining N-K are imported -- correct regardless of row order,
//   because the SET of (fingerprint, ordinal) hashes is order-independent for a fixed
//   multiset. No separate fingerprint-count pass is needed.

import { createHash } from "node:crypto";
import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../config";
import { runHledger } from "../ledger/hledger";
import { resolveSafePath } from "../ledger/paths";

// ── Types ────────────────────────────────────────────────────────────

export interface DedupRow {
  date: string; // normalized ISO YYYY-MM-DD
  amount: number; // parsed number
  description: string;
  payee: string;
}

export interface DedupResult {
  importId: string; // "csv:<hash>"
  isNew: boolean; // false if this exact import_id is already present
}

// ── Hashing ─────────────────────────────────────────────────────────

/** Normalize a description for fingerprinting: lowercase, collapse whitespace. */
function normalizeDesc(desc: string): string {
  return desc.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Build the base fingerprint key (without ordinal). */
function baseKey(account: string, row: DedupRow): string {
  // Round to 2 decimal places to avoid floating-point noise.
  const amountStr = row.amount.toFixed(2);
  return `${account}|${row.date}|${amountStr}|${normalizeDesc(row.description)}`;
}

/** Compute the import_id for a row at a given ordinal position. */
export function computeImportId(account: string, row: DedupRow, ordinal: number): string {
  const key = `${baseKey(account, row)}|${ordinal}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `csv:${hash}`;
}

// ── Ledger read ──────────────────────────────────────────────────────

/** Extract all existing import_id tag values from the ledger via hledger print -O json. */
export async function loadExistingImportIds(signal?: AbortSignal): Promise<Set<string>> {
  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  let stdout: string;
  try {
    stdout = await runHledger(["print", "-f", mainPath, "-O", "json"], {
      cwd: ACCOUNTANT24_HOME,
      signal,
    });
  } catch {
    // If the ledger doesn't exist yet or hledger fails, start with an empty set.
    return new Set();
  }

  let txns: unknown;
  try {
    txns = JSON.parse(stdout);
  } catch {
    return new Set();
  }
  if (!Array.isArray(txns)) return new Set();

  const ids = new Set<string>();
  for (const tx of txns) {
    // Tags appear in ttags as an array of [name, value] pairs.
    const tags: unknown[] = Array.isArray(tx?.ttags) ? tx.ttags : [];
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === "import_id" && typeof tag[1] === "string") {
        ids.add(tag[1]);
      }
    }
  }
  return ids;
}

// ── Reconcile ────────────────────────────────────────────────────────

export interface ReconcileOutput {
  importId: string;
  isNew: boolean;
}

/**
 * Determine which rows are new (not yet in the ledger) by import_id set membership.
 *
 * Each row is assigned a per-file ordinal (its index among rows sharing the same base
 * fingerprint) and hashed to an import_id. A row is new iff its import_id is not already
 * present in `existingIds`. Because ordinals are assigned deterministically per base
 * fingerprint, this alone gives correct multiset idempotency on re-import (see module
 * header): the first K duplicates match the K existing copies and only the surplus is new.
 */
export function reconcile(rows: DedupRow[], account: string, existingIds: Set<string>): ReconcileOutput[] {
  const fileOrdinalMap = new Map<string, number>();

  return rows.map((row) => {
    const key = baseKey(account, row);
    const ordinal = fileOrdinalMap.get(key) ?? 0;
    fileOrdinalMap.set(key, ordinal + 1);

    const importId = computeImportId(account, row, ordinal);
    return { importId, isNew: !existingIds.has(importId) };
  });
}
