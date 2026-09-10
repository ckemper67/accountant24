import { z } from "zod";
// Deep imports, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import { type AddBalanceAssertionParams, addBalanceAssertions } from "../../ledger/transactions";
import { writerMutex } from "../mutex";
import type { McpToolSpec } from "../registry";
import { errorText, formatSaved, text } from "./_shared";

const assertion = z.object({
  date: z.string().describe("Assertion date, YYYY-MM-DD, usually today"),
  account: z.string().describe("Account whose balance the user confirmed, e.g. Assets:Bank:Checking"),
  balance: z
    .object({
      amount: z.number().describe("The confirmed total balance of the account"),
      currency: z.string().describe("Currency code of the balance, e.g. USD, EUR"),
    })
    .describe("The account's actual balance, as stated by the user"),
});

const inputSchema = {
  assertions: z.array(assertion).min(1).describe("One or more balance assertions to record"),
};

export const addBalanceAssertionsSpec: McpToolSpec<typeof inputSchema> = {
  name: "add_balance_assertions",
  config: {
    title: "Record balance assertions",
    description:
      "Record balance assertions: standalone checkpoint entries stating an account's confirmed " +
      "balance. Always a standalone entry, never attached to a transaction. hledger verifies each " +
      "on save and rejects the write when the ledger disagrees, so first compare the stated balance " +
      "with `query` and only assert once they match.",
    inputSchema,
  },
  handler(args) {
    return writerMutex.runExclusive(async () => {
      try {
        const result = await addBalanceAssertions(args.assertions as AddBalanceAssertionParams[]);
        return text(formatSaved("Balance assertion", result));
      } catch (err) {
        return errorText(err);
      }
    });
  },
};
