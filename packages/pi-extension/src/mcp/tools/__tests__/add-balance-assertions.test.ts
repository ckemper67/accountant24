import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-addba-"));
const LEDGER = join(BASE, "ledger");
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  setBaseDir: () => {},
}));

const { addBalanceAssertionsSpec } = await import("../add-balance-assertions.js");

function textOf(r: CallToolResult): string {
  return r.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

const assertion = {
  date: "2026-03-31",
  account: "Assets:Bank:Checking",
  balance: { amount: 1234.56, currency: "USD" },
};

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("addBalanceAssertionsSpec.handler()", () => {
  test("should save one assertion as a standalone entry with the confirmed balance", async () => {
    const result = await addBalanceAssertionsSpec.handler({ assertions: [assertion] });
    expect(result.isError).toBeFalsy();
    const body = textOf(result);
    expect(body).toContain("Balance assertion saved to");
    expect(body).toContain("Assets:Bank:Checking");
    expect(body).toContain("= 1234.56 USD");
  });

  test("should summarize a multi-assertion batch", async () => {
    const result = await addBalanceAssertionsSpec.handler({
      assertions: [assertion, { ...assertion, account: "Assets:Cash", balance: { amount: 20, currency: "USD" } }],
    });
    expect(textOf(result)).toContain("2 balance assertions saved");
  });

  test("should surface an input-validation error as error content", async () => {
    const result = await addBalanceAssertionsSpec.handler({
      assertions: [{ ...assertion, account: "" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("missing an account");
  });

  test("should report a validation failure from hledger, not throw", async () => {
    vi.mocked(spawnText).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "balance assertion failed" });
    const result = await addBalanceAssertionsSpec.handler({ assertions: [assertion] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("balance assertion failed");
  });
});
