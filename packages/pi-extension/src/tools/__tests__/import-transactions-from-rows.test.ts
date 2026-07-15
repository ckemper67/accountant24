import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImportResult } from "../../import/import";

// Partial mock: stub the pipeline entry point, keep the real renderImportResult.
vi.mock("../../import/import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../import/import")>();
  return { ...actual, runRowImport: vi.fn() };
});

const { runRowImport } = await import("../../import/import");
const { importTransactionsFromRowsTool } = await import("../import-transactions-from-rows.js");

const mockRun = vi.mocked(runRowImport);

const RESULT: ImportResult = {
  parsed: 1,
  imported: 1,
  skipped: 0,
  encoding: "inline",
  numberFormat: "de",
  dateOrder: "dmy",
  dryRun: false,
  sample: ["2025-01-15 Rewe\n  Assets:Bank  -12.50 EUR"],
  transactions: [{ transactionText: "tx", fullFilePath: "/ws/ledger/2025/01.journal" }],
};

const run = (params: any) =>
  importTransactionsFromRowsTool.execute("test", params, undefined, undefined, undefined as any) as Promise<any>;

const text = (result: any): string => result.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");

beforeEach(() => mockRun.mockReset());

describe("importTransactionsFromRowsTool", () => {
  test("should run sequentially so ledger writes never interleave", () => {
    // Serialization relies on this instead of an in-code lock: pi runs any batch
    // containing a "sequential" tool one call at a time.
    expect(importTransactionsFromRowsTool.executionMode).toBe("sequential");
  });

  test("should forward account, rows, and options to runRowImport unchanged", async () => {
    mockRun.mockResolvedValue({ ...RESULT, dryRun: true, imported: 0 });
    const rows = [{ date: "15.01.2025", amount: "-12,50", payee: "Rewe", description: "Groceries" }];
    const params = {
      account: "Assets:Bank:Checking",
      rows,
      currency: "EUR",
      number_format: "de",
      date_format: "DMY",
      uncategorized_expense_account: "expenses:uncategorized",
      uncategorized_income_account: "income:uncategorized",
      dry_run: true,
    };
    await run(params);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      {
        account: "Assets:Bank:Checking",
        rows,
        currency: "EUR",
        number_format: "de",
        date_format: "DMY",
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
      account: "Assets:Bank:Checking",
      rows: [{ date: "15.01.2025", amount: "-12,50" }],
      uncategorized_expense_account: "expenses:uncategorized",
      uncategorized_income_account: "income:uncategorized",
    });
    expect(out.details).toBe(RESULT);
    expect(text(out)).toContain("Parsed: 1 rows | New: 1 | Skipped (already imported): 0");
    expect(text(out)).toContain("Written to: /ws/ledger/2025/01.journal");
  });
});
