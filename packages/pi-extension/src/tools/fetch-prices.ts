import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchYahooDailyCloses, type PriceEntry, type WritePricesResult, writePrices } from "../ledger";

const Mapping = Type.Object({
  commodity: Type.String({ description: "Ledger commodity symbol as used in transactions, e.g. VTSAX, AAPL" }),
  symbol: Type.String({ description: "Yahoo Finance ticker to fetch, e.g. VTSAX, AAPL, ^GSPC, EURUSD=X" }),
});

const Params = Type.Object({
  prices: Type.Array(Mapping, {
    minItems: 1,
    description: "Commodity-to-Yahoo-ticker mappings to fetch daily closing prices for",
  }),
  start: Type.String({ description: "Start date inclusive, YYYY-MM-DD" }),
  end: Type.Optional(Type.String({ description: "End date inclusive, YYYY-MM-DD (default: today)" })),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today's calendar date (YYYY-MM-DD) in the local timezone. Uses the local
 * date parts rather than `toISOString()` (which is UTC) so the default `end`
 * matches the user's actual current day instead of drifting a day near
 * midnight in non-UTC timezones.
 */
function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const LABEL = "Fetch Prices";

export const fetchPricesTool: ToolDefinition<typeof Params, WritePricesResult> = {
  name: "fetch_prices",
  label: LABEL,
  description:
    "Fetch historical daily closing prices for stocks/funds from Yahoo Finance and append them as hledger P price directives to prices.journal.",
  promptSnippet: "Fetch historical stock/fund prices from Yahoo (writes P directives to prices.journal)",
  promptGuidelines: [
    "fetch_prices downloads daily closing prices from Yahoo Finance. Each mapping's `commodity` must exactly match the commodity symbol used in the ledger's transactions; `symbol` is the Yahoo ticker (e.g. AAPL, VTSAX, ^GSPC, EURUSD=X).",
    "Record any commodity-to-Yahoo-ticker mapping in memory (update_memory) so future price refreshes need no lookup.",
  ],
  parameters: Params,

  async execute(_id, params, signal) {
    const start = params.start;
    const end = params.end ?? todayLocal();
    if (!DATE_RE.test(start)) throw new Error(`Invalid start date: ${start}. Expected YYYY-MM-DD.`);
    if (!DATE_RE.test(end)) throw new Error(`Invalid end date: ${end}. Expected YYYY-MM-DD.`);
    if (end < start) throw new Error(`end (${end}) is before start (${start}).`);

    const entries: PriceEntry[] = [];
    for (const { commodity, symbol } of params.prices) {
      const { currency, points } = await fetchYahooDailyCloses(symbol, start, end, signal);
      entries.push({ commodity, currency, points });
    }

    const result = await writePrices(entries, signal);

    const names = params.prices.map((p) => p.commodity).join(", ");
    const skippedNote = result.skipped > 0 ? ` (${result.skipped} already present)` : "";
    const text = `Added ${result.pricesAdded} price(s) for ${names}${skippedNote}.`;

    return {
      content: [{ type: "text", text }],
      details: result,
    };
  },
};
