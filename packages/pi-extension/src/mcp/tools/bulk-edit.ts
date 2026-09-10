import { z } from "zod";
// Deep imports, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import {
  type BulkEditField,
  type BulkEditParams,
  type BulkEditResult,
  bulkEditTransactions,
} from "../../ledger/bulk-edit";
import { writerMutex } from "../mutex";
import type { McpToolSpec } from "../registry";
import { errorText, text } from "./_shared";

const inputSchema = {
  query: z
    .array(z.string())
    .min(1)
    .describe(
      "hledger query terms selecting the transactions to edit, one per array element (ANDed), " +
        'e.g. ["payee:EDEKA", "acct:expenses:uncategorized"]. Terms are case-insensitive regex ' +
        "substrings, so anchor to be precise (payee:^EDEKA$). Put a whole term in one element; add no quotes.",
    ),
  action: z
    .enum(["change_account", "change_payee", "set_status"])
    .describe(
      "change_account moves postings whose account exactly equals `from` into `to` (declare `to` in " +
        "accounts.journal first). change_payee renames the payee `from` (exact match) to `to`, keeping " +
        "date/status/description/comments. set_status sets every match's header marker to `to`.",
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Required for change_account and change_payee: the exact current value being replaced. Acts as " +
        "a guard -- matched transactions whose value differs are left untouched. Unused by set_status.",
    ),
  to: z
    .string()
    .describe(
      "The new value: a new account (change_account), a new payee name (change_payee), or one of " +
        "'cleared' / 'pending' / 'unmarked' (set_status).",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview the diff and validation result without writing anything (default false)."),
};

/** Tool actions mapped onto the ledger layer's field vocabulary. */
const ACTION_FIELDS: Record<string, BulkEditField> = {
  change_account: "account",
  change_payee: "payee",
  set_status: "status",
};

/** Ledger-layer errors name BulkEditParams fields; resurface them under this tool's schema names. */
function renameParamsInError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message.replace(/\bfrom_(?:account|payee)\b/g, "from").replace(/\bnew_value\b/g, "to");
  return msg === err.message ? err : new Error(msg);
}

function summarize(result: BulkEditResult, to: string): string {
  const verb = result.dryRun ? "Would modify" : "Modified";
  const detail =
    result.field === "account"
      ? `${result.postings} posting(s) across ${result.transactions} transaction(s) -> ${to}`
      : result.field === "payee"
        ? `${result.transactions} payee(s) renamed to "${to}"`
        : `${result.transactions} transaction(s) marked ${to}`;

  const lines = [`${verb}: ${detail} (query: ${result.query.join(" ")}).`];
  if (result.dryRun) {
    lines.push(
      result.ledgerIsValid ? "Ledger would remain valid." : `Ledger would be INVALID:\n${result.validationError}`,
    );
  }
  for (const w of result.warnings) lines.push(`Warning: ${w}`);
  return lines.join("\n");
}

export const bulkEditSpec: McpToolSpec<typeof inputSchema> = {
  name: "bulk_edit",
  config: {
    title: "Bulk-edit transactions",
    description:
      "Run an hledger query and apply one edit to every matching transaction: change a posting's " +
      "account, change the payee, or set the status. Edits are surgical (date, description, and " +
      "comments are preserved). The whole ledger is validated afterwards and the ENTIRE batch " +
      "reverts if it would be invalid. For broad or unfamiliar queries, run with dry_run: true first.",
    inputSchema,
  },
  handler(args) {
    return writerMutex.runExclusive(async () => {
      const action = args.action as string;
      const from = args.from as string | undefined;
      const to = args.to as string;
      const query = args.query as string[];
      const dryRun = (args.dry_run as boolean | undefined) ?? false;

      if (action !== "set_status" && (!from || from.trim() === "")) {
        const noun = action === "change_account" ? "account" : "payee";
        return errorText(new Error(`from is required for ${action}: the exact current ${noun} being replaced.`));
      }

      const spec: BulkEditParams = {
        // An unknown action (only reachable if the schema is bypassed) falls
        // through so the ledger layer's "Unsupported field" error names it.
        field: (ACTION_FIELDS[action] ?? action) as BulkEditField,
        new_value: to,
        from_account: action === "change_account" ? from : undefined,
        from_payee: action === "change_payee" ? from : undefined,
      };

      try {
        const result = await bulkEditTransactions(query, spec, dryRun);
        return text(summarize(result, to));
      } catch (err) {
        return errorText(renameParamsInError(err));
      }
    });
  },
};
