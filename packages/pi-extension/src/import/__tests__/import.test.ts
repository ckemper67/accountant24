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
  ACCOUNTANT24_HOME: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

function makeMockProc(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

const { runImport } = await import("../import.js");

// ── Simple CSV fixture ───────────────────────────────────────────────

const SIMPLE_CSV = [
  "Date,Amount,Payee,Description",
  "2025-01-15,-45.00,Whole Foods,Groceries",
  "2025-01-16,2000.00,ACME Corp,January salary",
  "2025-01-20,-15.50,Starbucks,Coffee",
].join("\n");

const ACCOUNT = "Assets:Bank:Checking";

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
  // check passes.
  vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
    if (cmd[1] === "print") return makeMockProc(0, "[]");
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
    });

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.parsed).toBe(3);
  });

  test("should write import_id tag for each transaction", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    // Each transaction should have an import_id tag.
    const importIdMatches = content.match(/; import_id: csv:/g);
    expect(importIdMatches).toHaveLength(3);
  });

  test("should write original_payee_name tag when payee is present", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("; original_payee_name: Whole Foods");
  });

  test("should write original_description tag when description is present", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("; original_description: Groceries");
  });

  test("should balance outflows to Expenses:Uncategorized", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("Expenses:Uncategorized");
  });

  test("should balance inflows to Income:Uncategorized", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
    });

    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    expect(content).toContain("Income:Uncategorized");
  });

  test("should include main.journal include directive for new monthly file", async () => {
    await runImport({
      file_path: "files/statement.csv",
      account: ACCOUNT,
      currency: "USD",
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
    });
    expect(first.imported).toBe(3);

    // Build existing import_ids from what was written.
    const content = readFileSync(join(LEDGER, "2025", "01.journal"), "utf-8");
    const importIds = [...content.matchAll(/; import_id: (csv:[^\s\n]+)/g)].map((m) => m[1]);
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
    });

    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.parsed).toBe(3);
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
      }),
    ).rejects.toThrow(/Cannot read file/);
  });

  test("should throw when hledger check fails", async () => {
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd[1] === "print") return makeMockProc(0, "[]");
      return makeMockProc(1, "", "account not declared");
    });

    await expect(
      runImport({
        file_path: "files/statement.csv",
        account: ACCOUNT,
        currency: "USD",
        date_format: "MDY",
      }),
    ).rejects.toThrow(/account not declared/);
  });

  test("should return 0 imported and 0 skipped for empty CSV", async () => {
    writeFileSync(join(FILES, "empty.csv"), "");
    const result = await runImport({
      file_path: "files/empty.csv",
      account: ACCOUNT,
      currency: "USD",
    });
    expect(result.parsed).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
