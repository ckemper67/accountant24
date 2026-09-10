import { z } from "zod";
// Deep imports, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import { type AddPriceParams, addPrices } from "../../ledger/transactions";
import { writerMutex } from "../mutex";
import type { McpToolSpec } from "../registry";
import { errorText, formatSaved, text } from "./_shared";

const price = z.object({
  date: z.string().describe("Date the price was observed, YYYY-MM-DD, usually today"),
  commodity: z.string().describe("Commodity being priced, e.g. USD, BTC, AAPL"),
  price: z
    .object({
      amount: z.number().describe("Price of one unit of the commodity (must be positive)"),
      commodity: z.string().describe("Commodity the price is quoted in, usually the user's main currency, e.g. EUR"),
    })
    .describe("The market price of one unit of the commodity"),
});

const inputSchema = {
  prices: z.array(price).min(1).describe("One or more market prices to record"),
};

export const addPricesSpec: McpToolSpec<typeof inputSchema> = {
  name: "add_prices",
  config: {
    title: "Record market prices",
    description:
      "Record market prices as hledger P directives: what one unit of a commodity was worth on a " +
      "date. Auto-routes to the correct monthly journal and validates. A price is a standalone " +
      "directive, not a transaction; record one toward the user's main currency when they state a " +
      "price (purchases already imply a price through their cost).",
    inputSchema,
  },
  handler(args) {
    return writerMutex.runExclusive(async () => {
      try {
        const result = await addPrices(args.prices as AddPriceParams[]);
        return text(formatSaved("Price", result));
      } catch (err) {
        return errorText(err);
      }
    });
  },
};
