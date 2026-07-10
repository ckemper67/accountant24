import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchYahooDailyCloses, InvalidSymbolError, YahooFetchError } from "../yahoo";

// Yahoo's endpoint is the extension's only network call, so it is mocked here at
// the global `fetch` seam. Expected values are derived from the spec (UTC
// midnight UNIX seconds, exchange-local trading dates), not from the code.

function mockFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const fn = vi.fn(async (_url: string) => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function chartBody(overrides: {
  currency?: string;
  gmtoffset?: number;
  timestamp?: number[];
  close?: (number | null)[];
  error?: unknown;
  result?: unknown;
}) {
  if (overrides.error !== undefined) return { chart: { result: null, error: overrides.error } };
  if (overrides.result !== undefined) return { chart: { result: overrides.result, error: null } };
  return {
    chart: {
      error: null,
      result: [
        {
          meta: { currency: overrides.currency ?? "USD", gmtoffset: overrides.gmtoffset ?? 0 },
          timestamp: overrides.timestamp ?? [],
          indicators: { quote: [{ close: overrides.close ?? [] }] },
        },
      ],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchYahooDailyCloses()", () => {
  test("should query the hardcoded Yahoo chart host with UTC-midnight period bounds", async () => {
    const fn = mockFetch(chartBody({}));
    await fetchYahooDailyCloses("AAPL", "2026-01-01", "2026-01-03");

    const url = new URL(fn.mock.calls[0][0]);
    expect(url.origin).toBe("https://query1.finance.yahoo.com");
    expect(url.pathname).toBe("/v8/finance/chart/AAPL");
    expect(url.searchParams.get("interval")).toBe("1d");

    const period1 = Number(url.searchParams.get("period1"));
    const period2 = Number(url.searchParams.get("period2"));
    // period1 = start at 00:00 UTC; period2 = (end + 1 day) at 00:00 UTC.
    expect(new Date(period1 * 1000).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(period2 * 1000).toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });

  test("should reject a symbol containing a slash without calling fetch", async () => {
    const fn = mockFetch(chartBody({}));
    await expect(fetchYahooDailyCloses("../evil", "2026-01-01", "2026-01-02")).rejects.toBeInstanceOf(
      InvalidSymbolError,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test.each(["EVIL HOST", "a@b", "AAPL/../x", ""])("should reject the invalid symbol %j", async (symbol) => {
    mockFetch(chartBody({}));
    await expect(fetchYahooDailyCloses(symbol, "2026-01-01", "2026-01-02")).rejects.toBeInstanceOf(InvalidSymbolError);
  });

  test.each(["^GSPC", "EURUSD=X", "BRK-B", "BRK.B"])("should accept the valid Yahoo ticker %j", async (symbol) => {
    mockFetch(chartBody({}));
    await expect(fetchYahooDailyCloses(symbol, "2026-01-01", "2026-01-02")).resolves.toEqual({
      currency: "USD",
      points: [],
    });
  });

  test("should map each close to its exchange-local trading date and skip nulls", async () => {
    // 02:00 UTC on Jan 3 at a -5h exchange is 21:00 on Jan 2 -> trading date Jan 2.
    const t1 = Math.floor(Date.UTC(2026, 0, 3, 2, 0) / 1000);
    const t2 = Math.floor(Date.UTC(2026, 0, 4, 2, 0) / 1000);
    const t3 = Math.floor(Date.UTC(2026, 0, 5, 2, 0) / 1000);
    mockFetch(chartBody({ gmtoffset: -18000, timestamp: [t1, t2, t3], close: [100.5, null, 101.25] }));

    const result = await fetchYahooDailyCloses("AAPL", "2026-01-01", "2026-01-06");

    expect(result.points).toEqual([
      { date: "2026-01-02", close: 100.5 },
      { date: "2026-01-04", close: 101.25 },
    ]);
  });

  test("should report the currency from Yahoo metadata", async () => {
    mockFetch(chartBody({ currency: "EUR" }));
    const result = await fetchYahooDailyCloses("SAP.DE", "2026-01-01", "2026-01-02");
    expect(result.currency).toBe("EUR");
  });

  test("should surface Yahoo's structured error envelope", async () => {
    mockFetch(chartBody({ error: { code: "Not Found", description: "No data found, symbol may be delisted" } }), {
      ok: false,
      status: 404,
    });
    await expect(fetchYahooDailyCloses("NOPE", "2026-01-01", "2026-01-02")).rejects.toThrow(
      "No data found, symbol may be delisted",
    );
  });

  test("should throw on a non-ok response with no error envelope", async () => {
    mockFetch({}, { ok: false, status: 500 });
    await expect(fetchYahooDailyCloses("AAPL", "2026-01-01", "2026-01-02")).rejects.toThrow("HTTP 500");
  });

  test("should throw when the payload has no result", async () => {
    mockFetch(chartBody({ result: [] }));
    await expect(fetchYahooDailyCloses("AAPL", "2026-01-01", "2026-01-02")).rejects.toThrow("No price data");
  });

  test("should wrap a network/redirect failure as YahooFetchError", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("unexpected redirect");
    });
    vi.stubGlobal("fetch", fn);
    await expect(fetchYahooDailyCloses("AAPL", "2026-01-01", "2026-01-02")).rejects.toBeInstanceOf(YahooFetchError);
  });
});
