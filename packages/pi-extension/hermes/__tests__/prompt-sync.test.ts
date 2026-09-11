import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// reference/accountant-prompt.md is a hand-written port of system.md, not a
// generated copy -- and not a byte-identical one, on purpose. It renames
// every tool (pi names -> mcp__accountant__*), drops desktop-only sections
// (Workspace's plugins/sessions/app-settings, Mention directives, memory.md),
// and rewrites others for Hermes (Session start, native file reads, Memory
// pointing at Hermes' own memory instead of memory.md). A straight diff test
// would therefore always fail; a generator would need per-section override
// rules that are themselves fragile to maintain.
//
// This is a drift GUARD, not a drift PREVENTER: it pins a hash of system.md
// and fails the moment that file changes, so a human re-reviews
// accountant-prompt.md against the change before moving the pin. It does not
// verify the port is correct -- only that someone looked.
//
// On failure: diff system.md against its previous state (git log -p --
// packages/pi-extension/src/system-prompt/system.md), update
// accountant-prompt.md to match, then update EXPECTED_SHA below to the value
// this test prints.
const EXPECTED_SHA = "0a72c33d06b5";

const SYSTEM_MD = join(import.meta.dirname, "..", "..", "src", "system-prompt", "system.md");

function shortSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

describe("reference/accountant-prompt.md sync guard", () => {
  test("should force a re-review of the Hermes prompt when system.md changes", () => {
    const actual = shortSha256(readFileSync(SYSTEM_MD, "utf8"));
    expect(
      actual,
      actual === EXPECTED_SHA
        ? undefined
        : "system.md changed since accountant-prompt.md was last reviewed against it. " +
            "Diff system.md, update reference/accountant-prompt.md to match, then set " +
            `EXPECTED_SHA to "${actual}".`,
    ).toBe(EXPECTED_SHA);
  });
});
