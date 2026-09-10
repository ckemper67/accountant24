import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-query-"));
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  MEMORY_PATH: join(BASE, "memory.md"),
  LEDGER_DIR: join(BASE, "ledger"),
  setBaseDir: () => {},
}));

// Mock at the I/O boundary (spawnText) so the real ledger/query.ts runs.
const { querySpec } = await import("../query.js");

function mockHledger(stdout: string, exitCode = 0, stderr = ""): void {
  vi.mocked(spawnText).mockResolvedValue({ exitCode, stdout, stderr });
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("querySpec", () => {
  test("should be marked read-only so a writer-only gate ignores it", () => {
    expect(querySpec.config.annotations?.readOnlyHint).toBe(true);
  });

  test("should not expose a `file` parameter (no LLM-supplied journal path)", () => {
    expect(querySpec.config.inputSchema).not.toHaveProperty("file");
  });
});

describe("querySpec.handler()", () => {
  test("should return the hledger output as text content", async () => {
    mockHledger("100 USD  Expenses:Food");
    const result = await querySpec.handler({ report: "bal" });
    expect(textOf(result)).toBe("100 USD  Expenses:Food");
  });

  test("should return (no results) when hledger produces no output", async () => {
    mockHledger("");
    const result = await querySpec.handler({ report: "bal" });
    expect(textOf(result)).toBe("(no results)");
  });

  test("should forward structured filters to hledger", async () => {
    mockHledger("ok");
    await querySpec.handler({ report: "reg", account_pattern: "Expenses:Food", tag: "groceries" });
    const args = vi.mocked(spawnText).mock.calls[0][0];
    expect(args).toContain("Expenses:Food");
    expect(args).toContain("tag:groceries");
  });

  test("should resolve the journal inside the ledger dir, never the workspace root", async () => {
    mockHledger("ok");
    await querySpec.handler({ report: "bal" });
    const args = vi.mocked(spawnText).mock.calls[0][0];
    expect(args).toContain(join(BASE, "ledger", "main.journal"));
  });

  test("should spill a large result to a scratch file and return only a preview", async () => {
    const big = `${Array(6000).fill("Expenses:Food      100 USD").join("\n")}\n`;
    mockHledger(big);
    const result = await querySpec.handler({ report: "print" });
    const text = textOf(result);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("Preview only");
    expect(text).toMatch(/written to .+query-\d+-\d+\.txt/);
  });

  test("should surface an hledger failure as error content, not throw", async () => {
    mockHledger("", 1, "hledger: Error: this regexp is malformed");
    const result = await querySpec.handler({ report: "reg", account_pattern: "[" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("this regexp is malformed");
  });

  test("should surface a path-confinement rejection as error content", async () => {
    mockHledger("ok");
    // `file` is not in the schema, but a bypassing caller could still pass it;
    // the ledger layer rejects the escape and the wrapper must not throw.
    const result = await querySpec.handler({ report: "bal", file: "../auth.json" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Path escapes base directory");
  });

  test("should stringify a non-Error rejection into error content", async () => {
    vi.mocked(spawnText).mockRejectedValue("spawn blew up");
    const result = await querySpec.handler({ report: "bal" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("spawn blew up");
  });
});
