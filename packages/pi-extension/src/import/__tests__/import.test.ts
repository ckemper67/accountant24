import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../spawn";

vi.mock("../../spawn");

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-import-"));
const LEDGER = join(BASE, "ledger");
const FILES = join(BASE, "files");

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

const { runImport, renderImportResult } = await import("../import.js");
type ImportResult = Awaited<ReturnType<typeof runImport>>;

// ── Simple CSV fixture ───────────────────────────────────────────────

const SIMPLE_CSV = [
  "Date,Amount,Payee,Description",
  "2025-01-15,-45.00,Whole Foods,Groceries",
  "2025-01-16,2000.00,ACME Corp,January salary",
  "2025-01-20,-15.50,Starbucks,Coffee",
].join("\n");

const ACCOUNT = "Assets:Bank:Checking";
const BUCKETS = {
  uncategorized_expense_account: "expenses:uncategorized",
  uncategorized_income_account: "income:uncategorized",
};
const DECLARED_ACCOUNTS = [ACCOUNT, "expenses:uncategorized", "income:uncategorized"].join("\n");

function setupWorkspace(): void {
  mkdirSync(LEDGER, { recursive: true });
  mkdirSync(FILES, { recursive: true });
  writeFileSync(join(LEDGER, "main.journal"), "");
  writeFileSync(join(FILES, "statement.csv"), SIMPLE_CSV);
}

function teardownWorkspace(): void {
  rmSync(BASE, { recursive: true, force: true });
}

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  rmSync(FILES, { recursive: true, force: true });
  setupWorkspace();
  // Mock hledger: print returns empty JSON array (no existing transactions),
  // accounts returns the declared chart, check passes.
  vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
    if (cmd[1] === "print") return makeMockProc(0, "[]");
    if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
    return makeMockProc(0); // hledger check passes
  });
});

afterEach(() => {
  teardownWorkspace();
});

// ── Dry run tests ────────────────────────────────────────────────────

describe("runImport() dry_run", () => {
  test("should return parsed count without writing any files", async () => {
    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
      dry_run: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.parsed).toBe(3);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);

    // No monthly journal files should be written.
    expect(existsSync(join(LEDGER, "2025"))).toBe(false);
  });

  test("should return encoding, numberFormat, and dateOrder in dry_run", async () => {
    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
      dry_run: true,
    });

    expect(result.encoding).toBe("utf-8");
    expect(result.numberFormat).toBe("us");
    expect(typeof result.dateOrder).toBe("string");
  });

  test("should return a sample of formatted entries in dry_run", async () => {
    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
      dry_run: true,
    });

    expect(result.sample.length).toBeGreaterThan(0);
    expect(result.sample.length).toBeLessThanOrEqual(5);
    // Sample should contain the payee.
    expect(result.sample.some((s) => s.includes("Whole Foods"))).toBe(true);
  });
});

// ── Real import tests ────────────────────────────────────────────────

describe("runImport() real import", () => {
  test("should write transactions to monthly journal files", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(existsSync(join(LEDGER, "2025", "01.journal"))).toBe(true);
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("Whole Foods");
    expect(content).toContain("ACME Corp");
    expect(content).toContain("Starbucks");
  });

  test("should return imported count equal to new rows", async () => {
    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.parsed).toBe(3);
  });

  test("should write an import_id tag for each transaction", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    const importIdMatches = content.match(/; import_id: /g);
    expect(importIdMatches).toHaveLength(3);
  });

  test("should write original_payee_name tag when payee is present", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("; original_payee_name: Whole Foods");
  });

  test("should write original_description tag when description is present", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("; original_description: Groceries");
  });

  test("should balance outflows to the supplied expense catch-all", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("expenses:uncategorized");
  });

  test("should balance inflows to the supplied income catch-all", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("income:uncategorized");
  });

  test("should include main.journal include directive for new monthly file", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    const main = readFileSync(join(LEDGER, "main.journal"), "utf-8");
    expect(main).toContain("include 2025/01.journal");
  });
});

// ── Deduplication tests ──────────────────────────────────────────────

describe("runImport() deduplication", () => {
  test("should skip all rows on re-import of the same file", async () => {
    // First import.
    const first = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });
    expect(first.imported).toBe(3);

    // Build existing import_ids from what was written.
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    const importIds = [...content.matchAll(/; import_id: (\S+)/g)].map((m) => m[1]);
    expect(importIds).toHaveLength(3);

    // Mock hledger print to return the existing import_ids.
    const mockTxns = importIds.map((id, i) => ({
      ttags: [["import_id", id]],
      tdate: "2025-01-15",
      tdescription: `tx${i}`,
      tpostings: [{ paccount: ACCOUNT, pamount: [] }],
    }));
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      return makeMockProc(0);
    });

    // Second import with same file.
    const second = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.parsed).toBe(3);
  });
});

describe("runImport() existing-fingerprint lookup failure modes", () => {
  test("should treat every row as new when hledger print fails (e.g. no ledger yet)", async () => {
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(1, "", "hledger: main.journal: openFile: does not exist");
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
  });

  test("should treat every row as new when hledger print returns invalid JSON", async () => {
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, "not valid json");
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
  });

  test("should treat a transaction with no ttags field at all as untagged", async () => {
    const mockTxns = [
      // No ttags key, not even an empty array.
      { tdate: "2025-01-15", tdescription: "Groceries", tpostings: [{ paccount: ACCOUNT, pamount: [] }] },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    // No amount is ever resolved (pamount is empty), so this existing transaction
    // contributes nothing to dedup; all three CSV rows import as new.
    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.parsed).toBe(3);
    expect(result.imported).toBe(3);
  });

  test("should skip an existing transaction with a missing/non-string tdate", async () => {
    const mockTxns = [
      {
        ttags: [],
        tdate: 12345, // not a string -- can't be used for dedup, entry is skipped entirely
        tdescription: "Whole Foods",
        tpostings: [{ paccount: ACCOUNT, pamount: [{ aquantity: { decimalMantissa: -4500, decimalPlaces: 2 } }] }],
      },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    // Skipped entirely, so it never dedups against the CSV's matching row either.
    expect(result.parsed).toBe(3);
    expect(result.imported).toBe(3);
  });

  test("should ignore postings on a different account and postings with a malformed amount", async () => {
    const mockTxns = [
      {
        ttags: [],
        tdate: "2025-01-15",
        tdescription: "Whole Foods",
        tpostings: [
          // A posting on an unrelated account -- must not be mistaken for the target account.
          { paccount: "Expenses:Other", pamount: [{ aquantity: { decimalMantissa: -4500, decimalPlaces: 2 } }] },
          // A posting on the target account, but with a non-numeric amount -- unusable.
          { paccount: ACCOUNT, pamount: [{ aquantity: { decimalMantissa: "not-a-number", decimalPlaces: 2 } }] },
        ],
      },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    // Neither posting contributes a usable fingerprint, so all three CSV rows are new.
    expect(result.parsed).toBe(3);
    expect(result.imported).toBe(3);
  });

  test("should reconstruct an amount stored at higher decimal precision (e.g. 3 places) without floating-point drift", async () => {
    const mockTxns = [
      {
        ttags: [],
        tdate: "2025-01-15",
        tdescription: "Whole Foods",
        // 45000 * 10^-3 = 45.000 -- must round-trip to "45.00" exactly, matching a CSV
        // row of -45.00 rather than drifting via a naive float division.
        tpostings: [{ paccount: ACCOUNT, pamount: [{ aquantity: { decimalMantissa: -45000, decimalPlaces: 3 } }] }],
      },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.parsed).toBe(3);
    expect(result.skipped).toBe(1); // the Whole Foods row matches the existing entry
    expect(result.imported).toBe(2);
  });
});

// ── Deduplication fallback tests (untagged pre-existing transactions) ─

describe("runImport() deduplication fallback for untagged transactions", () => {
  test("should skip a row matching a pre-existing transaction that has no import_id tag", async () => {
    // Simulate a transaction entered before the import tool existed (or via manual/OFX
    // transcription): no import_id tag at all. Matching is purely (account, date, amount)
    // now, so no description recovery is needed.
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

    const result = await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    // The Whole Foods row matches the untagged existing transaction and is skipped; the
    // other two rows (salary, coffee) are genuinely new.
    expect(result.parsed).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(2);
  });

  test("should not collapse distinct same-day repeats into one skip (ordinal-aware fallback)", async () => {
    // Two untagged existing "Aqua Springs" transactions on the same day/amount -- these are
    // two separate real charges, not one duplicate counted twice.
    const primoPosting = {
      paccount: ACCOUNT,
      pamount: [{ aquantity: { decimalMantissa: -1500, decimalPlaces: 2 } }],
    };
    const mockTxns = [
      { ttags: [], tdate: "2025-02-01", tdescription: "Aqua Springs", tpostings: [primoPosting] },
      { ttags: [], tdate: "2025-02-01", tdescription: "Aqua Springs", tpostings: [primoPosting] },
    ];
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, JSON.stringify(mockTxns));
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(0);
    });

    // A statement with THREE same-day Aqua Springs charges: two are re-imports of the
    // existing pair (skipped), the third is a genuinely new charge (imported).
    const csv = [
      "Date,Amount,Payee,Description",
      "2025-02-01,-15.00,Aqua Springs,Aqua Springs",
      "2025-02-01,-15.00,Aqua Springs,Aqua Springs",
      "2025-02-01,-15.00,Aqua Springs,Aqua Springs",
    ].join("\n");
    writeFileSync(join(FILES, "primo.csv"), csv);

    const result = await runImport({
      file_path: "files/primo.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });

    expect(result.parsed).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.imported).toBe(1);
  });
});

// ── Encoding tests ───────────────────────────────────────────────────

describe("runImport() encoding", () => {
  test("should decode windows-1252 CSV with German umlauts", async () => {
    // Write a CSV with latin-1 bytes for German umlauts.
    // ae=0xE4, oe=0xF6, ue=0xFC, sz=0xDF
    const header = "Date,Amount,Payee\n";
    const row = "2025-01-15,-45.00,M";
    // Append umlaut bytes (ue=0xFC, ller).
    const latinBuf = Buffer.concat([
      Buffer.from(header + row, "latin1"),
      Buffer.from([0xfc]),
      Buffer.from("ller\n", "latin1"),
    ]);
    writeFileSync(join(FILES, "german.csv"), latinBuf);

    const result = await runImport({
      file_path: "files/german.csv",
      account: ACCOUNT,
      currency: "EUR",
      ...BUCKETS,
      dry_run: true,
    });

    expect(result.encoding).toBe("windows-1252");
    expect(result.parsed).toBe(1);
    // The payee should include the umlaut.
    expect(result.sample[0]).toContain("ü");
  });
});

// ── Error handling ───────────────────────────────────────────────────

describe("runImport() error handling", () => {
  test("should throw when file does not exist", async () => {
    await expect(
      runImport({
        file_path: "files/nonexistent.csv",
        account: ACCOUNT,
        currency: "USD",
        ...BUCKETS,
      }),
    ).rejects.toThrow(/Cannot read file/);
  });

  test("should throw when hledger check fails", async () => {
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, "[]");
      if (cmd[1] === "accounts") return makeMockProc(0, DECLARED_ACCOUNTS);
      return makeMockProc(1, "", "account not declared");
    });

    await expect(
      runImport({
        file_path: "files/statement.csv",
        account: ACCOUNT,
        currency: "USD",
        ...BUCKETS,
        date_format: "MDY",
      }),
    ).rejects.toThrow(/account not declared/);
  });

  test("should fail loudly when a needed catch-all account is not provided", async () => {
    await expect(runImport({ file_path: "files/statement.csv", account: ACCOUNT, currency: "USD" })).rejects.toThrow(
      /uncategorized_expense_account/,
    );
  });

  test("should fail loudly when a supplied catch-all account is not declared", async () => {
    await expect(
      runImport({
        file_path: "files/statement.csv",
        account: ACCOUNT,
        currency: "USD",
        uncategorized_expense_account: "expenses:does-not-exist",
        uncategorized_income_account: "income:uncategorized",
      }),
    ).rejects.toThrow(/not declared/);
  });

  test("should return 0 imported and 0 skipped for empty CSV", async () => {
    writeFileSync(join(FILES, "empty.csv"), "");
    const result = await runImport({
      file_path: "files/empty.csv",
      account: ACCOUNT,
      currency: "USD",
      ...BUCKETS,
    });
    expect(result.parsed).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ── renderImportResult() ─────────────────────────────────────────────

describe("renderImportResult()", () => {
  const full: ImportResult = {
    parsed: 3,
    imported: 2,
    skipped: 1,
    encoding: "windows-1252",
    numberFormat: "de",
    dateOrder: "dmy",
    dryRun: false,
    sample: ["2025-01-15 Whole Foods\n  Assets:Bank  -45.00 EUR"],
    detection: {
      preambleRows: 2,
      preamble: ["Account statement", "Period: Jan 2025"],
      header: ["Datum", "Betrag", "Empfaenger"],
      sampleRow: { date: "15.01.2025", amount: "-45,00", payee: "Whole Foods", description: "Groceries", currency: "" },
    },
    balancing: [
      { direction: "expense", account: "expenses:uncategorized", declared: true },
      { direction: "income", account: "income:uncategorized", declared: true },
    ],
    transactions: [{ transactionText: "tx", fullFilePath: "/ws/ledger/2025/01.journal" }],
    diffs: [],
  };

  test("should summarize parsed, new, and skipped counts", () => {
    const text = renderImportResult(full);
    expect(text).toContain("Parsed: 3 rows | New: 2 | Skipped (already imported): 1");
  });

  test("should report encoding, number format, and date order", () => {
    expect(renderImportResult(full)).toContain("Encoding: windows-1252 | Number format: de | Date order: dmy");
  });

  test("should list the resolved balancing accounts", () => {
    const text = renderImportResult(full);
    expect(text).toContain(
      "Balancing (uncategorized): expense -> expenses:uncategorized | income -> income:uncategorized",
    );
  });

  test("should show CSV header detection with preamble and the first mapped row", () => {
    const text = renderImportResult(full);
    expect(text).toContain("Header: detected on line 3 (skipped 2 preamble line(s)).");
    expect(text).toContain("Preamble: Account statement / Period: Jan 2025");
    expect(text).toContain("Columns: Datum | Betrag | Empfaenger");
    expect(text).toContain('First row -> date="15.01.2025" amount="-45,00" payee="Whole Foods"');
  });

  test("should list the sample transactions", () => {
    const text = renderImportResult(full);
    expect(text).toContain("Sample (first 1 new transactions):");
    expect(text).toContain("Whole Foods");
  });

  test("should report the files written when not a dry run", () => {
    expect(renderImportResult(full)).toContain("Written to: /ws/ledger/2025/01.journal");
  });

  test("should mark a dry run and omit the written-to line", () => {
    const dry: ImportResult = { ...full, dryRun: true, imported: 0, transactions: undefined };
    const text = renderImportResult(dry);
    expect(text).toContain("DRY RUN -- no transactions written.");
    expect(text).not.toContain("Written to:");
  });

  test("should omit optional sections when absent (no balancing, detection, sample, or writes)", () => {
    const minimal: ImportResult = {
      parsed: 0,
      imported: 0,
      skipped: 0,
      encoding: "inline",
      numberFormat: "us",
      dateOrder: "mdy",
      dryRun: false,
      sample: [],
    };
    const text = renderImportResult(minimal);
    expect(text).not.toContain("Balancing");
    expect(text).not.toContain("Header:");
    expect(text).not.toContain("Sample");
    expect(text).not.toContain("Written to:");
    expect(text).toContain("Parsed: 0 rows");
  });

  test("should render detection without preamble lines or a sample row", () => {
    const noPreamble: ImportResult = {
      ...full,
      detection: { preambleRows: 0, preamble: [], header: ["Date", "Amount"], sampleRow: undefined },
    };
    const text = renderImportResult(noPreamble);
    expect(text).toContain("Header: detected on line 1 (skipped 0 preamble line(s)).");
    expect(text).not.toContain("Preamble:");
    expect(text).not.toContain("First row ->");
  });
});
