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
// Weak fallback, registered unconditionally alongside every synthetic fingerprint:
//   Whenever loadExistingImportIds computes a synthetic fingerprint for an entry (untagged,
//   cross-source-tagged, or pdf-tagged -- see below), it ALSO tracks a weaker (account,
//   date, amount) key with no description, regardless of whether a description was
//   recoverable for that entry. A recovered description is never proof the current
//   importer would compute the same text: two formats routinely disagree on which column is
//   "the description" for the same real transaction (an OFX <MEMO> vs. a CSV description
//   column can hold entirely different text; some CSV exports even put payee-like text in a
//   column named "Description"), so gating the weak key on "was a description recovered"
//   previously let real duplicates slip through silently whenever that recovered text
//   didn't match what the current row hashes to. reconcile() treats a row that misses the
//   exact match but hits this weak key as a POSSIBLE duplicate: it is NOT written (an
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
//
// Cross-source and PDF re-imports: an untrustworthy exact tag:
//   An existing transaction's import_id is namespaced by the source that wrote it
//   ("ofx:<fitid>", "csv:<hash>", "pdf:<hash>"). A same-source re-import's computed id
//   matches that tag directly -- but a DIFFERENT source's computed id never can, since the
//   hash spaces don't intersect (e.g. importing the same statement via CSV after it was
//   already imported via OFX). loadExistingImportIds treats such a tag the same as no tag
//   at all: it still records the real tag in exactIds (in case the other source imports
//   again), but also falls through to compute a same-*current*-source synthetic
//   fingerprint, exactly as it does for untagged entries.
//
//   That synthetic fingerprint alone is often not enough, though: the recovered
//   description belongs to whichever format wrote the entry (an OFX <MEMO> vs. a CSV
//   description column are frequently different text for the same transaction), so the
//   synthetic hash may still miss -- see the weak-fallback section above for how that's
//   covered.
//
//   PDF/image statements get the same untrustworthy-exact-tag treatment even against
//   THEMSELVES (source === "pdf" on both sides): a "pdf:<hash>" tag's description came
//   from an LLM transcription of extracted text, which is not guaranteed to be
//   byte-identical between two import runs of the same statement (wording, whitespace, OCR
//   variance). So a pdf-tagged entry always falls through to the weak-key path too, same
//   as a genuine cross-source tag.

import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../config";
import { runHledger } from "../ledger/hledger";
import { resolveSafePath } from "../ledger/paths";
import { parseSourcePos, type SourcePos } from "../ledger/source-pos";

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

/** A fallback (untagged/cross-source/pdf-tagged) entry's location, or null if unlocatable. */
export type FallbackLocation = SourcePos | null;

/** Where a synthetic exact id's underlying fallback entry lives, for optional backfilling. */
export interface SyntheticFallback {
  /** The weak key this entry also contributed to (see `weakCandidates`). */
  weakKey: string;
  location: FallbackLocation;
}

/** Existing-ledger fingerprints to reconcile incoming rows against. */
export interface ExistingFingerprints {
  /** Exact import_id values (real trustworthy tags, plus synthetic ones for fallback entries). */
  exactIds: Set<string>;
  /**
   * One entry per fallback-entry candidate sharing a weak (account|date|amount) key, in
   * ledger scan order (same order ordinals were assigned) -- the array's length is that
   * key's weak-match budget. A candidate's own location is null when it couldn't be
   * resolved (backfilling is simply skipped for that one).
   */
  weakCandidates: Map<string, FallbackLocation[]>;
  /**
   * For SYNTHETIC exact ids only (not trustworthy real tags): the underlying fallback
   * entry's weak key and location. reconcile() uses the weak key to know that a row
   * matching one of these exact ids also "spends" one unit of that entry's weak-key budget,
   * so a different row can't also claim it via the weak fallback -- and uses the location to
   * offer that exact same entry up for backfilling. Real trustworthy tags are absent from
   * this map -- they never contribute to weakCandidates, so their exact hits must never
   * touch any weak budget (or backfill target) either.
   */
  syntheticFallback: Map<string, SyntheticFallback>;
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
  const empty: ExistingFingerprints = { exactIds: new Set(), weakCandidates: new Map(), syntheticFallback: new Map() };

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
  const weakCandidates = new Map<string, FallbackLocation[]>();
  const syntheticFallback = new Map<string, SyntheticFallback>();
  const fallbackOrdinals = new Map<string, number>();

  for (const tx of txns) {
    // Tags appear in ttags as an array of [name, value] pairs.
    const tags: unknown[] = Array.isArray(tx?.ttags) ? tx.ttags : [];
    const taggedImportId = tagValue(tags, "import_id");
    // A same-source tag is trustworthy for exact matching -- a same-source re-import
    // hashes to the identical value. A cross-source tag (e.g. "ofx:..." while importing
    // csv) is not: the two formats' id schemes never intersect. Neither is a "pdf:" tag
    // even when re-importing via pdf, since PDF descriptions are LLM-transcribed and not
    // guaranteed byte-identical between runs -- see the module header.
    const sameSource = taggedImportId?.startsWith(`${source}:`) ?? false;
    const trustExactTag = sameSource && source !== "pdf";
    if (taggedImportId !== undefined) {
      exactIds.add(taggedImportId);
      if (trustExactTag) continue;
    }

    // No import_id tag, or one whose exact match can't be trusted (cross-source or pdf):
    // recompute what a current-source import_id would be for each posting on the target
    // account, so a later import of the same statement still dedups against this entry.
    const date = typeof tx?.tdate === "string" ? tx.tdate : undefined;
    if (!date) continue;
    const description = recoverDescription(tx?.tdescription, tags);
    const location = parseSourcePos(tx?.tsourcepos);

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
        const syntheticId = computeImportId(account, row, ordinal, source);
        exactIds.add(syntheticId);

        // Always also register a weak (account, date, amount) candidate for entries that
        // reach this point (untagged, cross-source-tagged, or pdf-tagged): a "recovered"
        // description is never proof the current importer would compute the same text for
        // this transaction -- e.g. a CSV export's "Description" column and an OFX <MEMO>
        // routinely hold different text for the same real-world entry, or the CSV's own
        // "Description" column may semantically match what another format calls the payee.
        // Without this, a description mismatch here means the exact fingerprint above
        // silently misses and the row is (wrongly) treated as brand new. A description-
        // mismatched re-import is thus flagged as a possible duplicate instead.
        //
        // Record the link from this synthetic id to its weak key (and this entry's on-disk
        // location) so reconcile() can tell, deterministically (not by guessing at
        // consumption time), that a row exact-matching this id spends one unit of the SAME
        // budget a weak-matching row would draw from -- one underlying entry can't satisfy
        // two incoming rows via both channels at once -- and can offer this exact entry up
        // for an optional backfill (see ReconcileOutput.backfillTarget).
        const wKey = weakKey(account, row);
        const candidates = weakCandidates.get(wKey) ?? [];
        candidates.push(location);
        weakCandidates.set(wKey, candidates);
        syntheticFallback.set(syntheticId, { weakKey: wKey, location });
      }
    }
  }

  return { exactIds, weakCandidates, syntheticFallback };
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
  /**
   * When this row matched an existing fallback (untagged, cross-source, or pdf-tagged)
   * entry UNAMBIGUOUSLY, that entry's on-disk location -- so a caller can optionally
   * backfill it with this row's importId and description instead of leaving it to drift out
   * of sync (and re-flag or silently miss) on every future re-import. Always set for a
   * synthetic exact match (which identifies exactly one entry by construction). For a weak
   * match, only set when exactly one fallback entry ever shared the weak key -- with
   * multiple candidates there's no way to know which one this row corresponds to, so no
   * target is offered rather than guessing and backfilling the wrong entry. Always
   * undefined for genuinely new rows and for rows matching a trustworthy same-source tag
   * (already correctly tagged, nothing to backfill).
   */
  backfillTarget?: SourcePos;
}

/**
 * Determine which rows are new (not yet in the ledger) by import_id set membership, with a
 * weak (account, date, amount) fallback for existing transactions whose description is
 * unrecoverable or untrustworthy (see module header).
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
 * checked against `existing.weakCandidates`, sharing a budget per weak key with the
 * exact-match path: an existing fallback entry that a row already claimed via its synthetic
 * exact fingerprint must not ALSO be "available" for a different row to claim via the weak
 * fallback, since `loadExistingImportIds` registers a weak candidate for every fallback
 * entry (untagged, cross-source, or pdf-tagged) regardless of whether its synthetic exact
 * fingerprint also gets registered.
 *
 * This runs in two passes specifically to be independent of incoming row order (a
 * requirement, since row order is just statement order and carries no semantic meaning):
 *
 *   1. RESERVE: for every row that exact-matches a SYNTHETIC id (looked up via
 *      `existing.syntheticFallback`, never a trustworthy real tag -- see
 *      ExistingFingerprints), reserve one unit of that id's weak key budget, up to
 *      `existing.weakCandidates`'s length for that key. This happens for ALL rows before any
 *      weak allocation, so which rows get weak-matched in pass 2 never depends on the order
 *      rows were seen in pass 1 relative to each other.
 *   2. ALLOCATE: for rows that missed the exact match, walk them in order and allocate
 *      whatever weak budget remains after pass 1's reservations; the first K such rows
 *      sharing a weak key get isNew=false/weakMatch=true, any surplus is genuinely new.
 *
 * A trustworthy real tag's exact hit never touches `syntheticFallback` (it isn't in that
 * map), so it can never wrongly reserve budget that belongs to an unrelated fallback entry
 * sharing the same (account, date, amount).
 *
 * The weak fallback is NOT skipped for nativeId rows: a trustworthy incoming id says nothing
 * about whether the matching *existing* ledger entry was ever tagged, and OFX statements can
 * cover the exact untagged, pre-tool transactions the weak fallback exists for.
 */
export function reconcile(
  rows: DedupRow[],
  account: string,
  existing: ExistingFingerprints,
  source: ImportSource = "csv",
): ReconcileOutput[] {
  const fileOrdinalMap = new Map<string, number>();

  const importIds = rows.map((row) => {
    if (row.nativeId) return `${source}:${row.nativeId}`;
    const key = baseKey(account, row);
    const ordinal = fileOrdinalMap.get(key) ?? 0;
    fileOrdinalMap.set(key, ordinal + 1);
    return computeImportId(account, row, ordinal, source);
  });
  const isExactHit = importIds.map((id) => existing.exactIds.has(id));

  // Pass 1 (reserve): exact hits against a synthetic id spend one unit of its weak key's
  // budget, order-independent since it considers every row before any weak allocation. A
  // synthetic id always identifies exactly one existing entry, so its location is always a
  // safe backfill target.
  const weakConsumed = new Map<string, number>();
  const backfillByRow = new Array<SourcePos | undefined>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (!isExactHit[i]) continue;
    const fallback = existing.syntheticFallback.get(importIds[i]);
    if (fallback === undefined) continue; // trustworthy real tag -- no weak-budget coupling
    const budget = existing.weakCandidates.get(fallback.weakKey)?.length ?? 0;
    const consumed = weakConsumed.get(fallback.weakKey) ?? 0;
    if (consumed < budget) weakConsumed.set(fallback.weakKey, consumed + 1);
    if (fallback.location) backfillByRow[i] = fallback.location;
  }

  // Pass 2 (allocate): rows that missed the exact match draw from whatever weak budget pass
  // 1 left, in row order (order matters only among rows that are themselves indistinguishable
  // by any stronger signal, which is exactly what "weak" match means). A weak match's specific
  // existing entry is only attributable -- and therefore only offered for backfill -- when
  // exactly one candidate ever shared this weak key; with multiple candidates there's no way
  // to know which one this row corresponds to.
  return rows.map((row, i) => {
    const importId = importIds[i];
    if (isExactHit[i]) return { importId, isNew: false, weakMatch: false, backfillTarget: backfillByRow[i] };

    const wKey = weakKey(account, row);
    const pool = existing.weakCandidates.get(wKey) ?? [];
    const consumed = weakConsumed.get(wKey) ?? 0;
    if (consumed < pool.length) {
      weakConsumed.set(wKey, consumed + 1);
      const backfillTarget = pool.length === 1 ? (pool[0] ?? undefined) : undefined;
      return { importId, isNew: false, weakMatch: true, backfillTarget };
    }

    return { importId, isNew: true, weakMatch: false };
  });
}
