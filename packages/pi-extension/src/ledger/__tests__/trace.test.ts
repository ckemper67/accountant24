import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../spawn";

vi.mock("../../spawn");

const BASE = mkdtempSync(join(tmpdir(), "accountant24-trace-"));
const LEDGER = join(BASE, "ledger");

vi.mock("../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

const { parseLogL, traceTransactions } = await import("../trace.js");

const RS = "\x1e";
const US = "\x1f";

// Build one commit's `git log -L` block: our formatted metadata line then a diff.
function block(commit: string, date: string, message: string, diff: string): string {
  return `${RS}${commit}${US}${date}${US}${message}\n${diff}`;
}

// ── parseLogL() ─────────────────────────────────────────────────────

describe("parseLogL()", () => {
  const modifyDiff = [
    "diff --git a/ledger/2026/03.journal b/ledger/2026/03.journal",
    "--- a/ledger/2026/03.journal",
    "+++ b/ledger/2026/03.journal",
    "@@ -1,3 +1,3 @@",
    " 2026-03-15 * Whole Foods | Groceries",
    "-    Expenses:Uncategorized      45.00 USD",
    "+    Expenses:Food:Groceries     45.00 USD",
    "     Assets:Checking            -45.00 USD",
  ].join("\n");

  const createDiff = [
    "diff --git a/ledger/2026/03.journal b/ledger/2026/03.journal",
    "--- /dev/null",
    "+++ b/ledger/2026/03.journal",
    "@@ -0,0 +1,3 @@",
    "+2026-03-15 * Whole Foods | Groceries",
    "+    Expenses:Uncategorized      45.00 USD",
    "+    Assets:Checking            -45.00 USD",
  ].join("\n");

  const log =
    block("aaaa1111", "2026-03-16T10:00:00+00:00", "Recategorize Whole Foods", modifyDiff) +
    block("bbbb2222", "2026-03-15T09:00:00+00:00", "Add Whole Foods purchase", createDiff);

  test("should return one revision per commit, newest first", () => {
    const revs = parseLogL(log);
    expect(revs).toHaveLength(2);
    expect(revs[0].commit).toBe("aaaa1111");
    expect(revs[1].commit).toBe("bbbb2222");
  });

  test("should parse the commit hash, ISO date, and subject", () => {
    const [newest] = parseLogL(log);
    expect(newest.commit).toBe("aaaa1111");
    expect(newest.date).toBe("2026-03-16T10:00:00+00:00");
    expect(newest.message).toBe("Recategorize Whole Foods");
  });

  test("should capture the unified diff for each revision", () => {
    const [newest] = parseLogL(log);
    expect(newest.diff).toBe(modifyDiff);
  });

  test("should reconstruct the post-image text of a modify commit (context + added lines)", () => {
    const [newest] = parseLogL(log);
    expect(newest.text).toBe(
      [
        "2026-03-15 * Whole Foods | Groceries",
        "    Expenses:Food:Groceries     45.00 USD",
        "    Assets:Checking            -45.00 USD",
      ].join("\n"),
    );
  });

  test("should reconstruct the original transaction from the oldest (creation) commit", () => {
    const revs = parseLogL(log);
    const original = revs[revs.length - 1];
    expect(original.text).toBe(
      [
        "2026-03-15 * Whole Foods | Groceries",
        "    Expenses:Uncategorized      45.00 USD",
        "    Assets:Checking            -45.00 USD",
      ].join("\n"),
    );
  });

  test("should exclude removed ('-') lines from the reconstructed text", () => {
    const [newest] = parseLogL(log);
    expect(newest.text).not.toContain("Uncategorized");
  });

  test("should return an empty array for empty input", () => {
    expect(parseLogL("")).toEqual([]);
  });

  test("should default missing date and message fields to empty strings", () => {
    // A metadata line with only the hash (no unit separators) still yields a revision.
    const [rev] = parseLogL(`${RS}deadbeef\n@@ -1,1 +1,1 @@\n x`);
    expect(rev.commit).toBe("deadbeef");
    expect(rev.date).toBe("");
    expect(rev.message).toBe("");
  });

  test("should tolerate trailing newlines after the last diff", () => {
    const revs = parseLogL(`${log}\n\n`);
    expect(revs).toHaveLength(2);
    expect(revs[1].text.endsWith("USD")).toBe(true);
  });

  test("should skip an empty trailing chunk (input ending with the record separator)", () => {
    const revs = parseLogL(`${block("c1", "2026-03-16T00:00:00+00:00", "msg", "@@ -1,1 +1,1 @@\n x")}${RS}`);
    expect(revs).toHaveLength(1);
    expect(revs[0].commit).toBe("c1");
  });

  test("should stop reconstruction at a second file's diff header", () => {
    const body = [
      "@@ -1,1 +1,1 @@",
      " 2026-03-15 * Whole Foods",
      "diff --git a/other b/other",
      "+2026-03-20 * Unrelated",
    ].join("\n");
    const [rev] = parseLogL(block("c1", "2026-03-16T00:00:00+00:00", "msg", body));
    expect(rev.text).toBe("2026-03-15 * Whole Foods");
  });

  test("should stop reconstruction at a second hunk", () => {
    const twoHunks = [
      "@@ -1,1 +1,1 @@",
      " 2026-03-15 * Whole Foods",
      "@@ -9,1 +9,1 @@",
      "+2026-03-20 * Unrelated",
    ].join("\n");
    const [rev] = parseLogL(block("c1", "2026-03-16T00:00:00+00:00", "msg", twoHunks));
    expect(rev.text).toBe("2026-03-15 * Whole Foods");
  });
});

// ── traceTransactions() over a real git repo ────────────────────────

// hledger `print` is faked at the spawn seam; every `git` call runs for real so
// `git log -L` exercises the actual line-range history walk.
function realGit(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.stdout ?? "";
}

function seed(relPath: string, content: string): void {
  const abs = join(LEDGER, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// Minimal faithful `hledger print -O json`: scan seeded monthly journals for headers,
// filter by any payee: term, return accurate tsourcepos (abs file + 1-based line).
function fakeHledgerPrintJson(monthFiles: string[], terms: string[]): string {
  const payee = terms.find((t) => t.startsWith("payee:"))?.slice("payee:".length);
  const txns: unknown[] = [];
  for (const rel of monthFiles) {
    const file = join(LEDGER, rel);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\d{4}-\d{2}-\d{2}\s+(?:[*!]\s+)?(.*)$/);
      if (!m) continue;
      const header = m[1];
      if (payee && !new RegExp(payee, "i").test(header)) continue;
      const pos = { sourceName: file, sourceLine: i + 1, sourceColumn: 1 };
      txns.push({ tsourcepos: [pos, pos] });
    }
  }
  return JSON.stringify(txns);
}

let monthFiles: string[] = [];
// When set, the fake hledger `print` returns this verbatim instead of scanning disk —
// used to exercise discover()'s handling of malformed or unexpected hledger output.
let printOverride: string | null = null;

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  rmSync(join(BASE, ".git"), { recursive: true, force: true });
  monthFiles = [];
  printOverride = null;

  vi.mocked(spawnText).mockImplementation(async (cmd, opts) => {
    if (cmd[0] === "git") {
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: opts?.cwd, encoding: "utf8" });
      if (r.error) throw r.error;
      return { exitCode: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    if (cmd.includes("print")) {
      const fileIdx = cmd.indexOf("-f");
      const outIdx = cmd.indexOf("-O");
      const terms = fileIdx >= 0 && outIdx >= 0 ? cmd.slice(fileIdx + 2, outIdx) : [];
      return { exitCode: 0, stdout: printOverride ?? fakeHledgerPrintJson(monthFiles, terms), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
});

function initRepoAndCommit(message: string): void {
  realGit(["init"], BASE);
  realGit(["config", "user.email", "test@test.com"], BASE);
  realGit(["config", "user.name", "Test"], BASE);
  realGit(["add", "-A"], BASE);
  realGit(["commit", "-m", message], BASE);
}

const ORIGINAL = [
  "2026-03-15 * Whole Foods | Groceries",
  "    Expenses:Uncategorized      45.00 USD",
  "    Assets:Checking            -45.00 USD",
  "",
].join("\n");

const RECATEGORIZED = [
  "2026-03-15 * Whole Foods | Groceries",
  "    Expenses:Food:Groceries     45.00 USD",
  "    Assets:Checking            -45.00 USD",
  "",
].join("\n");

describe("traceTransactions()", () => {
  test("should return the full revision chain, newest first, for a matched transaction", async () => {
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", ORIGINAL);
    monthFiles = ["2026/03.journal"];
    initRepoAndCommit("Add Whole Foods purchase");

    // A later, line-preserving edit (as modify_transactions would make) + commit.
    writeFileSync(join(LEDGER, "2026/03.journal"), RECATEGORIZED);
    realGit(["add", "-A"], BASE);
    realGit(["commit", "-m", "Recategorize Whole Foods to groceries"], BASE);

    const result = await traceTransactions(["payee:Whole Foods"]);

    expect(result.found).toBe(1);
    const [h] = result.histories;
    expect(h.startLine).toBe(1);
    expect(h.endLine).toBe(3);
    expect(h.revisions).toHaveLength(2);
    expect(h.revisions[0].message).toBe("Recategorize Whole Foods to groceries");
    expect(h.revisions[1].message).toBe("Add Whole Foods purchase");
  });

  test("should recover the original transaction text from the oldest revision", async () => {
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", ORIGINAL);
    monthFiles = ["2026/03.journal"];
    initRepoAndCommit("Add Whole Foods purchase");

    writeFileSync(join(LEDGER, "2026/03.journal"), RECATEGORIZED);
    realGit(["add", "-A"], BASE);
    realGit(["commit", "-m", "Recategorize"], BASE);

    const [h] = (await traceTransactions(["payee:Whole Foods"])).histories;
    const original = h.revisions[h.revisions.length - 1];

    expect(original.text).toContain("Expenses:Uncategorized");
    expect(h.currentText).toContain("Expenses:Food:Groceries");
    expect(h.currentText).not.toContain("Uncategorized");
  });

  test("should show a single revision for a transaction that was never edited", async () => {
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", ORIGINAL);
    monthFiles = ["2026/03.journal"];
    initRepoAndCommit("Add Whole Foods purchase");

    const [h] = (await traceTransactions(["payee:Whole Foods"])).histories;
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0].text).toContain("Expenses:Uncategorized");
  });

  test("should trace the correct lines for a transaction below others in the same file", async () => {
    const twoTxns = [
      "2026-03-15 * Whole Foods | Groceries",
      "    Expenses:Food     45.00 USD",
      "    Assets:Checking  -45.00 USD",
      "",
      "2026-03-16 * Shell | Fuel",
      "    Expenses:Uncategorized   60.00 USD",
      "    Assets:Checking         -60.00 USD",
      "",
    ].join("\n");
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", twoTxns);
    monthFiles = ["2026/03.journal"];
    initRepoAndCommit("Add two purchases");

    const [h] = (await traceTransactions(["payee:Shell"])).histories;
    expect(h.startLine).toBe(5);
    expect(h.endLine).toBe(7);
    expect(h.revisions[0].text).toContain("Shell | Fuel");
    expect(h.revisions[0].text).not.toContain("Whole Foods");
  });

  test("should return an empty history list when the query matches nothing", async () => {
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", ORIGINAL);
    monthFiles = ["2026/03.journal"];
    initRepoAndCommit("Add Whole Foods purchase");

    const result = await traceTransactions(["payee:Nonexistent"]);
    expect(result.found).toBe(0);
    expect(result.histories).toEqual([]);
  });

  test("should return an empty revision chain for an uncommitted transaction", async () => {
    seed("main.journal", "include 2026/03.journal\n");
    seed("2026/03.journal", ORIGINAL);
    monthFiles = ["2026/03.journal"];
    // Repo initialized but the journal is never committed.
    realGit(["init"], BASE);
    realGit(["config", "user.email", "test@test.com"], BASE);
    realGit(["config", "user.name", "Test"], BASE);

    const [h] = (await traceTransactions(["payee:Whole Foods"])).histories;
    expect(h.revisions).toEqual([]);
    expect(h.currentText).toContain("Whole Foods");
  });

  test.each([[[]], [[""]], [["-x"]]])("should reject invalid query %j", async (query) => {
    await expect(traceTransactions(query as string[])).rejects.toThrow();
  });

  test("should return no histories when hledger emits malformed JSON", async () => {
    printOverride = "not json{";
    const result = await traceTransactions(["payee:X"]);
    expect(result.found).toBe(0);
    expect(result.histories).toEqual([]);
  });

  test("should return no histories when hledger JSON is not an array", async () => {
    printOverride = JSON.stringify({ unexpected: true });
    const result = await traceTransactions(["payee:X"]);
    expect(result.found).toBe(0);
  });

  test("should skip a transaction whose source position cannot be parsed", async () => {
    // A match with no usable tsourcepos is dropped rather than crashing the trace.
    printOverride = JSON.stringify([{ tsourcepos: [] }, { tsourcepos: null }]);
    const result = await traceTransactions(["payee:X"]);
    expect(result.found).toBe(0);
  });
});
