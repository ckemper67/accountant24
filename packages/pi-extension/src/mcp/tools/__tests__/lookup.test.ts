import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-lookup-"));
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  MEMORY_PATH: join(BASE, "memory.md"),
  LEDGER_DIR: join(BASE, "ledger"),
  setBaseDir: () => {},
}));

const { lookupSpec } = await import("../lookup.js");

function mockHledger(stdout: string, exitCode = 0): void {
  vi.mocked(spawnText).mockResolvedValue({ exitCode, stdout, stderr: "" });
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("lookupSpec", () => {
  test("should be marked read-only", () => {
    expect(lookupSpec.config.annotations?.readOnlyHint).toBe(true);
  });
});

describe("lookupSpec.handler()", () => {
  test("should return declared accounts, one per line, sorted case-insensitively", async () => {
    mockHledger("Expenses:Food\nAssets:Bank\nexpenses:travel\n");
    const result = await lookupSpec.handler({ kind: "accounts" });
    expect(textOf(result)).toBe("Assets:Bank\nExpenses:Food\nexpenses:travel");
  });

  test("should call `hledger accounts` for kind=accounts", async () => {
    mockHledger("Assets:Bank\n");
    await lookupSpec.handler({ kind: "accounts" });
    expect(vi.mocked(spawnText).mock.calls[0][0]).toEqual(expect.arrayContaining(["hledger", "accounts"]));
  });

  test("should call `hledger payees` for kind=payees", async () => {
    mockHledger("EDEKA\n");
    const result = await lookupSpec.handler({ kind: "payees" });
    expect(vi.mocked(spawnText).mock.calls[0][0]).toEqual(expect.arrayContaining(["hledger", "payees"]));
    expect(textOf(result)).toBe("EDEKA");
  });

  test("should call `hledger tags` for kind=tags", async () => {
    mockHledger("groceries\nsource\n");
    const result = await lookupSpec.handler({ kind: "tags" });
    expect(vi.mocked(spawnText).mock.calls[0][0]).toEqual(expect.arrayContaining(["hledger", "tags"]));
    expect(textOf(result)).toBe("groceries\nsource");
  });

  test("should return a `(no ...)` placeholder when the list is empty", async () => {
    mockHledger("");
    expect(textOf(await lookupSpec.handler({ kind: "payees" }))).toBe("(no payees)");
  });

  test("should return a `(no ...)` placeholder when hledger fails", async () => {
    mockHledger("", 1);
    expect(textOf(await lookupSpec.handler({ kind: "tags" }))).toBe("(no tags)");
  });
});
