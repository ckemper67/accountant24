import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-validate-"));
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  MEMORY_PATH: join(BASE, "memory.md"),
  LEDGER_DIR: join(BASE, "ledger"),
  setBaseDir: () => {},
}));

const { validateSpec } = await import("../validate.js");

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("validateSpec", () => {
  test("should be marked read-only", () => {
    expect(validateSpec.config.annotations?.readOnlyHint).toBe(true);
  });
});

describe("validateSpec.handler()", () => {
  test("should report the ledger valid when `hledger check` exits 0", async () => {
    vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await validateSpec.handler({});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("The ledger is valid.");
  });

  test("should surface hledger's diagnostics as error content, not throw", async () => {
    vi.mocked(spawnText).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "unbalanced transaction in 2026/01.journal",
    });
    const result = await validateSpec.handler({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unbalanced transaction in 2026/01.journal");
  });

  test("should stringify a non-Error rejection into error content", async () => {
    vi.mocked(spawnText).mockRejectedValue("spawn blew up");
    const result = await validateSpec.handler({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("spawn blew up");
  });
});
