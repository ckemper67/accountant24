// Deduplication for bank statement imports (CSV, OFX, and PDF-transcribed rows).
//
// Strategy: each imported row gets an `import_id` tag that is a deterministic hash over
// (account, date, amount, ordinal) -- deliberately NOT the description or the import
// source. Before writing, existing import_ids are read from the ledger via `hledger print
// -O json`; any incoming row whose import_id is already present is skipped.
//
// Description is excluded on purpose: it's the least reliable field across sources (an OFX
// <MEMO> and a CSV "Description" column routinely hold different text for the same real
// transaction, and PDF transcriptions vary between runs of the same statement). Source is
// excluded too, so the SAME transaction gets the SAME import_id no matter which format it
// was (or is) imported through -- importing a statement via CSV then later re-importing the
// same period via OFX recognizes the overlap directly, with no cross-source handling
// needed.
//
// Multiset idempotency via the ordinal:
//   The ordinal (0, 1, 2, ...) is the index among rows that share the same (account, date,
//   amount) within the same import. Genuine same-day duplicates (e.g. two identical coffee
//   purchases) get distinct import_ids (ordinal 0 and 1) instead of collapsing. When the
//   same account is re-imported, K existing copies occupy ordinals 0..K-1, so the first K
//   incoming rows match and are skipped while any surplus imports -- correct regardless of
//   row order, because the SET of (fingerprint, ordinal) ids is order-independent for a
//   fixed multiset.
//
// Fallback for untagged transactions:
//   Transactions written before this tool existed (or entered by hand, or transcribed
//   without going through the importer) carry no import_id tag. loadExistingImportIds
//   additionally recomputes what their import_id *would* be, using the same (account, date,
//   amount, ordinal) fingerprint, so a later import of the same statement still dedups
//   against them. Ordinal assignment happens in ledger scan order, but that doesn't affect
//   correctness: for K existing entries sharing a fingerprint, the SET of ids produced is
//   always {fingerprint|0, ..., fingerprint|K-1} regardless of which physical entry gets
//   which number -- same-fingerprint entries are interchangeable for matching purposes, so
//   the user reordering their journal by hand can't break this.

import { ACCOUNTANT24_WORKSPACE, LEDGER_DIR } from "../config";
import { runHledger } from "../ledger/hledger";
import { resolveSafePath } from "../ledger/paths";

// ── Types ────────────────────────────────────────────────────────────

export interface DedupRow {
  date: string; // normalized ISO YYYY-MM-DD
  amount: number; // parsed number
}

// ── Hashing ─────────────────────────────────────────────────────────

/** Build the fingerprint key: account + date + amount, no description or source. */
function fingerprintKey(account: string, row: DedupRow): string {
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
export function computeImportId(account: string, row: DedupRow, ordinal: number): string {
  return fnv1a64(`${fingerprintKey(account, row)}|${ordinal}`);
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
 * Exact 2-decimal-place string for an hledger amount (mantissa * 10^-places), computed via
 * integer arithmetic. Dividing mantissa by 10**places as a float first (the naive approach)
 * can introduce floating-point noise before a later `.toFixed(2)` rounds it -- e.g. a
 * mantissa/places pair that represents an exact value can still round-trip through a
 * slightly-off float. Rounding is half-up on the cents boundary.
 */
function amountToFixed2(mantissa: number, places: number): string {
  const negative = mantissa < 0;
  const abs = BigInt(Math.abs(mantissa));
  const cents = places <= 2 ? abs * 10n ** BigInt(2 - places) : roundHalfUp(abs, 10n ** BigInt(places - 2));
  const digits = cents.toString().padStart(3, "0");
  const intPart = digits.slice(0, -2);
  const fracPart = digits.slice(-2);
  const sign = negative && cents !== 0n ? "-" : "";
  return `${sign}${intPart}.${fracPart}`;
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

/**
 * Extract all existing import_id tag values from the ledger via hledger print -O json, plus
 * synthetic fingerprints for untagged transactions on `account` (see module header).
 */
export async function loadExistingImportIds(account: string, signal?: AbortSignal): Promise<Set<string>> {
  const exactIds = new Set<string>();

  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  let stdout: string;
  try {
    stdout = await runHledger(["print", "-f", mainPath, "-O", "json"], {
      cwd: ACCOUNTANT24_WORKSPACE,
      signal,
    });
  } catch {
    // If the ledger doesn't exist yet or hledger fails, start with an empty set.
    return exactIds;
  }

  let txns: unknown;
  try {
    txns = JSON.parse(stdout);
  } catch {
    return exactIds;
  }
  if (!Array.isArray(txns)) return exactIds;

  const fallbackOrdinals = new Map<string, number>();

  for (const tx of txns) {
    // Tags appear in ttags as an array of [name, value] pairs.
    const tags: unknown[] = Array.isArray(tx?.ttags) ? tx.ttags : [];
    const taggedImportId = tagValue(tags, "import_id");
    if (taggedImportId !== undefined) {
      exactIds.add(taggedImportId);
      continue;
    }

    // No import_id tag: recompute what this entry's id would be for each posting on the
    // target account, so a later import of the same statement still dedups against it.
    const date = typeof tx?.tdate === "string" ? tx.tdate : undefined;
    if (!date) continue;

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

        const amountStr = amountToFixed2(mantissa, places);
        const key = `${account}|${date}|${amountStr}`;
        const ordinal = fallbackOrdinals.get(key) ?? 0;
        fallbackOrdinals.set(key, ordinal + 1);
        exactIds.add(fnv1a64(`${key}|${ordinal}`));
      }
    }
  }

  return exactIds;
}

// ── Reconcile ────────────────────────────────────────────────────────

export interface ReconcileOutput {
  importId: string;
  isNew: boolean; // false if this exact import_id is already present
}

/**
 * Determine which rows are new (not yet in the ledger) by import_id set membership. Each
 * row is assigned a per-import ordinal (its index among rows sharing the same (account,
 * date, amount) fingerprint) and hashed to an import_id; a row is new iff its import_id is
 * not already present in `existing`. Because ordinals are assigned deterministically per
 * fingerprint, this gives correct multiset idempotency on re-import: the first K duplicates
 * match the K existing copies and only the surplus is new.
 */
export function reconcile(rows: DedupRow[], account: string, existing: Set<string>): ReconcileOutput[] {
  const ordinalMap = new Map<string, number>();
  return rows.map((row) => {
    const key = fingerprintKey(account, row);
    const ordinal = ordinalMap.get(key) ?? 0;
    ordinalMap.set(key, ordinal + 1);
    const importId = computeImportId(account, row, ordinal);
    return { importId, isNew: !existing.has(importId) };
  });
}
