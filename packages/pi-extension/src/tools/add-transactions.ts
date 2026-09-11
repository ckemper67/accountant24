import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AddTransactionsResult, addTransactions } from "../ledger";
import { TOOL_LABELS } from "../tool-labels";

const Posting = Type.Object({
  account: Type.String({ description: "Account name, e.g. Expenses:Food" }),
  amount: Type.Number({
    description:
      "Amount, or commodity quantity for a commodity posting (e.g. 684 shares) — use negative for outflows (e.g. -45), positive for inflows",
  }),
  currency: Type.String({ description: "Currency code, e.g. USD, EUR — or a commodity symbol, e.g. STRIPE, BTC" }),
  unitPrice: Type.Optional(
    Type.Object(
      {
        amount: Type.Number({ description: "Price of one unit of this posting's commodity" }),
        currency: Type.String({ description: "Currency the price is quoted in, e.g. USD" }),
      },
      {
        description:
          "The price of one unit of this posting's commodity — renders as `@ price currency`. Set when buying or " +
          "selling a commodity (stock, crypto, foreign cash) at a specific rate; omit for plain currency postings.",
      },
    ),
  ),
  lotCost: Type.Optional(
    Type.Object(
      {
        amount: Type.Number({ description: "Cost basis of one unit of this posting's commodity" }),
        currency: Type.String({ description: "Currency the cost basis is quoted in, e.g. USD" }),
      },
      {
        description:
          "Fixes this posting's cost basis for lot matching — renders as `{price currency}`. Set when buying a " +
          "commodity to hold as an investment (usually the same value as `unitPrice`); when selling, set it to the " +
          "original lot's cost basis (its `unitPrice` at purchase) so hledger can match the lot and compute capital gains.",
      },
    ),
  ),
});

const Tag = Type.Object({
  name: Type.String({ description: "Tag name, e.g. groceries, related_file" }),
  value: Type.Optional(Type.String({ description: "Tag value (omit for value-less tags)" })),
});

const Transaction = Type.Object({
  date: Type.String({ description: "Transaction date in YYYY-MM-DD format" }),
  payee: Type.String({
    description:
      'Payee name, e.g. Whole Foods. Use exactly "Unknown" when the user does not know or remember the payee.',
  }),
  description: Type.Optional(
    Type.String({ description: "Transaction description (omit when not provided by the user)" }),
  ),
  postings: Type.Array(Posting, {
    minItems: 2,
    description: "At least 2 postings with explicit amounts and currencies",
  }),
  tags: Type.Optional(
    Type.Array(Tag, {
      description:
        "Optional tags — each rendered as `; name:` or `; name: value`. The same name may appear multiple times.",
    }),
  ),
});

const Params = Type.Object({
  transactions: Type.Array(Transaction, {
    minItems: 1,
    description: "One or more transactions to add",
  }),
});

export const addTransactionsTool: ToolDefinition<typeof Params, AddTransactionsResult> = {
  name: "add_transactions",
  label: TOOL_LABELS.add_transactions,
  description: "Add one or more transactions. Auto-routes to the correct monthly files and validates.",
  promptSnippet: "Record transactions (auto-routes to monthly files, validates)",
  promptGuidelines: [
    "Buying or selling a commodity (stock, crypto, foreign cash) is a transaction with a posting carrying a " +
      "commodity quantity and currency (e.g. amount: 684, currency: STRIPE) plus `unitPrice`/`lotCost` for the " +
      "cost annotation — never hand-edit the journal for this.",
  ],
  // Serialize every ledger write: "sequential" makes pi run any batch containing this
  // tool one call at a time, so concurrent read/edit/write/validate cycles never
  // interleave on shared journal files.
  executionMode: "sequential",
  parameters: Params,

  async execute(_id, params, signal) {
    const result = await addTransactions(params.transactions, signal);

    let text: string;
    if (result.transactions.length === 1) {
      const tx = result.transactions[0];
      text = `Transaction saved to ${tx.fullFilePath}:\n\n${tx.transactionText}`;
    } else {
      const parts = result.transactions.map((tx, i) => `${i + 1}. ${tx.fullFilePath}:\n\n${tx.transactionText}`);
      text = `${result.transactions.length} transactions saved:\n\n${parts.join("\n\n")}`;
    }

    return {
      content: [{ type: "text", text }],
      details: result,
    };
  },
};
