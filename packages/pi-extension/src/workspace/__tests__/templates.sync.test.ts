import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The MCP server's scaffold templates are byte-for-byte copies of the desktop
// app's. This test fails loudly if the desktop originals change without the
// copies being updated (or vice versa), so the two workspaces never diverge.

const MCP_DIR = join(import.meta.dirname, "..", "templates");
const DESKTOP_DIR = join(import.meta.dirname, "..", "..", "..", "..", "desktop", "src", "main", "template");

const PAIRS: Array<[mcp: string, desktop: string]> = [
  ["gitignore.tmpl", ".gitignore"],
  ["ledger/accounts.journal", "ledger/accounts.journal"],
  ["ledger/commodities.journal", "ledger/commodities.journal"],
  ["ledger/main.journal", "ledger/main.journal"],
];

describe("scaffold templates", () => {
  test.each(PAIRS)("%s should match the desktop template byte-for-byte", (mcpRel, desktopRel) => {
    const mcp = readFileSync(join(MCP_DIR, mcpRel), "utf8");
    const desktop = readFileSync(join(DESKTOP_DIR, desktopRel), "utf8");
    expect(mcp).toBe(desktop);
  });

  test("the desktop memory.md template is empty, matching the MCP scaffold's inline default", () => {
    expect(readFileSync(join(DESKTOP_DIR, "memory.md"), "utf8")).toBe("");
  });
});
