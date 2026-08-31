import { beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../spawn";

vi.mock("../../spawn");

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-bulk-edit-"));
const LEDGER = join(BASE, "ledger");

vi.mock("../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

const { bulkEditTransactionsTool } = await import("../bulk-edit-transactions.js");

// ── Fake hledger at the spawnText seam ──────────────────────────────
//
// Models real hledger faithfully: `hledger print <terms> -O json` returns all
// transactions matching the ANDed query terms (payee:/desc:/acct:/date:), with
// accurate tsourcepos; our production code does the from_account posting filter.
// `hledger check` returns whatever exit code the test set.

let seededFiles: string[] = [];
let printOverride: string | null = null;
let checkExit = 0;
let checkStderr = "";

function makeMockProc(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

function seed(relPath: string, content: string): string {
  const abs = join(LEDGER, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  seededFiles.push(abs);
  return abs;
}

/** Extract the hledger query terms from the spawn argv (between the -f file and -O). */
function queryTerms(cmd: string[]): string[] {
  const fileIdx = cmd.indexOf("-f");
  const outIdx = cmd.indexOf("-O");
  if (fileIdx < 0 || outIdx < 0) return [];
  return cmd.slice(fileIdx + 2, outIdx);
}

function parseHeader(line: string): { date: string; payee: string; description: string } | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2})(?:=\d{4}-\d{2}-\d{2})?\s+(?:[*!]\s+)?(?:\([^)]*\)\s+)?(.*)$/);
  if (!m) return null;
  let description = m[2];
  const comment = description.indexOf(";");
  if (comment >= 0) description = description.slice(0, comment);
  description = description.trim();
  const pipe = description.indexOf("|");
  const payee = (pipe >= 0 ? description.slice(0, pipe) : description).trim();
  return { date: m[1], payee, description };
}

function termMatches(
  term: string,
  tx: { date: string; payee: string; description: string; accounts: string[] },
): boolean {
  const colon = term.indexOf(":");
  const field = term.slice(0, colon);
  const value = term.slice(colon + 1);
  switch (field) {
    case "payee":
      return new RegExp(value, "i").test(tx.payee);
    case "desc":
      return new RegExp(value, "i").test(tx.description);
    case "acct":
      return tx.accounts.some((a) => new RegExp(value, "i").test(a));
    case "date":
      return tx.date.startsWith(value);
    default:
      return false;
  }
}

function fakeHledgerPrintJson(terms: string[]): string {
  const txns: unknown[] = [];
  for (const file of seededFiles) {
    // Real hledger tolerates CRLF; split on either so line numbers stay accurate.
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const header = parseHeader(lines[i]);
      if (!header) continue;

      const accounts: string[] = [];
      const tpostings: Array<{ paccount: string }> = [];
      // Real hledger's `ttags`: [name, value] pairs from every comment in the transaction's
      // own scope. This fake only recognizes this codebase's own dedicated-line shape
      // (`; name: value` / `; name:`) -- sufficient for the tag tests seeded via `seed()`;
      // tests that need hledger's other tag shapes (comma-separated, header-fused, an
      // `apply tag` directive) inject `ttags` directly via `printOverride` instead.
      const ttags: Array<[string, string]> = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "" || !/^\s/.test(l)) break;
        const body = l.replace(/^\s+/, "");
        if (body.startsWith(";")) {
          const tag = body.match(/^;\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
          if (tag) ttags.push([tag[1], tag[2].trim()]);
          continue;
        }
        // Model hledger's `paccount`: it excludes any posting status marker and the
        // brackets of virtual/balanced-virtual postings.
        const afterStatus = body.replace(/^[*!]\s+/, "");
        const sep = afterStatus.match(/ {2,}|\t+/);
        let account = (sep ? afterStatus.slice(0, sep.index) : afterStatus).replace(/\s+$/, "");
        if ((account.startsWith("(") && account.endsWith(")")) || (account.startsWith("[") && account.endsWith("]"))) {
          account = account.slice(1, -1);
        }
        accounts.push(account);
        tpostings.push({ paccount: account });
      }

      const tx = { ...header, accounts };
      if (!terms.every((t) => termMatches(t, tx))) continue;

      const pos = { sourceName: file, sourceLine: i + 1, sourceColumn: 1 };
      txns.push({ tsourcepos: [pos, pos], tpostings, ttags });
    }
  }
  return JSON.stringify(txns);
}

beforeEach(() => {
  seededFiles = [];
  printOverride = null;
  checkExit = 0;
  checkStderr = "";
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, "main.journal"), "");

  vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
    if (cmd.includes("print")) {
      return makeMockProc(0, printOverride ?? fakeHledgerPrintJson(queryTerms(cmd)));
    }
    if (cmd.includes("check")) {
      return makeMockProc(checkExit, "", checkStderr);
    }
    return makeMockProc(0);
  });
});

const run = (params: any) =>
  bulkEditTransactionsTool.execute("test", params, undefined, undefined, undefined as any) as Promise<any>;

function read(relPath: string): string {
  return readFileSync(join(LEDGER, relPath), "utf-8");
}

// Fixed-column posting line: account at 4-space indent, amount token starting at `col`.
function posting(account: string, amount: string, col = 50): string {
  const prefix = `    ${account}`;
  const pad = Math.max(2, col - prefix.length);
  return `${prefix}${" ".repeat(pad)}${amount}`;
}

// ── execution mode ──────────────────────────────────────────────────

describe("bulk_edit_transactions execution mode", () => {
  test("should run sequentially so ledger writes never interleave", () => {
    // pi runs any batch containing a "sequential" tool one call at a time.
    expect(bulkEditTransactionsTool.executionMode).toBe("sequential");
  });
});

// ── change_account ───────────────────────────────────────────────────

describe("bulk_edit_transactions: change_account", () => {
  const acct = (from: string, next: string) => ({
    action: "change_account" as const,
    from: from,
    to: next,
  });

  test("rewrites only the target posting; sibling postings are byte-identical", async () => {
    const before = [
      "2026-03-15 * EDEKA | groceries",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    await run({ query: ["payee:EDEKA"], ...acct("expenses:uncategorized", "expenses:food:groceries") });

    const after = read("2026/03.journal").split("\n");
    expect(after[0]).toBe("2026-03-15 * EDEKA | groceries");
    expect(after[1].trim().startsWith("expenses:food:groceries")).toBe(true);
    expect(after[1]).toContain("45.00 EUR");
    expect(after[2]).toBe(posting("assets:checking", "-45.00 EUR"));
  });

  test("preserves the amount's original column after the account swap", async () => {
    const original = posting("expenses:uncategorized", "45.00 EUR");
    seed("2026/03.journal", ["2026-03-15 * EDEKA", original, posting("assets:checking", "-45.00 EUR"), ""].join("\n"));

    await run({ query: ["payee:EDEKA"], ...acct("expenses:uncategorized", "expenses:food:groceries") });

    const movedLine = read("2026/03.journal").split("\n")[1];
    expect(movedLine.indexOf("45.00 EUR")).toBe(original.indexOf("45.00 EUR"));
  });

  test("rewrites an amountless balancing posting to just the target account", async () => {
    seed(
      "2026/03.journal",
      ["2026-03-15 * EDEKA", posting("assets:checking", "-45.00 EUR"), "    expenses:uncategorized", ""].join("\n"),
    );

    await run({ query: ["payee:EDEKA"], ...acct("expenses:uncategorized", "expenses:food:groceries") });

    expect(read("2026/03.journal").split("\n")[2]).toBe("    expenses:food:groceries");
  });

  test("ANDs multiple query terms and moves across multiple files", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    // Same payee but no uncategorized posting -> excluded by the acct term.
    seed(
      "2026/04.journal",
      [
        "2026-04-02 * EDEKA",
        posting("expenses:food:groceries", "30.00 EUR"),
        posting("assets:checking", "-30.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({
      query: ["payee:EDEKA", "acct:expenses:uncategorized"],
      ...acct("expenses:uncategorized", "expenses:food:groceries"),
    });

    expect(result.details.transactions).toBe(1);
    expect(result.details.postings).toBe(1);
    expect(result.details.diffs).toHaveLength(1);
  });

  test("moves both postings when a transaction has two target postings", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "30.00 EUR"),
        posting("expenses:uncategorized", "15.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({
      query: ["payee:EDEKA"],
      ...acct("expenses:uncategorized", "expenses:food:groceries"),
    });

    expect(result.details.transactions).toBe(1);
    expect(result.details.postings).toBe(2);
  });

  test("leaves a query match without the target posting untouched", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({
      query: ["payee:EDEKA"],
      ...acct("expenses:uncategorized", "expenses:food:delivery"),
    });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.transactions).toBe(0);
    expect(result.details.warnings).toHaveLength(0);
  });

  test("rejects change_account without from", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    await expect(
      run({ query: ["payee:EDEKA"], action: "change_account", to: "expenses:food:groceries" }),
    ).rejects.toThrow("from is required");
  });

  test("rejects an account to-value containing two or more consecutive spaces", async () => {
    await expect(
      run({ query: ["payee:EDEKA"], ...acct("expenses:uncategorized", "expenses:food  groceries") }),
    ).rejects.toThrow("two or more consecutive spaces");
  });
});

// ── change_payee ─────────────────────────────────────────────────────

describe("bulk_edit_transactions: change_payee", () => {
  const payee = (from: string, next: string) => ({ action: "change_payee" as const, from: from, to: next });

  test("renames the payee, preserving date, status, description, and comment", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK | weekly shop  ; ref:1",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...payee("EDK", "EDEKA") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[0]).toBe("2026-03-15 * EDEKA | weekly shop  ; ref:1");
    expect(result.details.transactions).toBe(1);
    expect(result.details.postings).toBe(0);
  });

  test("renames a payee with no description", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...payee("EDK", "EDEKA") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 * EDEKA");
  });

  test("leaves posting lines untouched", async () => {
    const p1 = posting("expenses:food:groceries", "45.00 EUR");
    const p2 = posting("assets:checking", "-45.00 EUR");
    seed("2026/03.journal", ["2026-03-15 * EDK", p1, p2, ""].join("\n"));

    await run({ query: ["payee:EDK"], ...payee("EDK", "EDEKA") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[1]).toBe(p1);
    expect(lines[2]).toBe(p2);
  });

  test("renames all matching transactions", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
        "2026-03-20 * EDK",
        posting("expenses:food:groceries", "20.00 EUR"),
        posting("assets:checking", "-20.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...payee("EDK", "EDEKA") });

    expect(result.details.transactions).toBe(2);
    const content = read("2026/03.journal");
    expect(content.match(/\* EDEKA/g)).toHaveLength(2);
  });

  test("is a no-op when the payee already equals `to`", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDEKA"], ...payee("EDEKA", "EDEKA") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.transactions).toBe(0);
    expect(result.details.diffs).toHaveLength(0);
  });

  test("renames only the payee that exactly equals `from`, sparing fuzzy matches", async () => {
    // A `payee:DB` query matches both via case-insensitive substring, but only the exact
    // "DB" payee should be renamed; "GOLDBACH" must be left untouched.
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * DB",
        posting("expenses:transport", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
        "2026-03-20 * GOLDBACH",
        posting("expenses:food:groceries", "20.00 EUR"),
        posting("assets:checking", "-20.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:DB"], ...payee("DB", "Deutsche Bahn") });

    const content = read("2026/03.journal");
    expect(content).toContain("2026-03-15 * Deutsche Bahn");
    expect(content).toContain("2026-03-20 * GOLDBACH"); // fuzzy match spared
    expect(content).not.toContain("* DB\n");
    expect(result.details.transactions).toBe(1);
  });

  test("keeps a space before '|' when the original payee ran up against it", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK| note",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...payee("EDK", "EDEKA") });

    // A separator must stay space-delimited or hledger folds it into the payee.
    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 * EDEKA | note");
  });

  test("rejects change_payee without from", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    await expect(run({ query: ["payee:EDK"], action: "change_payee", to: "EDEKA" })).rejects.toThrow(
      "from is required",
    );
  });

  test("rejects a payee to-value containing '|' or ';'", async () => {
    await expect(
      run({ query: ["payee:EDK"], action: "change_payee", from: "EDK", to: "EDEKA | injected" }),
    ).rejects.toThrow("must not contain");
  });
});

// ── query handling, dry_run, validation ─────────────────────────────

describe("bulk_edit_transactions: query, dry_run, validation", () => {
  const recat = {
    action: "change_account" as const,
    from: "expenses:uncategorized",
    to: "expenses:food:groceries",
  };

  test("matches a single query element containing a space (desc:whole foods)", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * Market | whole foods run",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["desc:whole foods"], ...recat });

    // The mock asserts the term arrives intact as one argv element (see queryTerms).
    expect(result.details.transactions).toBe(1);
    expect(read("2026/03.journal")).toContain("expenses:food:groceries");
  });

  test("passes each query element as a distinct argv token", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDEKA", "desc:whole foods run"], ...recat });

    const printCall = vi.mocked(spawnText).mock.calls.find((c) => c[0].includes("print"));
    expect(printCall?.[0]).toContain("payee:EDEKA");
    expect(printCall?.[0]).toContain("desc:whole foods run"); // single element, space intact
  });

  test("rejects a query term starting with '-'", async () => {
    await expect(run({ query: ["--output-file=/tmp/x"], ...recat })).rejects.toThrow("must not start with '-'");
  });

  test("rejects an empty query array", async () => {
    await expect(run({ query: [], ...recat })).rejects.toThrow("non-empty array");
  });

  test("dry_run returns diffs but leaves files byte-for-byte unchanged", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDEKA"], ...recat, dry_run: true });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.dryRun).toBe(true);
    expect(result.details.diffs).toHaveLength(1);
    expect(result.details.diffs[0].diff).toContain("expenses:food:groceries");
  });

  test("dry_run reports an invalid ledger without writing", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    checkExit = 1;
    checkStderr = "unknown account 'expenses:food:groceries'";

    const result = await run({ query: ["payee:EDEKA"], ...recat, dry_run: true });

    expect(result.details.ledgerIsValid).toBe(false);
    expect(result.details.validationError).toContain("unknown account");
  });

  test("rolls all files back to the snapshot when validation fails", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    checkExit = 1;
    checkStderr = "unknown account 'expenses:food:groceries'";

    await expect(run({ query: ["payee:EDEKA"], ...recat })).rejects.toThrow("unknown account");
    expect(read("2026/03.journal")).toBe(before);
  });

  test("warns when hledger flags a target posting the text lacks", async () => {
    const before = ["2026-03-15 * EDEKA", posting("assets:checking", "-45.00 EUR"), ""].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:uncategorized" }, { paccount: "assets:checking" }],
      },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...recat });

    expect(result.details.warnings).toHaveLength(1);
    expect(result.details.transactions).toBe(0);
    expect(read("2026/03.journal")).toBe(before);
  });
});

// ── hledger syntax edge cases ───────────────────────────────────────

describe("bulk_edit_transactions: hledger syntax edge cases", () => {
  const recat = {
    action: "change_account" as const,
    from: "expenses:uncategorized",
    to: "expenses:food:groceries",
  };

  test("preserves a posting status marker (cleared/pending) when recategorizing", async () => {
    const src = "    * expenses:uncategorized               45.00 EUR";
    seed("2026/03.journal", ["2026-03-15 * EDEKA", src, posting("assets:checking", "-45.00 EUR"), ""].join("\n"));

    await run({ query: ["payee:EDEKA"], ...recat });

    const moved = read("2026/03.journal").split("\n")[1];
    expect(moved.trimStart().startsWith("* expenses:food:groceries")).toBe(true);
    expect(moved.indexOf("45.00 EUR")).toBe(src.indexOf("45.00 EUR")); // amount column preserved
  });

  test("recategorizes a virtual (acct) posting, re-wrapping the brackets", async () => {
    const src = posting("(expenses:uncategorized)", "45.00 EUR");
    seed("2026/03.journal", ["2026-03-15 * EDEKA", posting("assets:checking", "-45.00 EUR"), src, ""].join("\n"));

    await run({ query: ["payee:EDEKA"], ...recat });

    const moved = read("2026/03.journal").split("\n")[2];
    expect(moved.trimStart().startsWith("(expenses:food:groceries)")).toBe(true);
    expect(moved.indexOf("45.00 EUR")).toBe(src.indexOf("45.00 EUR"));
  });

  test("recategorizes a balanced-virtual [acct] posting", async () => {
    seed(
      "2026/03.journal",
      ["2026-03-15 * EDEKA", posting("assets:checking", "-45.00 EUR"), "    [expenses:uncategorized]", ""].join("\n"),
    );

    await run({ query: ["payee:EDEKA"], ...recat });

    expect(read("2026/03.journal").split("\n")[2]).toBe("    [expenses:food:groceries]");
  });

  test("preserves an inline comment on a recategorized posting", async () => {
    const src = "    expenses:uncategorized                45.00 EUR  ; imported";
    seed("2026/03.journal", ["2026-03-15 * EDEKA", src, posting("assets:checking", "-45.00 EUR"), ""].join("\n"));

    await run({ query: ["payee:EDEKA"], ...recat });

    const moved = read("2026/03.journal").split("\n")[1];
    expect(moved.trimStart().startsWith("expenses:food:groceries")).toBe(true);
    expect(moved).toContain("45.00 EUR");
    expect(moved.endsWith("; imported")).toBe(true); // trailing posting comment survives
    expect(moved.indexOf("45.00 EUR")).toBe(src.indexOf("45.00 EUR")); // column preserved
  });

  test("preserves a secondary date (date=date2) when renaming the payee", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15=2026-03-18 * EDK | note",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], action: "change_payee", from: "EDK", to: "EDEKA" });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15=2026-03-18 * EDEKA | note");
  });

  test("preserves a transaction code (code) when renaming the payee", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * (INV42) EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], action: "change_payee", from: "EDK", to: "EDEKA" });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 * (INV42) EDEKA");
  });

  test("applies edits and preserves CRLF line endings", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\r\n");
    seed("2026/03.journal", before);

    await run({ query: ["payee:EDEKA"], ...recat });

    const raw = read("2026/03.journal");
    expect(raw).toContain("expenses:food:groceries");
    expect(raw).not.toContain("expenses:uncategorized");
    expect(raw).toContain("\r\n"); // CRLF preserved
    expect(raw).not.toContain("\r\r"); // no doubled carriage returns
  });

  test("preserves CRLF line endings when renaming a payee", async () => {
    const before = [
      "2026-03-15 * EDK | note",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\r\n");
    seed("2026/03.journal", before);

    await run({ query: ["payee:EDK"], action: "change_payee", from: "EDK", to: "EDEKA" });

    const raw = read("2026/03.journal");
    expect(raw).toContain("2026-03-15 * EDEKA | note");
    expect(raw).toContain("\r\n");
    expect(raw).not.toContain("\r\r");
  });

  test("stops the posting scan at the next transaction header (no blank line between)", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "2026-03-16 * OTHER",
        posting("expenses:uncategorized", "10.00 EUR"),
        posting("assets:checking", "-10.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDEKA"], ...recat });

    const lines = read("2026/03.journal").split("\n");
    expect(result.details.transactions).toBe(1);
    expect(lines[1].trim().startsWith("expenses:food:groceries")).toBe(true);
    // The scan must not run past OTHER's header into its postings.
    expect(lines[4].trim().startsWith("expenses:uncategorized")).toBe(true);
  });

  test("skips comment lines inside a transaction", async () => {
    const comment = "    ; imported from bank csv";
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        comment,
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDEKA"], ...recat });

    const lines = read("2026/03.journal").split("\n");
    expect(result.details.postings).toBe(1);
    expect(lines[1]).toBe(comment); // comment line untouched
    expect(lines[2].trim().startsWith("expenses:food:groceries")).toBe(true);
  });
});

// ── parameter validation ────────────────────────────────────────────

describe("bulk_edit_transactions: parameter validation", () => {
  const recat = {
    action: "change_account" as const,
    from: "expenses:uncategorized",
    to: "expenses:food:groceries",
  };

  test("rejects an empty-string query term", async () => {
    await expect(run({ query: [""], ...recat })).rejects.toThrow("query terms must not be empty");
  });

  test("rejects a whitespace-only query term", async () => {
    await expect(run({ query: ["  "], ...recat })).rejects.toThrow("query terms must not be empty");
  });

  test("rejects an unsupported action", async () => {
    await expect(run({ query: ["payee:EDEKA"], action: "amount", from: "x", to: "50.00 EUR" })).rejects.toThrow(
      "Unsupported field",
    );
  });

  test("rejects an empty to-value", async () => {
    await expect(run({ query: ["payee:EDEKA"], action: "change_account", from: "x", to: "" })).rejects.toThrow(
      "to must not be empty",
    );
  });

  test("rejects a to-value with leading or trailing whitespace", async () => {
    await expect(
      run({ query: ["payee:EDEKA"], action: "change_account", from: "x", to: " expenses:food " }),
    ).rejects.toThrow("leading or trailing whitespace");
  });
});

// ── discovery robustness ────────────────────────────────────────────

describe("bulk_edit_transactions: discovery robustness", () => {
  const recat = {
    action: "change_account" as const,
    from: "expenses:uncategorized",
    to: "expenses:food:groceries",
  };
  const rename = { action: "change_payee" as const, from: "EDEKA", to: "Edeka" };

  test("returns zero matches when hledger print outputs invalid JSON", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = "this is not json";

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.transactions).toBe(0);
    expect(read("2026/03.journal")).toBe(before);
  });

  test("returns zero matches when hledger print outputs a non-array", async () => {
    printOverride = JSON.stringify({ tag: "not-an-array" });

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.transactions).toBe(0);
  });

  test("skips transactions with a missing or malformed tsourcepos", async () => {
    printOverride = JSON.stringify([
      { tpostings: [] }, // no tsourcepos at all
      { tsourcepos: [], tpostings: [] }, // empty array
      { tsourcepos: [{ sourceName: 42, sourceLine: "x" }], tpostings: [] }, // wrong types
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.transactions).toBe(0);
  });

  test("skips a transaction whose source file is outside the ledger dir", async () => {
    printOverride = JSON.stringify([
      { tsourcepos: [{ sourceName: "/etc/passwd", sourceLine: 1, sourceColumn: 1 }], tpostings: [] },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.transactions).toBe(0);
  });

  test("resolves a relative tsourcepos path against the workspace", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDEKA",
        posting("expenses:uncategorized", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: "ledger/2026/03.journal", sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:uncategorized" }],
      },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...recat });

    expect(result.details.transactions).toBe(1);
    expect(read("2026/03.journal")).toContain("expenses:food:groceries");
  });

  test("skips an account-field match whose tpostings is missing", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      { tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }] },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...recat });

    expect(result.details.transactions).toBe(0);
    expect(read("2026/03.journal")).toBe(before);
  });

  test("warns and leaves the transaction unchanged when the target line is not a header", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      // sourceLine 2 points at a posting line, which cannot parse as a header.
      { tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 2, sourceColumn: 1 }], tpostings: [] },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.warnings).toHaveLength(1);
    expect(result.details.warnings[0]).toContain("Could not parse transaction header");
    expect(result.details.transactions).toBe(0);
    expect(read("2026/03.journal")).toBe(before);
  });

  test("warns when the source line is past the end of the file", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 999, sourceColumn: 1 }],
        tpostings: [],
      },
    ]);

    const result = await run({ query: ["payee:EDEKA"], ...rename });

    expect(result.details.warnings).toHaveLength(1);
    expect(result.details.transactions).toBe(0);
    expect(read("2026/03.journal")).toBe(before);
  });
});

// ── unexpected validation failures ──────────────────────────────────

describe("bulk_edit_transactions: unexpected validation failures", () => {
  const recat = {
    action: "change_account" as const,
    from: "expenses:uncategorized",
    to: "expenses:food:groceries",
  };

  test("restores files and rethrows when hledger check itself fails unexpectedly", async () => {
    const before = [
      "2026-03-15 * EDEKA",
      posting("expenses:uncategorized", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    // Not an HledgerCommandError: the crash must roll the batch back and propagate.
    vi.mocked(spawnText).mockImplementation(async (cmd: string[]) => {
      if (cmd.includes("print")) return makeMockProc(0, fakeHledgerPrintJson(queryTerms(cmd)));
      if (cmd.includes("check")) throw new Error("hledger crashed");
      return makeMockProc(0);
    });

    await expect(run({ query: ["payee:EDEKA"], ...recat })).rejects.toThrow("hledger crashed");
    expect(read("2026/03.journal")).toBe(before);
  });
});

// ── set_status ───────────────────────────────────────────────────────

describe("bulk_edit_transactions: set_status", () => {
  const status = (next: string) => ({ action: "set_status" as const, to: next });

  test("marks a matched transaction cleared, preserving the rest of the header", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 EDK | weekly shop  ; ref:1",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 * EDK | weekly shop  ; ref:1");
    expect(result.details.transactions).toBe(1);
    expect(result.details.postings).toBe(0);
    expect(result.content[0].text).toContain("1 transaction(s) marked cleared");
  });

  test("marks a matched transaction pending", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...status("pending") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 ! EDK");
  });

  test("removes the marker when setting unmarked", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...status("unmarked") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 EDK");
  });

  test("swaps pending to cleared, preserving the original spacing", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15  !  EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15  *  EDK");
  });

  test("is a no-op when the status already matches", async () => {
    const before = [
      "2026-03-15 * EDK",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.transactions).toBe(0);
    expect(result.details.diffs).toHaveLength(0);
  });

  test("marks all matching transactions", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
        "2026-03-20 ! EDK",
        posting("expenses:food:groceries", "20.00 EUR"),
        posting("assets:checking", "-20.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(result.details.transactions).toBe(2);
    expect(read("2026/03.journal").match(/\* EDK/g)).toHaveLength(2);
  });

  test("leaves posting-level status markers untouched", async () => {
    const marked = "    * expenses:food:groceries                45.00 EUR";
    seed("2026/03.journal", ["2026-03-15 EDK", marked, posting("assets:checking", "-45.00 EUR"), ""].join("\n"));

    await run({ query: ["payee:EDK"], ...status("cleared") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[0]).toBe("2026-03-15 * EDK");
    expect(lines[1]).toBe(marked);
  });

  test("preserves a secondary date and a transaction code", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15=2026-03-18 (INV42) EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15=2026-03-18 * (INV42) EDK");
  });

  test("marks a description-less transaction (header is just the date)", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    // The date-only header has no payee for the query to match; target it directly.
    printOverride = JSON.stringify([
      { tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }], tpostings: [] },
    ]);

    await run({ query: ["date:2026-03-15"], ...status("cleared") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15 *");
  });

  test("removes the marker from a header that is just a date and marker", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 *",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    printOverride = JSON.stringify([
      { tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }], tpostings: [] },
    ]);

    await run({ query: ["date:2026-03-15"], ...status("unmarked") });

    expect(read("2026/03.journal").split("\n")[0]).toBe("2026-03-15");
  });

  test("preserves CRLF line endings when setting status", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\r\n"),
    );

    await run({ query: ["payee:EDK"], ...status("cleared") });

    const raw = read("2026/03.journal");
    expect(raw).toContain("2026-03-15 * EDK");
    expect(raw).toContain("\r\n");
    expect(raw).not.toContain("\r\r");
  });

  test("warns and leaves the file unchanged when the target line is not a header", async () => {
    const before = [
      "2026-03-15 EDK",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      // sourceLine 2 points at a posting line, which cannot parse as a header.
      { tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 2, sourceColumn: 1 }], tpostings: [] },
    ]);

    const result = await run({ query: ["payee:EDK"], ...status("cleared") });

    expect(result.details.warnings).toHaveLength(1);
    expect(result.details.warnings[0]).toContain("Could not parse transaction header");
    expect(read("2026/03.journal")).toBe(before);
  });

  test("rejects an invalid status value", async () => {
    await expect(run({ query: ["payee:EDK"], ...status("done") })).rejects.toThrow(
      'to (status) must be "cleared", "pending", or "unmarked"',
    );
  });
});

// ── set_tag ──────────────────────────────────────────────────────────

describe("bulk_edit_transactions: set_tag", () => {
  const setTag = (tag: string, value: string) => ({ action: "set_tag" as const, tag, to: value });

  test("adds a new tag right after the header when the transaction has none", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[0]).toBe("2026-03-15 * EDK");
    expect(lines[1]).toBe("    ; review: yes");
    expect(lines[2]).toBe(posting("expenses:food:groceries", "45.00 EUR"));
    expect(result.details.tagOutcomes).toEqual({ added: 1, overwritten: 0, removed: 0, unchanged: 0, skipped: 0 });
    expect(result.content[0].text).toContain("Tagged 1 transaction(s) with `review` (1 newly)");
  });

  test("appends after an existing dedicated tag line without reordering", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; foo: bar",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[1]).toBe("    ; foo: bar");
    expect(lines[2]).toBe("    ; review: yes");
  });

  test("overwrites an existing tag with a different value", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; review: no",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    expect(read("2026/03.journal").split("\n")[1]).toBe("    ; review: yes");
    expect(result.details.tagOutcomes).toEqual({ added: 0, overwritten: 1, removed: 0, unchanged: 0, skipped: 0 });
    expect(result.content[0].text).toContain("Tagged 1 transaction(s) with `review` (1 value changed)");
  });

  test("is a no-op when the value already matches", async () => {
    const before = [
      "2026-03-15 * EDK",
      "    ; review: yes",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.unchanged).toBe(1);
    expect(result.details.diffs).toHaveLength(0);
  });

  test("adds a value-less tag", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...setTag("review", "") });

    expect(read("2026/03.journal").split("\n")[1]).toBe("    ; review:");
  });

  test("editing a tag never touches a sibling tag sharing its name as a prefix", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; review: no",
        "    ; review_date: 2026-01-01",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[1]).toBe("    ; review: yes");
    expect(lines[2]).toBe("    ; review_date: 2026-01-01");
  });

  test("matches the transaction's existing indentation for a newly inserted tag", async () => {
    seed(
      "2026/03.journal",
      ["2026-03-15 * EDK", "  expenses:food:groceries    45.00 EUR", "  assets:checking          -45.00 EUR", ""].join(
        "\n",
      ),
    );

    await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    expect(read("2026/03.journal").split("\n")[1]).toBe("  ; review: yes");
  });

  test("preserves CRLF line endings on the newly inserted tag line", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\r\n"),
    );

    await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    const raw = read("2026/03.journal");
    expect(raw).toContain("; review: yes\r\n");
    expect(raw).not.toContain("\r\r");
  });

  test("skips a tag whose text lives on a comma-separated line, without corrupting it", async () => {
    const before = [
      "2026-03-15 * EDK",
      "    ; review: yes, related_file: files/receipt.pdf",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [
          ["review", "yes"],
          ["related_file", "files/receipt.pdf"],
        ],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "no") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.skipped).toBe(1);
    expect(result.details.warnings[0]).toContain('tag "review" exists but its text could not be safely located');
  });

  test("skips a tag fused into the header's own trailing comment", async () => {
    const before = [
      "2026-03-15 * EDK ; review: yes",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [["review", "yes"]],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "no") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.skipped).toBe(1);
  });

  test("skips a tag reported present with no matching text anywhere (e.g. an apply tag directive)", async () => {
    const before = [
      "2026-03-15 * EDK",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [["review", "yes"]],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "no") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.skipped).toBe(1);
    // Never inserts a second, conflicting definition alongside the one it can't see.
    expect(read("2026/03.journal")).not.toContain("; review:");
  });

  test("skips (both actions) when a tag name appears more than once in ttags", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; review: a",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [
          ["review", "a"],
          ["review", "b"],
        ],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes") });

    expect(result.details.tagOutcomes?.skipped).toBe(1);
    expect(result.details.warnings[0]).toContain("ambiguous");
  });

  test("dry_run leaves the file byte-for-byte unchanged", async () => {
    const before = [
      "2026-03-15 * EDK",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes"), dry_run: true });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.added).toBe(1);
    expect(result.details.diffs[0].diff).toContain("review: yes");
  });

  test("requires `tag`", async () => {
    await expect(run({ query: ["payee:EDK"], action: "set_tag", to: "yes" })).rejects.toThrow(
      "tag is required for set_tag",
    );
  });

  test("rejects a tag name containing a regex metacharacter, matching only the literal name", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; review.2026: old",
        "    ; reviewX2026: unrelated",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [
          ["review.2026", "old"],
          ["reviewX2026", "unrelated"],
        ],
      },
    ]);

    await run({ query: ["payee:EDK"], ...setTag("review.2026", "new") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[1]).toBe("    ; review.2026: new");
    expect(lines[2]).toBe("    ; reviewX2026: unrelated"); // untouched -- '.' must not match 'X'
  });

  test("falls back to four-space indentation when the transaction has no indented line to infer from", async () => {
    // A header with no postings at all (invalid hledger on its own, but exercises the
    // locator's fallback in isolation) -- dry_run so there is nothing for `hledger check`
    // to reject.
    seed("2026/03.journal", "2026-03-15 * EDK\n");
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [],
        ttags: [],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...setTag("review", "yes"), dry_run: true });

    expect(result.details.tagOutcomes?.added).toBe(1);
    expect(result.details.diffs[0].diff).toContain("    ; review: yes");
  });
});

// ── remove_tag ───────────────────────────────────────────────────────

describe("bulk_edit_transactions: remove_tag", () => {
  const removeTag = (tag: string) => ({ action: "remove_tag" as const, tag, to: "" });

  test("removes a tag on its own dedicated line, leaving siblings and postings intact", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; foo: bar",
        "    ; review: yes",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], ...removeTag("review") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[1]).toBe("    ; foo: bar");
    expect(lines[2]).toBe(posting("expenses:food:groceries", "45.00 EUR"));
    expect(result.details.tagOutcomes?.removed).toBe(1);
    expect(result.content[0].text).toContain("Removed tag `review` from 1 transaction(s)");
  });

  test("dry_run reports the pending removal without writing", async () => {
    const before = [
      "2026-03-15 * EDK",
      "    ; review: yes",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDK"], ...removeTag("review"), dry_run: true });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.removed).toBe(1);
    expect(result.content[0].text).toContain("Would remove tag `review` from 1 transaction(s)");
  });

  test("removes the last remaining tag; the header goes straight into the first posting", async () => {
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        "    ; review: yes",
        posting("expenses:food:groceries", "45.00 EUR"),
        posting("assets:checking", "-45.00 EUR"),
        "",
      ].join("\n"),
    );

    await run({ query: ["payee:EDK"], ...removeTag("review") });

    const lines = read("2026/03.journal").split("\n");
    expect(lines[0]).toBe("2026-03-15 * EDK");
    expect(lines[1]).toBe(posting("expenses:food:groceries", "45.00 EUR"));
  });

  test("is a no-op, no warning, when the tag isn't present", async () => {
    const before = [
      "2026-03-15 * EDK",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);

    const result = await run({ query: ["payee:EDK"], ...removeTag("review") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.unchanged).toBe(1);
    expect(result.details.warnings).toHaveLength(0);
  });

  test("skips a tag whose text lives on a comma-separated line, without corrupting it", async () => {
    const before = [
      "2026-03-15 * EDK",
      "    ; review: yes, related_file: files/receipt.pdf",
      posting("expenses:food:groceries", "45.00 EUR"),
      posting("assets:checking", "-45.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    printOverride = JSON.stringify([
      {
        tsourcepos: [{ sourceName: join(LEDGER, "2026/03.journal"), sourceLine: 1, sourceColumn: 1 }],
        tpostings: [{ paccount: "expenses:food:groceries" }],
        ttags: [
          ["review", "yes"],
          ["related_file", "files/receipt.pdf"],
        ],
      },
    ]);

    const result = await run({ query: ["payee:EDK"], ...removeTag("review") });

    expect(read("2026/03.journal")).toBe(before);
    expect(result.details.tagOutcomes?.skipped).toBe(1);
  });

  test("requires `tag`", async () => {
    await expect(run({ query: ["payee:EDK"], action: "remove_tag", to: "" })).rejects.toThrow(
      "tag is required for remove_tag",
    );
  });
});

// ── tag edits: multi-transaction ordering + rollback ────────────────

describe("bulk_edit_transactions: tag edits across multiple matches", () => {
  test("an insertion on a later transaction never shifts the startLine of one processed after it", async () => {
    // Two transactions in one file: the first gets a new line inserted (line-count-changing),
    // the second (further up... no, below) must still resolve to its correct, now-shifted
    // location. Matches are processed bottom-up, so the lower transaction's insertion must
    // not affect the upper transaction's startLine.
    seed(
      "2026/03.journal",
      [
        "2026-03-15 * EDK",
        posting("expenses:food:groceries", "10.00 EUR"),
        posting("assets:checking", "-10.00 EUR"),
        "",
        "2026-03-20 * EDK",
        posting("expenses:food:groceries", "20.00 EUR"),
        posting("assets:checking", "-20.00 EUR"),
        "",
      ].join("\n"),
    );

    const result = await run({ query: ["payee:EDK"], action: "set_tag", tag: "review", to: "yes" });

    expect(result.details.tagOutcomes?.added).toBe(2);
    const lines = read("2026/03.journal").split("\n");
    expect(lines[0]).toBe("2026-03-15 * EDK");
    expect(lines[1]).toBe("    ; review: yes");
    expect(lines[2]).toBe(posting("expenses:food:groceries", "10.00 EUR"));
    // Find the second transaction's header by content rather than a hardcoded index, since
    // this assertion is exactly what would break if line-shifting were handled incorrectly.
    const secondHeaderIdx = lines.indexOf("2026-03-20 * EDK");
    expect(secondHeaderIdx).toBeGreaterThan(0);
    expect(lines[secondHeaderIdx + 1]).toBe("    ; review: yes");
    expect(lines[secondHeaderIdx + 2]).toBe(posting("expenses:food:groceries", "20.00 EUR"));
  });

  test("rolls the whole batch back, including tag insertions, when the ledger would be invalid", async () => {
    const before = [
      "2026-03-15 * EDK",
      posting("expenses:food:groceries", "10.00 EUR"),
      posting("assets:checking", "-10.00 EUR"),
      "",
    ].join("\n");
    seed("2026/03.journal", before);
    checkExit = 1;
    checkStderr = "some unrelated validation error";

    await expect(run({ query: ["payee:EDK"], action: "set_tag", tag: "review", to: "yes" })).rejects.toThrow(
      "Modification reverted",
    );

    expect(read("2026/03.journal")).toBe(before);
  });
});
