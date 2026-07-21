import { describe, expect, test } from "vitest";
import type { DedupRow, ExistingFingerprints } from "../dedup";
import { computeImportId, reconcile } from "../dedup";

function fingerprints(exactIds: Iterable<string> = []): ExistingFingerprints {
  return { exactIds: new Set(exactIds), weakCandidates: new Map(), syntheticFallback: new Map() };
}

describe("computeImportId()", () => {
  const row: DedupRow = {
    date: "2025-01-15",
    amount: -45.0,
    description: "Grocery Store",
    payee: "Whole Foods",
  };

  test("should return a string starting with 'csv:'", () => {
    const id = computeImportId("Assets:Checking", row, 0);
    expect(id).toMatch(/^csv:/);
  });

  test("should be deterministic for same inputs", () => {
    const id1 = computeImportId("Assets:Checking", row, 0);
    const id2 = computeImportId("Assets:Checking", row, 0);
    expect(id1).toBe(id2);
  });

  test("should differ for different ordinals", () => {
    const id0 = computeImportId("Assets:Checking", row, 0);
    const id1 = computeImportId("Assets:Checking", row, 1);
    expect(id0).not.toBe(id1);
  });

  test("should differ for different accounts", () => {
    const id1 = computeImportId("Assets:Checking", row, 0);
    const id2 = computeImportId("Assets:Savings", row, 0);
    expect(id1).not.toBe(id2);
  });

  test("should differ for different amounts", () => {
    const id1 = computeImportId("Assets:Checking", { ...row, amount: -45.0 }, 0);
    const id2 = computeImportId("Assets:Checking", { ...row, amount: -50.0 }, 0);
    expect(id1).not.toBe(id2);
  });

  test("should differ for different dates", () => {
    const id1 = computeImportId("Assets:Checking", { ...row, date: "2025-01-15" }, 0);
    const id2 = computeImportId("Assets:Checking", { ...row, date: "2025-01-16" }, 0);
    expect(id1).not.toBe(id2);
  });

  test("should be case-insensitive for description (normalized)", () => {
    const id1 = computeImportId("Assets:Checking", { ...row, description: "grocery store" }, 0);
    const id2 = computeImportId("Assets:Checking", { ...row, description: "GROCERY STORE" }, 0);
    expect(id1).toBe(id2);
  });

  test("should collapse whitespace in description for normalization", () => {
    const id1 = computeImportId("Assets:Checking", { ...row, description: "Grocery  Store" }, 0);
    const id2 = computeImportId("Assets:Checking", { ...row, description: "Grocery Store" }, 0);
    expect(id1).toBe(id2);
  });
});

describe("reconcile()", () => {
  const account = "Assets:Checking";

  const makeRow = (date: string, amount: number, description = "Coffee"): DedupRow => ({
    date,
    amount,
    description,
    payee: "Starbucks",
  });

  test("should mark all rows as new when existingIds is empty", () => {
    const rows = [makeRow("2025-01-15", -5), makeRow("2025-01-16", -5)];
    const result = reconcile(rows, account, fingerprints());
    expect(result.every((r) => r.isNew)).toBe(true);
  });

  test("should mark a row as not new when its import_id is already present", () => {
    const rows = [makeRow("2025-01-15", -5)];
    const existingId = computeImportId(account, rows[0], 0);
    const result = reconcile(rows, account, fingerprints([existingId]));
    expect(result[0].isNew).toBe(false);
  });

  test("should assign import_ids in the result", () => {
    const rows = [makeRow("2025-01-15", -5)];
    const result = reconcile(rows, account, fingerprints());
    expect(result[0].importId).toMatch(/^csv:/);
  });

  describe("re-import short-then-long overlapping", () => {
    test("should skip already-imported rows on re-import", () => {
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-16", -10);
      const row3 = makeRow("2025-01-17", -15);

      // First import: rows 1 and 2.
      const firstImportResult = reconcile([row1, row2], account, fingerprints());
      const importedIds = firstImportResult.filter((r) => r.isNew).map((r) => r.importId);

      // Second import: rows 1, 2, and 3 (longer export).
      const result = reconcile([row1, row2, row3], account, fingerprints(importedIds));

      expect(result[0].isNew).toBe(false); // row1 already imported
      expect(result[1].isNew).toBe(false); // row2 already imported
      expect(result[2].isNew).toBe(true); // row3 is new
    });

    test("should be order-independent: shuffled re-export still skips the overlap", () => {
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-16", -10);
      const row3 = makeRow("2025-01-17", -15);

      const first = reconcile([row1, row2], account, fingerprints());
      const importedIds = first.filter((r) => r.isNew).map((r) => r.importId);

      // Re-export in a different row order plus one new row.
      const result = reconcile([row3, row2, row1], account, fingerprints(importedIds));
      const byNew = result.filter((r) => r.isNew);
      expect(byNew).toHaveLength(1); // only row3 is new
    });
  });

  describe("genuine same-day duplicates via ordinal", () => {
    test("should keep both identical rows as distinct via ordinal", () => {
      // Two identical coffee purchases on the same day.
      const row1 = makeRow("2025-01-15", -5, "Coffee");
      const row2 = makeRow("2025-01-15", -5, "Coffee");

      const result = reconcile([row1, row2], account, fingerprints());

      // Both should be new, with different import_ids.
      expect(result[0].isNew).toBe(true);
      expect(result[1].isNew).toBe(true);
      expect(result[0].importId).not.toBe(result[1].importId);
    });

    test("should skip both identical rows when both are already in ledger (multiset)", () => {
      const row1 = makeRow("2025-01-15", -5, "Coffee");
      const row2 = makeRow("2025-01-15", -5, "Coffee");

      // First import: both rows.
      const firstResult = reconcile([row1, row2], account, fingerprints());
      const imported = firstResult.filter((r) => r.isNew).map((r) => r.importId);

      // Re-import same two rows.
      const result = reconcile([row1, row2], account, fingerprints(imported));
      expect(result[0].isNew).toBe(false);
      expect(result[1].isNew).toBe(false);
    });

    test("should import only the surplus copy when two of three are already in the ledger", () => {
      const row = makeRow("2025-01-15", -5, "Coffee");

      // Ledger already holds two copies: their import_ids are ordinals 0 and 1.
      const existingIds = [computeImportId(account, row, 0), computeImportId(account, row, 1)];

      // File has 3 copies -> ordinals 0,1,2; only ordinal 2 is new.
      const result = reconcile([row, row, row], account, fingerprints(existingIds));

      expect(result[0].isNew).toBe(false);
      expect(result[1].isNew).toBe(false);
      expect(result[2].isNew).toBe(true);
    });
  });

  describe("weak fallback (account+date+amount, no description)", () => {
    test("should drop a row as a possible duplicate when it weakly matches an existing description-less transaction", () => {
      const rows = [makeRow("2025-02-01", -15, "Aqua Springs")];
      const wKey = `${account}|2025-02-01|-15.00`;
      const location = { file: "/journal/2025/02.journal", startLine: 5 };
      const existing: ExistingFingerprints = {
        exactIds: new Set(),
        weakCandidates: new Map([[wKey, [location]]]),
        syntheticFallback: new Map(),
      };

      const result = reconcile(rows, account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(true);
      // Unambiguous: exactly one candidate shared this weak key, so it's a safe backfill target.
      expect(result[0].backfillTarget).toEqual(location);
    });

    test("should not offer a backfill target when multiple candidates share the weak key (ambiguous which one this row is)", () => {
      const rows = [makeRow("2025-02-01", -15, "Aqua Springs")];
      const wKey = `${account}|2025-02-01|-15.00`;
      const existing: ExistingFingerprints = {
        exactIds: new Set(),
        weakCandidates: new Map([
          [
            wKey,
            [
              { file: "/journal/2025/02.journal", startLine: 5 },
              { file: "/journal/2025/02.journal", startLine: 12 },
            ],
          ],
        ]),
        syntheticFallback: new Map(),
      };

      const result = reconcile(rows, account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(true);
      expect(result[0].backfillTarget).toBeUndefined();
    });

    test("should treat a synthetic fallback's weak key as zero-budget if absent from weakCandidates", () => {
      // Defensive case: a synthetic exact id maps to a weak key that was never registered in
      // weakCandidates. reconcile() must not throw or treat this as unlimited budget -- the
      // row still matches exactly (via exactIds), just without reserving anything.
      const row = makeRow("2025-02-01", -15, "Aqua Springs");
      const exactId = computeImportId(account, row, 0);
      const existing: ExistingFingerprints = {
        exactIds: new Set([exactId]),
        weakCandidates: new Map(),
        syntheticFallback: new Map([[exactId, { weakKey: "some-unregistered-key", location: null }]]),
      };

      const result = reconcile([row], account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(false);
    });

    test("should only weak-match up to the existing weak count, importing any surplus", () => {
      const rows = [
        makeRow("2025-02-01", -15, "Aqua Springs"),
        makeRow("2025-02-01", -15, "Aqua Springs"),
        makeRow("2025-02-01", -15, "Aqua Springs"),
      ];
      const wKey = `${account}|2025-02-01|-15.00`;
      const existing: ExistingFingerprints = {
        exactIds: new Set(),
        weakCandidates: new Map([
          [
            wKey,
            [
              { file: "/journal/2025/02.journal", startLine: 5 },
              { file: "/journal/2025/02.journal", startLine: 12 },
            ],
          ],
        ]),
        syntheticFallback: new Map(),
      };

      const result = reconcile(rows, account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(true);
      expect(result[1].isNew).toBe(false);
      expect(result[1].weakMatch).toBe(true);
      expect(result[2].isNew).toBe(true);
      expect(result[2].weakMatch).toBe(false);
    });

    test("should prefer an exact match over a weak match when both are available", () => {
      const row = makeRow("2025-02-01", -15, "Aqua Springs");
      const exactId = computeImportId(account, row, 0);
      const wKey = `${account}|2025-02-01|-15.00`;
      const location = { file: "/journal/2025/02.journal", startLine: 5 };
      const existing: ExistingFingerprints = {
        exactIds: new Set([exactId]),
        weakCandidates: new Map([[wKey, [location]]]),
        syntheticFallback: new Map([[exactId, { weakKey: wKey, location }]]),
      };

      const result = reconcile([row], account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(false); // matched exactly, not via the weak fallback
      expect(result[0].backfillTarget).toEqual(location); // still offered: exact match against a fallback entry
    });

    test("should share one consumption budget between exact and weak matches for the same key (regression: an entry matched exactly must not also be available for a different row's weak match)", () => {
      // loadExistingImportIds registers a weak candidate for every fallback entry even when
      // it ALSO has a usable exact fingerprint (see module header). Two existing entries with
      // matching descriptions register 2 exact ordinals AND 2 weak candidates for their shared key.
      // Three incoming rows share that same base fingerprint: the first two should match
      // exactly (consuming both existing entries), leaving the third with nothing left to
      // match against -- it must be genuinely new, not wrongly weak-matched against budget
      // that the first two rows already claimed via the exact path.
      const row = makeRow("2025-02-01", -15, "Aqua Springs");
      const wKey = `${account}|2025-02-01|-15.00`;
      const exactId0 = computeImportId(account, row, 0);
      const exactId1 = computeImportId(account, row, 1);
      const loc0 = { file: "/journal/2025/02.journal", startLine: 5 };
      const loc1 = { file: "/journal/2025/02.journal", startLine: 12 };
      const existing: ExistingFingerprints = {
        exactIds: new Set([exactId0, exactId1]),
        weakCandidates: new Map([[wKey, [loc0, loc1]]]),
        syntheticFallback: new Map([
          [exactId0, { weakKey: wKey, location: loc0 }],
          [exactId1, { weakKey: wKey, location: loc1 }],
        ]),
      };

      const result = reconcile([row, row, row], account, existing);
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(false); // exact
      expect(result[1].isNew).toBe(false);
      expect(result[1].weakMatch).toBe(false); // exact
      expect(result[2].isNew).toBe(true); // genuinely new -- budget already spent by rows 0,1
      expect(result[2].weakMatch).toBe(false);
    });

    test("should be independent of row order: a genuinely new row before its duplicates is still recognized as new", () => {
      // Same setup as above (2 existing entries, shared exact+weak budget), but the
      // genuinely-new row arrives FIRST this time. A greedy single-pass allocator would
      // wrongly weak-match this row (seeing budget before the two exact matches "claim" it);
      // the two-pass reserve-then-allocate design must reach the same answer regardless.
      const dup = makeRow("2025-02-01", -15, "Aqua Springs");
      const genuinelyNew = makeRow("2025-02-01", -15, "Bagel Shop");
      const wKey = `${account}|2025-02-01|-15.00`;
      const exactId0 = computeImportId(account, dup, 0);
      const exactId1 = computeImportId(account, dup, 1);
      const loc0 = { file: "/journal/2025/02.journal", startLine: 5 };
      const loc1 = { file: "/journal/2025/02.journal", startLine: 12 };
      const existing: ExistingFingerprints = {
        exactIds: new Set([exactId0, exactId1]),
        weakCandidates: new Map([[wKey, [loc0, loc1]]]),
        syntheticFallback: new Map([
          [exactId0, { weakKey: wKey, location: loc0 }],
          [exactId1, { weakKey: wKey, location: loc1 }],
        ]),
      };

      const result = reconcile([genuinelyNew, dup, dup], account, existing);
      expect(result[0].isNew).toBe(true); // Bagel Shop: genuinely new despite arriving first
      expect(result[0].weakMatch).toBe(false);
      expect(result[1].isNew).toBe(false); // exact
      expect(result[2].isNew).toBe(false); // exact
    });

    test("should not weak-match a different account, date, or amount", () => {
      const rows = [makeRow("2025-03-01", -20, "Aqua Springs")];
      const existing: ExistingFingerprints = {
        exactIds: new Set(),
        weakCandidates: new Map([
          [`${account}|2025-02-01|-15.00`, [{ file: "/journal/2025/02.journal", startLine: 5 }]],
        ]),
        syntheticFallback: new Map(),
      };

      const result = reconcile(rows, account, existing);
      expect(result[0].isNew).toBe(true);
      expect(result[0].weakMatch).toBe(false);
    });
  });

  describe("nativeId (e.g. OFX FITID)", () => {
    test("should use '<source>:<nativeId>' as the exact match key, bypassing the hash", () => {
      const row: DedupRow = { ...makeRow("2025-02-01", -15, "Aqua Springs"), nativeId: "BANK123" };
      const existing = fingerprints(["ofx:BANK123"]);

      const result = reconcile([row], account, existing, "ofx");
      expect(result[0].importId).toBe("ofx:BANK123");
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(false);
    });

    test("should fall through to the weak match when a nativeId misses the exact set (regression: FITID must not bypass untagged-history protection)", () => {
      // This is the scenario that motivated the weak fallback in the first place: a
      // transaction was hand-entered (or transcribed) before the importer existed, so it
      // has no import_id tag at all -- re-importing the same OFX statement computes a
      // "ofx:<FITID>" that was never written anywhere. If that miss were treated as "new"
      // without falling through to the weak check, the transaction would be duplicated --
      // exactly the bug this whole fallback exists to prevent.
      const row: DedupRow = { ...makeRow("2025-02-01", -15, "Aqua Springs"), nativeId: "BANK999-NEVER-SEEN" };
      const existing: ExistingFingerprints = {
        exactIds: new Set(), // no tagged transaction has this (or any) FITID
        // but an untagged one matches on date+amount
        weakCandidates: new Map([
          [`${account}|2025-02-01|-15.00`, [{ file: "/journal/2025/02.journal", startLine: 5 }]],
        ]),
        syntheticFallback: new Map(),
      };

      const result = reconcile([row], account, existing, "ofx");
      expect(result[0].isNew).toBe(false);
      expect(result[0].weakMatch).toBe(true);
    });

    test("should treat a nativeId row with no exact or weak match as genuinely new", () => {
      const row: DedupRow = { ...makeRow("2025-02-01", -15, "Aqua Springs"), nativeId: "BANK999" };
      const result = reconcile([row], account, fingerprints());
      expect(result[0].isNew).toBe(true);
      expect(result[0].weakMatch).toBe(false);
    });

    test("should not consume an ordinal slot in the hash-based fallback for nativeId rows", () => {
      // A nativeId row and a hash-based row sharing the same base fingerprint must not
      // interfere with each other's ordinal counting.
      const row1: DedupRow = { ...makeRow("2025-02-01", -15, "Aqua Springs"), nativeId: "BANK-A" };
      const row2 = makeRow("2025-02-01", -15, "Aqua Springs"); // no nativeId -- uses ordinal 0

      const result = reconcile([row1, row2], account, fingerprints(), "ofx");
      expect(result[0].importId).toBe("ofx:BANK-A");
      expect(result[1].importId).toMatch(/^ofx:(?!BANK-A)/);
      expect(result[0].isNew).toBe(true);
      expect(result[1].isNew).toBe(true);
    });
  });
});
