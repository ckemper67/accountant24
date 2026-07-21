import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImportResult } from "../../import/import";

// Partial mock: stub the pipeline entry point, keep the real renderImportResult so the
// handler's text output is exercised end to end.
vi.mock("../../import/import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../import/import")>();
  return { ...actual, runImport: vi.fn() };
});

const { runImport } = await import("../../import/import");
const { importTransactionsTool } = await import("../import-transactions.js");

const mockRun = vi.mocked(runImport);

const RESULT: ImportResult = {
  parsed: 2,
  imported: 2,
  skipped: 0,
  encoding: "utf-8",
  numberFormat: "us",
  dateOrder: "mdy",
  dryRun: false,
  sample: [],
  possibleDuplicates: [],
  backfilled: [],
  transactions: [{ transactionText: "tx", fullFilePath: "/ws/ledger/2025/01.journal" }],
};

const run = (params: any) =>
  importTransactionsTool.execute("test", params, undefined, undefined, undefined as any) as Promise<any>;

const text = (result: any): string => result.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");

beforeEach(() => mockRun.mockReset());

describe("importTransactionsTool", () => {
  test("should run sequentially so ledger writes never interleave", () => {
    // Serialization relies on this instead of an in-code lock: pi runs any batch
    // containing a "sequential" tool one call at a time.
    expect(importTransactionsTool.executionMode).toBe("sequential");
  });

  test("should forward every parameter to runImport unchanged", async () => {
    mockRun.mockResolvedValue({ ...RESULT, dryRun: true, imported: 0 });
    const params = {
      file_path: "files/2025/01/statement.csv",
      account: "Assets:Bank:Checking",
      currency: "EUR",
      number_format: "de",
      date_format: "DMY",
      column_map: { date: "Datum", amount: "Betrag" },
      skip_rows: 3,
      uncategorized_expense_account: "expenses:uncategorized",
      uncategorized_income_account: "income:uncategorized",
      dry_run: true,
    };
    await run(params);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      {
        file_path: "files/2025/01/statement.csv",
        account: "Assets:Bank:Checking",
        currency: "EUR",
        number_format: "de",
        date_format: "DMY",
        column_map: { date: "Datum", amount: "Betrag" },
        skip_rows: 3,
        uncategorized_expense_account: "expenses:uncategorized",
        uncategorized_income_account: "income:uncategorized",
        dry_run: true,
      },
      undefined,
    );
  });

  test("should return the rendered result as text content and the raw result as details", async () => {
    mockRun.mockResolvedValue(RESULT);
    const out = await run({
      file_path: "files/s.csv",
      account: "Assets:Bank:Checking",
      uncategorized_expense_account: "expenses:uncategorized",
      uncategorized_income_account: "income:uncategorized",
    });
    expect(out.details).toBe(RESULT);
    expect(text(out)).toContain("Parsed: 2 rows | New: 2 | Skipped (already imported): 0");
    expect(text(out)).toContain("Written to: /ws/ledger/2025/01.journal");
  });
});
