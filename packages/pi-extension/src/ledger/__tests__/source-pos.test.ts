import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-sourcepos-"));
const LEDGER = join(BASE, "ledger");

vi.mock("../../config.js", () => ({
  ACCOUNTANT24_HOME: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

const { parseSourcePos, resolveSourceFile, transactionEndLine } = await import("../source-pos.js");

describe("parseSourcePos()", () => {
  test("should return the file and 1-based header line from tsourcepos", () => {
    const file = join(LEDGER, "2026/03.journal");
    const pos = { sourceName: file, sourceLine: 7, sourceColumn: 1 };

    expect(parseSourcePos([pos, pos])).toEqual({ file, startLine: 7 });
  });

  test("should take the start (first) position for the header line", () => {
    const file = join(LEDGER, "2026/03.journal");
    const start = { sourceName: file, sourceLine: 4, sourceColumn: 1 };
    const end = { sourceName: file, sourceLine: 8, sourceColumn: 1 };

    expect(parseSourcePos([start, end])?.startLine).toBe(4);
  });

  test("should resolve a workspace-relative source name against the home dir", () => {
    const rel = "ledger/2026/03.journal";
    expect(parseSourcePos([{ sourceName: rel, sourceLine: 1, sourceColumn: 1 }])).toEqual({
      file: join(BASE, rel),
      startLine: 1,
    });
  });

  test("should return null when tsourcepos is not an array", () => {
    expect(parseSourcePos(null)).toBeNull();
    expect(parseSourcePos({})).toBeNull();
  });

  test("should return null when tsourcepos is empty", () => {
    expect(parseSourcePos([])).toBeNull();
  });

  test("should return null when sourceLine is missing or not a number", () => {
    const file = join(LEDGER, "2026/03.journal");
    expect(parseSourcePos([{ sourceName: file, sourceColumn: 1 }])).toBeNull();
    expect(parseSourcePos([{ sourceName: file, sourceLine: "7", sourceColumn: 1 }])).toBeNull();
  });

  test("should return null when the source file resolves outside the ledger dir", () => {
    expect(parseSourcePos([{ sourceName: "/etc/passwd", sourceLine: 1, sourceColumn: 1 }])).toBeNull();
  });
});

describe("resolveSourceFile()", () => {
  test("should keep an absolute path inside the ledger dir", () => {
    const file = join(LEDGER, "2026/03.journal");
    expect(resolveSourceFile(file)).toBe(file);
  });

  test("should resolve a relative path against the home dir", () => {
    expect(resolveSourceFile("ledger/2026/03.journal")).toBe(join(BASE, "ledger/2026/03.journal"));
  });

  test("should reject a path that escapes the ledger dir", () => {
    expect(resolveSourceFile(join(BASE, "secrets.txt"))).toBeNull();
    expect(resolveSourceFile("/etc/passwd")).toBeNull();
  });
});

describe("transactionEndLine()", () => {
  test("should return the last indented posting line of the transaction", () => {
    const lines = [
      "2026-03-15 * Whole Foods | Groceries", // 1 (header)
      "    Expenses:Food:Groceries   45.00 USD", // 2
      "    Assets:Checking          -45.00 USD", // 3
      "", // 4 blank
      "2026-03-16 * Shell", // 5
    ];
    expect(transactionEndLine(lines, 1)).toBe(3);
  });

  test("should include indented comment lines within the transaction", () => {
    const lines = [
      "2026-03-15 * Whole Foods", // 1
      "    ; note: weekly shop", // 2
      "    Expenses:Food   45.00 USD", // 3
      "    Assets:Checking -45.00 USD", // 4
    ];
    expect(transactionEndLine(lines, 1)).toBe(4);
  });

  test("should stop at a non-indented line even without a blank separator", () => {
    const lines = [
      "2026-03-15 * A", // 1
      "    Expenses:X  1 USD", // 2
      "    Assets:Y   -1 USD", // 3
      "2026-03-16 * B", // 4 (non-indented, next txn)
    ];
    expect(transactionEndLine(lines, 1)).toBe(3);
  });

  test("should return the header line itself when no postings follow", () => {
    const lines = ["2026-03-15 * A", "", "2026-03-16 * B"];
    expect(transactionEndLine(lines, 1)).toBe(1);
  });

  test("should trace a transaction that is not the first in the file", () => {
    const lines = [
      "2026-03-15 * A", // 1
      "    Expenses:X  1 USD", // 2
      "    Assets:Y   -1 USD", // 3
      "", // 4
      "2026-03-16 * B", // 5 (header)
      "    Expenses:Z  2 USD", // 6
      "    Assets:Y   -2 USD", // 7
    ];
    expect(transactionEndLine(lines, 5)).toBe(7);
  });
});
