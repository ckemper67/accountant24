import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";
import { commitAll } from "../../../workspace/git";

vi.mock("../../../spawn");
// Stub the workspace git commit -- covered for real in workspace/__tests__.
vi.mock("../../../workspace/git", () => ({ commitAll: vi.fn().mockResolvedValue(undefined), initRepo: vi.fn() }));

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-addtx-"));
const LEDGER = join(BASE, "ledger");
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  setBaseDir: () => {},
}));

// Real ledger/transactions.ts runs over a temp workspace; only the hledger
// subprocess (the post-write `check`) is mocked.
const { addTransactionsSpec } = await import("../add-transactions.js");

function textOf(r: CallToolResult): string {
  return r.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

const tx = {
  date: "2026-03-15",
  payee: "Whole Foods",
  description: "Groceries",
  postings: [
    { account: "Assets:Checking", amount: -45, currency: "USD" },
    { account: "Expenses:Food:Groceries", amount: 45, currency: "USD" },
  ],
};

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("addTransactionsSpec", () => {
  test("should not be marked read-only", () => {
    expect(addTransactionsSpec.config.annotations?.readOnlyHint).toBeFalsy();
  });
});

describe("addTransactionsSpec.handler()", () => {
  test("should save one transaction and echo the routed path and rendered entry", async () => {
    const result = await addTransactionsSpec.handler({ transactions: [tx] });
    expect(result.isError).toBeFalsy();
    const body = textOf(result);
    expect(body).toContain(join(LEDGER, "2026", "03.journal"));
    expect(body).toContain("2026-03-15 * Whole Foods | Groceries");
  });

  test("should commit the workspace after a successful write", async () => {
    await addTransactionsSpec.handler({ transactions: [tx] });
    expect(vi.mocked(commitAll)).toHaveBeenCalledWith(expect.any(String), "Add transactions");
  });

  test("should not commit when the write would leave the ledger invalid", async () => {
    vi.mocked(spawnText).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "unbalanced" });
    await addTransactionsSpec.handler({ transactions: [tx] });
    expect(vi.mocked(commitAll)).not.toHaveBeenCalled();
  });

  test("should summarize a multi-transaction batch as a numbered list", async () => {
    const result = await addTransactionsSpec.handler({
      transactions: [tx, { ...tx, date: "2026-04-01", payee: "EDEKA", description: undefined }],
    });
    expect(textOf(result)).toContain("2 transactions saved");
  });

  test("should report a post-write validation failure as error content and roll the write back", async () => {
    vi.mocked(spawnText).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "unbalanced transaction: 2026/03.journal:1",
    });
    const result = await addTransactionsSpec.handler({ transactions: [tx] });
    expect(result.isError).toBe(true);
    const body = textOf(result);
    expect(body).toContain("rolled back");
    expect(body).toContain("unbalanced transaction");
    // The monthly file didn't exist before this call, so a real rollback deletes
    // it again rather than leaving the unbalanced entry on disk.
    expect(existsSync(join(LEDGER, "2026", "03.journal"))).toBe(false);
  });

  test("should surface an input-validation error without touching disk", async () => {
    const result = await addTransactionsSpec.handler({
      transactions: [{ ...tx, postings: [tx.postings[0]] }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("At least 2 postings");
    expect(vi.mocked(spawnText)).not.toHaveBeenCalled();
  });
});
