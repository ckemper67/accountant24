import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "accountant24-mcp-addpx-"));
const LEDGER = join(BASE, "ledger");
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_WORKSPACE: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  setBaseDir: () => {},
}));

const { addPricesSpec } = await import("../add-prices.js");

function textOf(r: CallToolResult): string {
  return r.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

const price = { date: "2026-03-15", commodity: "BTC", price: { amount: 65000, commodity: "EUR" } };

beforeEach(() => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("addPricesSpec.handler()", () => {
  test("should save one price as a P directive", async () => {
    const result = await addPricesSpec.handler({ prices: [price] });
    expect(result.isError).toBeFalsy();
    const body = textOf(result);
    expect(body).toContain("Price saved to");
    expect(body).toContain("P 2026-03-15 BTC 65000 EUR");
  });

  test("should summarize a multi-price batch", async () => {
    const result = await addPricesSpec.handler({
      prices: [price, { ...price, commodity: "ETH", price: { amount: 3200, commodity: "EUR" } }],
    });
    expect(textOf(result)).toContain("2 prices saved");
  });

  test("should reject a non-positive price as error content", async () => {
    const result = await addPricesSpec.handler({
      prices: [{ ...price, price: { amount: 0, commodity: "EUR" } }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("must be positive");
  });
});
