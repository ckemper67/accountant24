import { describe, expect, test } from "vitest";
import type { DedupRow } from "../dedup";
import { computeImportId, reconcile } from "../dedup";

describe("computeImportId()", () => {
  const row: DedupRow = { date: "2025-01-15", amount: -45.0 };

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

  test("should be independent of import source: the same (account, date, amount, ordinal) always hashes the same", () => {
    // The whole point of dropping the source namespace: a statement imported once via CSV
    // and later re-imported via OFX for the same period must produce identical ids so the
    // overlap is recognized directly, with no separate cross-source handling.
    const csvRow: DedupRow = { date: "2025-01-15", amount: -45.0 };
    const ofxRow: DedupRow = { date: "2025-01-15", amount: -45.0 };
    expect(computeImportId("Assets:Checking", csvRow, 0)).toBe(computeImportId("Assets:Checking", ofxRow, 0));
  });
});

describe("reconcile()", () => {
  const account = "Assets:Checking";

  const makeRow = (date: string, amount: number): DedupRow => ({ date, amount });

  test("should mark all rows as new when existing is empty", () => {
    const rows = [makeRow("2025-01-15", -5), makeRow("2025-01-16", -5)];
    const result = reconcile(rows, account, new Set());
    expect(result.every((r) => r.isNew)).toBe(true);
  });

  test("should mark a row as not new when its import_id is already present", () => {
    const rows = [makeRow("2025-01-15", -5)];
    const existingId = computeImportId(account, rows[0], 0);
    const result = reconcile(rows, account, new Set([existingId]));
    expect(result[0].isNew).toBe(false);
  });

  test("should assign the computed import_id in the result", () => {
    const rows = [makeRow("2025-01-15", -5)];
    const result = reconcile(rows, account, new Set());
    expect(result[0].importId).toBe(computeImportId(account, rows[0], 0));
  });

  describe("re-import short-then-long overlapping", () => {
    test("should skip already-imported rows on re-import", () => {
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-16", -10);
      const row3 = makeRow("2025-01-17", -15);

      // First import: rows 1 and 2.
      const firstImportResult = reconcile([row1, row2], account, new Set());
      const importedIds = firstImportResult.filter((r) => r.isNew).map((r) => r.importId);

      // Second import: rows 1, 2, and 3 (longer export).
      const result = reconcile([row1, row2, row3], account, new Set(importedIds));

      expect(result[0].isNew).toBe(false); // row1 already imported
      expect(result[1].isNew).toBe(false); // row2 already imported
      expect(result[2].isNew).toBe(true); // row3 is new
    });

    test("should be order-independent: shuffled re-export still skips the overlap", () => {
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-16", -10);
      const row3 = makeRow("2025-01-17", -15);

      const first = reconcile([row1, row2], account, new Set());
      const importedIds = first.filter((r) => r.isNew).map((r) => r.importId);

      // Re-export in a different row order plus one new row.
      const result = reconcile([row3, row2, row1], account, new Set(importedIds));
      const byNew = result.filter((r) => r.isNew);
      expect(byNew).toHaveLength(1); // only row3 is new
    });
  });

  describe("genuine same-day duplicates via ordinal", () => {
    test("should keep both identical rows as distinct via ordinal", () => {
      // Two identical coffee purchases on the same day.
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-15", -5);

      const result = reconcile([row1, row2], account, new Set());

      // Both should be new, with different import_ids.
      expect(result[0].isNew).toBe(true);
      expect(result[1].isNew).toBe(true);
      expect(result[0].importId).not.toBe(result[1].importId);
    });

    test("should skip both identical rows when both are already in ledger (multiset)", () => {
      const row1 = makeRow("2025-01-15", -5);
      const row2 = makeRow("2025-01-15", -5);

      // First import: both rows.
      const firstResult = reconcile([row1, row2], account, new Set());
      const imported = firstResult.filter((r) => r.isNew).map((r) => r.importId);

      // Re-import same two rows.
      const result = reconcile([row1, row2], account, new Set(imported));
      expect(result[0].isNew).toBe(false);
      expect(result[1].isNew).toBe(false);
    });

    test("should import only the surplus copy when two of three are already in the ledger", () => {
      const row = makeRow("2025-01-15", -5);

      // Ledger already holds two copies: their import_ids are ordinals 0 and 1.
      const existingIds = new Set([computeImportId(account, row, 0), computeImportId(account, row, 1)]);

      // File has 3 copies -> ordinals 0,1,2; only ordinal 2 is new.
      const result = reconcile([row, row, row], account, existingIds);

      expect(result[0].isNew).toBe(false);
      expect(result[1].isNew).toBe(false);
      expect(result[2].isNew).toBe(true);
    });
  });

  test("should not match a different account", () => {
    const row = makeRow("2025-01-15", -5);
    const existingId = computeImportId(account, row, 0);
    const result = reconcile([row], "Assets:Savings", new Set([existingId]));
    expect(result[0].isNew).toBe(true);
  });

  test("should not match a different date", () => {
    const row = makeRow("2025-01-15", -5);
    const existingId = computeImportId(account, { ...row, date: "2025-01-16" }, 0);
    const result = reconcile([row], account, new Set([existingId]));
    expect(result[0].isNew).toBe(true);
  });

  test("should not match a different amount", () => {
    const row = makeRow("2025-01-15", -5);
    const existingId = computeImportId(account, { ...row, amount: -6 }, 0);
    const result = reconcile([row], account, new Set([existingId]));
    expect(result[0].isNew).toBe(true);
  });

  test("should round amounts to 2 decimal places before matching", () => {
    // A row parsed with float noise (e.g. 0.1 + 0.2 style artifacts) must still match an
    // existing id computed from the same nominal 2-decimal amount.
    const row = makeRow("2025-01-15", -5.000000001);
    const existingId = computeImportId(account, makeRow("2025-01-15", -5), 0);
    const result = reconcile([row], account, new Set([existingId]));
    expect(result[0].isNew).toBe(false);
  });
});
