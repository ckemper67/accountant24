import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../spawn";

vi.mock("../../spawn");

const BASE = mkdtempSync(join(tmpdir(), "accountant24-fetchprices-"));
const LEDGER = join(BASE, "ledger");
vi.mock("../../config.js", () => ({
  ACCOUNTANT24_HOME: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

const { fetchPricesTool } = await import("../fetch-prices.js");

// The tool's execute takes (id, params, signal, onUpdate, ctx); this feature
// only uses the first three, so the last two are stubbed.
function run(params: Parameters<typeof fetchPricesTool.execute>[1]) {
  return fetchPricesTool.execute("id", params, new AbortController().signal, undefined, {} as never);
}

function firstText(content: { type: string }[]): string {
  const c = content[0] as { type: string; text?: string };
  return c.type === "text" ? (c.text ?? "") : "";
}

// A daily chart body with one close on 2026-01-02 (timestamp at UTC noon,
// gmtoffset 0 -> trading date 2026-01-02).
function bodyFor(close: number, currency = "USD") {
  return {
    chart: {
      error: null,
      result: [
        {
          meta: { currency, gmtoffset: 0 },
          timestamp: [Math.floor(Date.UTC(2026, 0, 2, 12, 0) / 1000)],
          indicators: { quote: [{ close: [close] }] },
        },
      ],
    },
  };
}

// Route the fetch mock by the ticker in the URL path.
function mockFetchBySymbol(map: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    const symbol = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return { ok: true, status: 200, json: async () => map[symbol] };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, "main.journal"), "include commodities.journal\ninclude prices.journal\n");
  writeFileSync(join(LEDGER, "commodities.journal"), "; Commodity declarations\n");
  writeFileSync(join(LEDGER, "prices.journal"), "; Market price history\n");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPricesTool.execute()", () => {
  test("should fetch each mapping and write P directives under its ledger commodity", async () => {
    mockFetchBySymbol({ AAPL: bodyFor(150.25), VTSAX: bodyFor(100.5) });

    const result = await run({
      prices: [
        { commodity: "AAPL", symbol: "AAPL" },
        { commodity: "VTSAX", symbol: "VTSAX" },
      ],
      start: "2026-01-01",
      end: "2026-01-03",
    });

    expect(result.details?.pricesAdded).toBe(2);
    const prices = readFileSync(join(LEDGER, "prices.journal"), "utf-8");
    expect(prices).toContain("P 2026-01-02 AAPL 150.25 USD");
    expect(prices).toContain("P 2026-01-02 VTSAX 100.50 USD");
    expect(firstText(result.content)).toContain("Added 2 price(s) for AAPL, VTSAX");
  });

  test("should default the end date to today when omitted", async () => {
    const fn = mockFetchBySymbol({ AAPL: bodyFor(150) });

    await run({ prices: [{ commodity: "AAPL", symbol: "AAPL" }], start: "2026-01-01" });

    const url = new URL(fn.mock.calls[0][0]);
    const period2 = Number(url.searchParams.get("period2"));
    const [ty, tm, td] = new Date().toISOString().slice(0, 10).split("-").map(Number);
    // period2 is (end + 1 day) at 00:00 UTC; end defaults to today. Month is
    // 1-based here, so pass tm-1 to Date.UTC.
    const expected = Math.floor(Date.UTC(ty, tm - 1, td) / 1000) + 86400;
    expect(period2).toBe(expected);
  });

  test("should reject a malformed start date before any fetch", async () => {
    const fn = mockFetchBySymbol({});
    await expect(run({ prices: [{ commodity: "AAPL", symbol: "AAPL" }], start: "01/01/2026" })).rejects.toThrow(
      "Invalid start date",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test("should reject when end is before start", async () => {
    mockFetchBySymbol({ AAPL: bodyFor(150) });
    await expect(
      run({ prices: [{ commodity: "AAPL", symbol: "AAPL" }], start: "2026-02-01", end: "2026-01-01" }),
    ).rejects.toThrow("before start");
  });

  test("should propagate a Yahoo fetch error", async () => {
    mockFetchBySymbol({
      NOPE: { chart: { result: null, error: { code: "Not Found", description: "delisted" } } },
    });
    await expect(
      run({ prices: [{ commodity: "NOPE", symbol: "NOPE" }], start: "2026-01-01", end: "2026-01-02" }),
    ).rejects.toThrow("delisted");
  });
});
