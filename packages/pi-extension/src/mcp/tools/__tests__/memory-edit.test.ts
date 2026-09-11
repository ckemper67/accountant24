import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-mem-"));
const MEMORY = join(BASE, "memory.md");
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: join(BASE, "ledger"),
  MEMORY_PATH: MEMORY,
  setBaseDir: () => {},
}));

const { applyMemoryEdit, memoryEditSpec } = await import("../memory-edit.js");

function textOf(r: CallToolResult): string {
  return r.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

function gitLog(): string {
  return execFileSync("git", ["log", "--oneline"], { cwd: BASE, encoding: "utf8" });
}

describe("applyMemoryEdit()", () => {
  test("should return newText verbatim when memory is empty and oldText is empty", () => {
    expect(applyMemoryEdit("", "", "## Defaults\n- currency: EUR\n")).toBe("## Defaults\n- currency: EUR\n");
  });

  test("should reject a non-empty oldText against empty memory", () => {
    expect(() => applyMemoryEdit("   \n", "something", "x")).toThrow("memory.md is empty");
  });

  test("should require oldText when memory has content", () => {
    expect(() => applyMemoryEdit("## A\n- one\n", "", "anything")).toThrow("oldText is required");
  });

  test("should reject an oldText that spans the whole file", () => {
    const cur = "## A\n- one\n";
    expect(() => applyMemoryEdit(cur, cur, "## B\n- two\n")).toThrow("wholesale rewrite");
  });

  test("should reject an oldText that is not present", () => {
    expect(() => applyMemoryEdit("## A\n- one\n", "- two", "- three")).toThrow("was not found");
  });

  test("should reject an oldText that appears more than once", () => {
    expect(() => applyMemoryEdit("- x\n- y\n- x\n", "- x\n", "- z\n")).toThrow("more than once");
  });

  test("should replace exactly the single matched occurrence, keeping the rest", () => {
    const cur = "## Defaults\n- currency: EUR\n- rounding: 2\n";
    expect(applyMemoryEdit(cur, "- currency: EUR\n", "- currency: USD\n")).toBe(
      "## Defaults\n- currency: USD\n- rounding: 2\n",
    );
  });
});

describe("memoryEditSpec.handler()", () => {
  beforeEach(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: BASE });
    for (const [k, v] of [
      ["user.email", "test@test.com"],
      ["user.name", "Test"],
    ]) {
      execFileSync("git", ["config", k, v], { cwd: BASE });
    }
  });

  afterEach(() => rmSync(BASE, { recursive: true, force: true }));

  test("should not be marked read-only", () => {
    expect(memoryEditSpec.config.annotations?.readOnlyHint).toBeFalsy();
  });

  test("should create memory.md from empty and commit it", async () => {
    const r = await memoryEditSpec.handler({ oldText: "", newText: "## Defaults\n- currency: EUR\n" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(MEMORY, "utf8")).toBe("## Defaults\n- currency: EUR\n");
    expect(gitLog()).toContain("Update memory");
  });

  test("should apply a targeted edit and return a diff", async () => {
    writeFileSync(MEMORY, "## Defaults\n- currency: EUR\n- rounding: 2\n");
    const r = await memoryEditSpec.handler({ oldText: "- currency: EUR\n", newText: "- currency: USD\n" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(MEMORY, "utf8")).toBe("## Defaults\n- currency: USD\n- rounding: 2\n");
    const body = textOf(r);
    expect(body).toContain("-2 - currency: EUR");
    expect(body).toContain("+2 - currency: USD");
  });

  test("should refuse a wholesale rewrite of non-empty memory as error content", async () => {
    writeFileSync(MEMORY, "## Defaults\n- currency: EUR\n");
    const r = await memoryEditSpec.handler({
      oldText: "## Defaults\n- currency: EUR\n",
      newText: "totally different\n",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("wholesale rewrite");
    expect(readFileSync(MEMORY, "utf8")).toBe("## Defaults\n- currency: EUR\n");
  });

  test("should refuse an ambiguous anchor as error content", async () => {
    writeFileSync(MEMORY, "- x\n- y\n- x\n");
    const r = await memoryEditSpec.handler({ oldText: "- x\n", newText: "- z\n" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("more than once");
  });

  test("should report no change when oldText and newText are identical", async () => {
    writeFileSync(MEMORY, "## Defaults\n- currency: EUR\n- rounding: 2\n");
    const r = await memoryEditSpec.handler({ oldText: "- rounding: 2\n", newText: "- rounding: 2\n" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("unchanged");
  });

  test("should surface a filesystem error as error content, not throw", async () => {
    // memory.md is a directory: reading it yields "" (treated as empty) and the
    // write then fails -- the handler must report it, not crash.
    mkdirSync(MEMORY);
    const r = await memoryEditSpec.handler({ oldText: "", newText: "hello\n" });
    expect(r.isError).toBe(true);
  });
});
