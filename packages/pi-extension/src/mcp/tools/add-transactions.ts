import { z } from "zod";
// Deep imports, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import { type AddTransactionParams, addTransactions } from "../../ledger/transactions";
import { writerMutex } from "../mutex";
import type { McpToolSpec } from "../registry";
import { errorText, formatSaved, text } from "./_shared";

const posting = z.object({
  account: z.string().describe("Account name, e.g. Expenses:Food"),
  amount: z.number().describe("Amount -- negative for outflows (e.g. -45), positive for inflows"),
  currency: z.string().describe("Currency code, e.g. USD, EUR"),
});

const tag = z.object({
  name: z.string().describe("Tag name, e.g. groceries, related_file"),
  value: z.string().optional().describe("Tag value (omit for value-less tags)"),
});

const transaction = z.object({
  date: z.string().describe("Transaction date, YYYY-MM-DD"),
  payee: z
    .string()
    .describe('Payee name, e.g. Whole Foods. Use exactly "Unknown" when the user does not know the payee.'),
  description: z.string().optional().describe("Transaction description (omit when not provided)"),
  postings: z
    .array(posting)
    .min(2)
    .describe("At least 2 postings with explicit amounts and currencies; they must balance to zero"),
  tags: z
    .array(tag)
    .optional()
    .describe("Optional tags, each rendered as `; name:` or `; name: value`. The same name may repeat."),
});

const inputSchema = {
  transactions: z.array(transaction).min(1).describe("One or more transactions to add"),
};

export const addTransactionsSpec: McpToolSpec<typeof inputSchema> = {
  name: "add_transactions",
  config: {
    title: "Add transactions",
    description:
      "Add one or more transactions. Auto-routes each to the correct monthly journal, declares any " +
      "new commodity, and runs `hledger check --strict`. If the ledger then has errors the write is " +
      "LEFT on disk and the result says so with the diff -- fix it forward, do not assume nothing saved.",
    inputSchema,
  },
  handler(args) {
    return writerMutex.runExclusive(async () => {
      try {
        const result = await addTransactions(args.transactions as AddTransactionParams[]);
        return text(formatSaved("Transaction", result));
      } catch (err) {
        return errorText(err);
      }
    });
  },
};
