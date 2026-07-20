// Deduplication for CSV bank imports.
//
// Strategy: each imported row gets an `import_id` tag that is a deterministic hash over
// the row's identifying fields plus a per-file ordinal. Before writing, existing
// import_ids are read from the ledger via `hledger print -O json`; any incoming row whose
// import_id is already present is skipped. This dedups against transactions previously
// written by the importer (which carry the import_id tag).
//
// import_id format: "<source>:<hash-hex>" (e.g. "csv:1a2b3c...", "pdf:...")
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
//
// Fallback for untagged transactions:
//   Transactions written before this tool existed (or by hand, or by an agent transcribing
//   a PDF/OFX statement without going through the importer) carry no import_id tag. For
//   those, loadExistingImportIds additionally recomputes what their import_id *would* be
//   had they come through this importer -- same computeImportId over (account, date,
//   amount, description, ordinal) -- so a later CSV/row import of the same statement still
//   dedups against them. The description is recovered from the `original_description` tag
//   when present (the exact string a CSV row would have hashed), else from the note half of
//   "payee | note" in tdescription, else treated as empty. Ordinals for these synthetic
//   fingerprints are assigned in ledger scan order (which for statement-derived entries
//   tracks original statement order), giving the same same-day-duplicate handling (e.g.
//   two Aqua Springs charges on one day) as the primary path.
//
// Weak fallback for transactions with NO recoverable description:
//   Some accounts (e.g. ones transcribed before any tagging convention existed) have
//   untagged transactions with no `original_description` tag and no "payee | note" split --
//   there is no way to know what a re-imported row's description would be, so the exact
//   fingerprint above can only match the (unlikely) case where the CSV description is also
//   empty. For these transactions only, loadExistingImportIds additionally tracks a weaker
//   (account, date, amount) key with no description. reconcile() treats a row that misses
//   the exact match but hits this weak key as a POSSIBLE duplicate: it is NOT written (an
//   unresolvable date+amount collision is more likely a real duplicate than coincidence, and
//   a silently-written duplicate is worse than a silently-dropped one), but it is reported
//   back via ReconcileOutput.weakMatch so the caller can surface it for manual review/re-add
//   (via add_transactions) rather than silently disappearing. Ordinal-counted the same way as
//   the exact key, so K existing weak candidates absorb the first K colliding incoming rows
//   and any surplus still imports normally.
//
// Native ids (OFX FITID):
//   A source can supply a row-level DedupRow.nativeId (e.g. an OFX FITID) when it has a
//   real, bank-assigned per-transaction id. reconcile() then uses "<source>:<nativeId>" as
//   the exact-match key instead of the hash+ordinal -- no ordinal ambiguity, since the bank
//   guarantees uniqueness. This only changes how the EXACT key is computed; a miss still
//   falls through to the same weak (account, date, amount) fallback as any other row, since
//   the fallback exists for the state of the *existing* ledger entry (untagged), which a
//   trustworthy incoming id can't fix on its own.

import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../config";
import { runHledger } from "../ledger/hledger";
import { resolveSafePath } from "../ledger/paths";

// ── Types ────────────────────────────────────────────────────────────

/** Where a batch of rows came from -- namespaces the import_id so sources never collide. */
export type ImportSource = "csv" | "pdf" | "ofx";

export interface DedupRow {
  date: string; // normalized ISO YYYY-MM-DD
  amount: number; // parsed number
  description: string;
  payee: string;
  /**
   * A durable per-transaction id from the source itself (e.g. an OFX FITID), when the
   * source provides one. When set, this replaces the hash+ordinal as the exact-match key
   * (see reconcile()) -- but a miss still falls through to the weak fallback exactly like
   * any other row, since a reliable incoming id says nothing about whether the *existing*
   * ledger entry it should match is tagged.
   */
  nativeId?: string;
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

/** Weak fingerprint key: account+date+amount only, no description. */
function weakKey(account: string, row: DedupRow): string {
  return `${account}|${row.date}|${row.amount.toFixed(2)}`;
}

// FNV-1a 64-bit constants.
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a, 64-bit: a fast, simple, well-distributed non-cryptographic string hash. The
 * import_id is only a dedup fingerprint over non-adversarial bank data, so cryptographic
 * strength is unnecessary. 64 bits keeps the collision probability negligible even for a
 * ledger with hundreds of thousands of transactions (a collision would wrongly drop a real
 * row). Returns a hex string.
 */
function fnv1a64(str: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16);
}

/** Compute the import_id for a row at a given ordinal position. */
export function computeImportId(account: string, row: DedupRow, ordinal: number, source: ImportSource = "csv"): string {
  const key = `${baseKey(account, row)}|${ordinal}`;
  return `${source}:${fnv1a64(key)}`;
}

// ── Ledger read ──────────────────────────────────────────────────────

/** Look up a tag's value by name in an hledger ttags array (array of [name, value] pairs). */
function tagValue(tags: unknown[], name: string): string | undefined {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return undefined;
}

/** True if a CSV/row description can be recovered for this existing transaction. */
function hasRecoverableDescription(tdescription: unknown, tags: unknown[]): boolean {
  if (tagValue(tags, "original_description") !== undefined) return true;
  return typeof tdescription === "string" && tdescription.includes(" | ");
}

/**
 * Recover the description a CSV/row import would have hashed for an existing transaction
 * that predates (or bypassed) the importer: prefer the `original_description` tag (set
 * verbatim by this importer's own writes and, per observed ledger data, by prior manual/PDF
 * transcription following the same convention); else fall back to the "note" half of a
 * "payee | note" style tdescription; else empty (matches a row with no description).
 */
function recoverDescription(tdescription: unknown, tags: unknown[]): string {
  const tagged = tagValue(tags, "original_description");
  if (tagged !== undefined) return tagged;
  if (typeof tdescription === "string" && tdescription.includes(" | ")) {
    return tdescription.slice(tdescription.indexOf(" | ") + 3);
  }
  return "";
}

/** Existing-ledger fingerprints to reconcile incoming rows against. */
export interface ExistingFingerprints {
  /** Exact import_id values (real tags, plus synthetic ones for untagged transactions). */
  exactIds: Set<string>;
  /** Count of untagged, description-less transactions per weak (account|date|amount) key. */
  weakCounts: Map<string, number>;
}

/**
 * Extract all existing import_id tag values from the ledger via hledger print -O json, plus
 * synthetic fallback fingerprints for untagged transactions (see module header).
 */
export async function loadExistingImportIds(
  account: string,
  source: ImportSource,
  signal?: AbortSignal,
): Promise<ExistingFingerprints> {
  const empty: ExistingFingerprints = { exactIds: new Set(), weakCounts: new Map() };

  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  let stdout: string;
  try {
    stdout = await runHledger(["print", "-f", mainPath, "-O", "json"], {
      cwd: ACCOUNTANT24_HOME,
      signal,
    });
  } catch {
    // If the ledger doesn't exist yet or hledger fails, start with an empty set.
    return empty;
  }

  let txns: unknown;
  try {
    txns = JSON.parse(stdout);
  } catch {
    return empty;
  }
  if (!Array.isArray(txns)) return empty;

  const exactIds = new Set<string>();
  const weakCounts = new Map<string, number>();
  const fallbackOrdinals = new Map<string, number>();

  for (const tx of txns) {
    // Tags appear in ttags as an array of [name, value] pairs.
    const tags: unknown[] = Array.isArray(tx?.ttags) ? tx.ttags : [];
    const taggedImportId = tagValue(tags, "import_id");
    if (taggedImportId !== undefined) {
      exactIds.add(taggedImportId);
      continue; // Already has a real import_id; no need for a synthetic fallback.
    }

    // No import_id tag: recompute what one would be for each posting on the target
    // account, so a later import of the same statement still dedups against this entry.
    const date = typeof tx?.tdate === "string" ? tx.tdate : undefined;
    if (!date) continue;
    const recoverable = hasRecoverableDescription(tx?.tdescription, tags);
    const description = recoverDescription(tx?.tdescription, tags);

    const postings: unknown[] = Array.isArray(tx?.tpostings) ? tx.tpostings : [];
    for (const posting of postings) {
      const p = posting as { paccount?: unknown; pamount?: unknown[] };
      if (p?.paccount !== account) continue;
      const amounts: unknown[] = Array.isArray(p?.pamount) ? p.pamount : [];
      for (const amt of amounts) {
        const a = amt as { aquantity?: { decimalMantissa?: unknown; decimalPlaces?: unknown } };
        const mantissa = a?.aquantity?.decimalMantissa;
        const places = a?.aquantity?.decimalPlaces;
        if (typeof mantissa !== "number" || typeof places !== "number") continue;
        const amount = mantissa / 10 ** places;

        const row: DedupRow = { date, amount, description, payee: "" };
        const key = baseKey(account, row);
        const ordinal = fallbackOrdinals.get(key) ?? 0;
        fallbackOrdinals.set(key, ordinal + 1);
        exactIds.add(computeImportId(account, row, ordinal, source));

        // No recoverable description: also register a weak (account, date, amount)
        // candidate, so a description-mismatched re-import of this transaction is
        // flagged as a possible duplicate instead of silently re-written.
        if (!recoverable) {
          const wKey = weakKey(account, row);
          weakCounts.set(wKey, (weakCounts.get(wKey) ?? 0) + 1);
        }
      }
    }
  }

  return { exactIds, weakCounts };
}

// ── Reconcile ────────────────────────────────────────────────────────

export interface ReconcileOutput {
  importId: string;
  isNew: boolean;
  /**
   * True if this row was NOT matched exactly, but its (account, date, amount) collided with
   * an existing description-less transaction. Such rows are treated as isNew = false (not
   * written) but are reported back for manual review -- see module header.
   */
  weakMatch: boolean;
}

/**
 * Determine which rows are new (not yet in the ledger) by import_id set membership, with a
 * weak (account, date, amount) fallback for existing transactions whose description is
 * unrecoverable (see module header).
 *
 * Each row without a `nativeId` is assigned a per-file ordinal (its index among rows sharing
 * the same base fingerprint) and hashed to an import_id; a row with a `nativeId` (e.g. an
 * OFX FITID) uses `${source}:${nativeId}` directly instead. A row is new iff its import_id
 * is not already present in `existing.exactIds`. Because ordinals are assigned
 * deterministically per base fingerprint, the hash path alone gives correct multiset
 * idempotency on re-import (see module header): the first K duplicates match the K existing
 * copies and only the surplus is new.
 *
 * Rows that miss the exact match -- regardless of whether they had a nativeId -- are then
 * checked against `existing.weakCounts`, ordinal-counted the same way: the first K rows
 * sharing a weak key are treated as possible duplicates of the K existing weak candidates
 * (isNew = false, weakMatch = true) and are not written; any surplus beyond K is genuinely
 * new. This fallback is NOT skipped for nativeId rows: a trustworthy incoming id says
 * nothing about whether the matching *existing* ledger entry was ever tagged, and OFX
 * statements can cover the exact untagged, pre-tool transactions the weak fallback exists
 * for.
 */
export function reconcile(
  rows: DedupRow[],
  account: string,
  existing: ExistingFingerprints,
  source: ImportSource = "csv",
): ReconcileOutput[] {
  const fileOrdinalMap = new Map<string, number>();
  const weakOrdinalMap = new Map<string, number>();

  return rows.map((row) => {
    let importId: string;
    if (row.nativeId) {
      importId = `${source}:${row.nativeId}`;
    } else {
      const key = baseKey(account, row);
      const ordinal = fileOrdinalMap.get(key) ?? 0;
      fileOrdinalMap.set(key, ordinal + 1);
      importId = computeImportId(account, row, ordinal, source);
    }

    if (existing.exactIds.has(importId)) {
      return { importId, isNew: false, weakMatch: false };
    }

    const wKey = weakKey(account, row);
    const weakOrdinal = weakOrdinalMap.get(wKey) ?? 0;
    weakOrdinalMap.set(wKey, weakOrdinal + 1);
    const weakMatch = weakOrdinal < (existing.weakCounts.get(wKey) ?? 0);

    return { importId, isNew: !weakMatch, weakMatch };
  });
}
