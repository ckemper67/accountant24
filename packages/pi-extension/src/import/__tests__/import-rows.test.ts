import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../spawn";

vi.mock("../../spawn");

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-import-rows-"));
const LEDGER = join(BASE, "ledger");

vi.mock("../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

function makeMockProc(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

const { runRowImport } = await import("../import.js");

const ACCOUNT = "Assets:Bank:Checking";

// Rows as an agent would transcribe them from a PDF: raw date/amount strings.
const US_ROWS = [
  { date: "2025-01-15", amount: "-45.00", payee: "Whole Foods", description: "Groceries" },
  { date: "2025-01-16", amount: "2000.00", payee: "ACME Corp", description: "January salary" },
  { date: "2025-01-20", amount: "-15.50", payee: "Starbucks", description: "Coffee" },
];

const BUCKETS = {
  uncategorized_expense_account: "expenses:uncategorized",
  uncategorized_income_account: "income:uncategorized",
};
const DECLARED_ACCOUNTS = [ACCOUNT, "expenses:uncategorized", "income:uncategorized"].join("\n");

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, "main.journal"), "");
  // hledger print returns no existing transactions; accounts returns the chart; check passes.
  vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
    if (cmd[1] === "print") return makeMockProc(0, "[]");
    if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
    return makeMockProc(0);
  });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe("runRowImport() dry_run", () => {
  test("should report parsed rows without writing", async () => {
    const result = await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS, dry_run: true });
    expect(result.dryRun).toBe(true);
    expect(result.parsed).toBe(3);
    expect(result.imported).toBe(0);
    expect(result.encoding).toBe("inline");
    expect(result.sample.some((s) => s.includes("Whole Foods"))).toBe(true);
  });
});

describe("runRowImport() real import", () => {
  test("should write transactions to the monthly journal file", async () => {
    const result = await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });
    expect(result.imported).toBe(3);
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("Whole Foods");
    expect(content).toContain("ACME Corp");
    expect(content).toContain("Starbucks");
  });

  test("should tag each transaction with an import_id", async () => {
    await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    const ids = content.match(/; import_id: /g);
    expect(ids).toHaveLength(3);
  });

  test("should write provenance tags and balance to Uncategorized by sign", async () => {
    await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("; original_payee_name: Whole Foods");
    expect(content).toContain("; original_description: Groceries");
    expect(content).toContain("expenses:uncategorized"); // outflow
    expect(content).toContain("income:uncategorized"); // inflow (salary)
  });
});

describe("runRowImport() locale parsing", () => {
  test("should parse German amounts and dotted dates with explicit overrides", async () => {
    const deRows = [{ date: "15.01.2025", amount: "-1.234,56", payee: "Edeka", description: "Einkauf" }];
    const result = await runRowImport({
      account: ACCOUNT,
      rows: deRows,
      currency: "EUR",
      number_format: "de",
      date_format: "DMY",
      ...BUCKETS,
    });
    expect(result.imported).toBe(1);
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    // 1.234,56 EUR outflow -> -1234.56 on the asset account.
    expect(content).toContain("-1234.56 EUR");
    expect(content).toContain("2025-01-15");
  });
});

describe("runRowImport() deduplication", () => {
  test("should skip rows already present on re-import", async () => {
    await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    const ids = [...content.matchAll(/; import_id: (\S+)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(3);

    const mockTxns = ids.map((id) => ({
      ttags: [["import_id", id]],
      tdate: "2025-01-15",
      tdescription: "x",
      tpostings: [{ paccount: ACCOUNT, pamount: [] }],
    }));
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      return makeMockProc(0);
    });

    const second = await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });

  test("should still recognize a re-import even when the transcribed description drifted between runs", async () => {
    // LLM transcription of the same PDF statement is not guaranteed byte-identical between
    // two calls (wording, whitespace, OCR variance). Since dedup is keyed on (account, date,
    // amount) only -- never description -- this drift can't cause a false "new" match.
    const mockTxns = [
      {
        ttags: [],
        tdate: "2025-01-15",
        tdescription: "Whole Foods",
        tpostings: [{ paccount: ACCOUNT, pamount: [{ aquantity: { decimalMantissa: -4500, decimalPlaces: 2 } }] }],
      },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    // US_ROWS[0] is the same Whole Foods/-45.00/2025-01-15 transaction; the existing
    // entry's description text ("Whole Foods") need not match this row's ("Groceries").
    const result = await runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD", ...BUCKETS });

    expect(result.parsed).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(2);
  });
});

describe("runRowImport() error handling", () => {
  test("should throw a clear error when a row has no currency and none is provided", async () => {
    const rows = [{ date: "2025-01-15", amount: "-45.00", payee: "Whole Foods" }];
    await expect(runRowImport({ account: ACCOUNT, rows })).rejects.toThrow(/no currency/);
  });

  test("should fail loudly when the needed catch-all account is not provided", async () => {
    await expect(runRowImport({ account: ACCOUNT, rows: US_ROWS, currency: "USD" })).rejects.toThrow(
      /uncategorized_expense_account/,
    );
  });

  test("should fail loudly when a supplied catch-all account is not declared", async () => {
    await expect(
      runRowImport({
        account: ACCOUNT,
        rows: US_ROWS,
        currency: "USD",
        uncategorized_expense_account: "ausgaben:nicht-kategorisiert",
        uncategorized_income_account: "income:uncategorized",
      }),
    ).rejects.toThrow(/not declared/);
  });
});
