import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BulkEditField, type BulkEditParams, type BulkEditResult, bulkEditTransactions } from "../ledger";
import { TOOL_LABELS } from "../tool-labels";

const Params = Type.Object({
  query: Type.Array(Type.String(), {
    minItems: 1,
    description:
      'hledger query terms targeting the transactions to edit, each an array element (ANDed), e.g. ["payee:EDEKA", "acct:expenses:uncategorized"] or ["date:2026-06", "desc:whole foods"]. Put a whole term (even with spaces) in one element; do not add quotes.',
  }),
  action: Type.Union(
    [
      Type.Literal("change_account"),
      Type.Literal("change_payee"),
      Type.Literal("set_status"),
      Type.Literal("set_tag"),
      Type.Literal("remove_tag"),
    ],
    {
      description:
        "The bulk edit to apply to every matching transaction: 'change_account' moves postings from account `from` to account `to`; 'change_payee' renames the payee `from` to `to`; 'set_status' sets the transaction status marker to `to`; 'set_tag' sets tag `tag` to value `to`; 'remove_tag' deletes tag `tag`.",
    },
  ),
  from: Type.Optional(
    Type.String({
      description:
        "Required for change_account and change_payee: the exact current value being replaced (the account of the posting to move, or the payee to rename). Acts as a guard: matched transactions whose value differs are left untouched, so a fuzzy query never edits the wrong ones. Not used by set_status, set_tag, or remove_tag.",
    }),
  ),
  tag: Type.Optional(
    Type.String({
      description: "Required for set_tag and remove_tag: the tag name. Not used by the other actions.",
    }),
  ),
  to: Type.String({
    description:
      "The new value: for change_account the new account (e.g. expenses:food:groceries); for change_payee the new payee name; for set_status one of 'cleared', 'pending', or 'unmarked'; for set_tag the tag's value (pass \"\" for a value-less tag). Not used by remove_tag (pass \"\" as a placeholder).",
  }),
  dry_run: Type.Optional(
    Type.Boolean({
      description: "Preview the diff and validation result without writing any changes (default false).",
    }),
  ),
});

/** Tool actions mapped onto the ledger layer's field vocabulary. */
const ACTION_FIELDS = {
  change_account: "account",
  change_payee: "payee",
  set_status: "status",
  set_tag: "tag_set",
  remove_tag: "tag_remove",
} as const;

/** Ledger-layer errors name BulkEditParams fields; resurface them under this tool's schema names. */
function renameParamsInError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  const msg = e.message
    .replace(/\bfrom_(?:account|payee)\b/g, "from")
    .replace(/\bnew_value\b/g, "to")
    .replace(/\btag_name\b/g, "tag");
  return msg === e.message ? e : new Error(msg);
}

/** Tag-action result text: a per-outcome breakdown so an overwrite is never silent
 * (see docs/proposals/bulk-edit-tags.md, "Auditability"). */
function formatTagSummary(result: BulkEditResult, tag: string): string {
  // The ledger layer always sets tagOutcomes when field is tag_set/tag_remove (the only
  // fields this function is ever called for) -- asserted, not defaulted, so a future
  // regression there fails loudly instead of silently reporting all-zero counts.
  const o = result.tagOutcomes as NonNullable<BulkEditResult["tagOutcomes"]>;
  const skippedNote = `couldn't safely locate the existing tag — see warnings`;

  if (result.field === "tag_set") {
    const changed = o.added + o.overwritten;
    const changeParts: string[] = [];
    if (o.added > 0) changeParts.push(`${o.added} newly`);
    if (o.overwritten > 0) changeParts.push(`${o.overwritten} value changed`);
    const changeSuffix = changeParts.length > 0 ? ` (${changeParts.join(", ")})` : "";

    const parts = [
      `${result.dryRun ? "Would tag" : "Tagged"} ${changed} transaction(s) with \`${tag}\`${changeSuffix}`,
    ];
    if (o.unchanged > 0) parts.push(`${o.unchanged} unchanged (already \`${tag}\`)`);
    if (o.skipped > 0) parts.push(`${o.skipped} skipped (${skippedNote})`);
    return `${parts.join(", ")} (query: ${result.query.join(" ")}).`;
  }

  const parts = [`${result.dryRun ? "Would remove" : "Removed"} tag \`${tag}\` from ${o.removed} transaction(s)`];
  if (o.unchanged > 0) parts.push(`${o.unchanged} already without it`);
  if (o.skipped > 0) parts.push(`${o.skipped} skipped (${skippedNote})`);
  return `${parts.join(", ")} (query: ${result.query.join(" ")}).`;
}

export const bulkEditTransactionsTool: ToolDefinition<typeof Params, BulkEditResult> = {
  name: "bulk_edit_transactions",
  label: TOOL_LABELS.bulk_edit_transactions,
  description:
    "Run an hledger query and apply one bulk edit to every matching transaction: change a posting's account, change the payee, set the status, or set/remove a tag. Edits are surgical; the ledger is validated and the whole batch reverts on error.",
  promptSnippet: "Bulk-edit transactions matching an hledger query (account, payee, status, or tags)",
  promptGuidelines: [
    "bulk_edit_transactions targets transactions with a standard hledger query (e.g. payee:, desc:, acct:, date:, status:, tag:), then applies one `action` to all of them.",
    "bulk_edit_transactions change_account moves postings whose account exactly equals `from` into `to`; other postings are never touched. Ensure `to` is declared in accounts.journal or the strict check fails and the whole batch reverts.",
    "bulk_edit_transactions change_payee renames the payee `from` (exact match) to `to`, preserving the date, status, description, and comments. Matched transactions with a different payee are left untouched, so a fuzzy query can never rename the wrong one.",
    "bulk_edit_transactions set_status sets the header status marker on every match: `to` is 'cleared' (*), 'pending' (!), or 'unmarked' (no marker). It assigns the status regardless of the current one; to restrict by current status, add a status: query term. Posting-level markers are left untouched.",
    "bulk_edit_transactions set_tag sets tag `tag` to value `to` (pass `to: \"\"` for a value-less tag) on every match, overwriting a different existing value; remove_tag deletes tag `tag` where present. Both only ever touch a dedicated `; tag: value` comment line — the shape this app's own tools always write. A tag that exists in some other shape (comma-separated with others, fused into the transaction's own description comment, or applied via an `apply tag` directive) is left untouched with a warning rather than risking a bad edit.",
    "bulk_edit_transactions query terms are case-insensitive regex substrings (payee:DB also matches 'GOLDBACH', desc:shell matches 'Michelle'); anchor to be precise, e.g. payee:^EDEKA$, and prefer narrow terms.",
    "For broad or unfamiliar queries, call bulk_edit_transactions with dry_run: true first to review the diff, then apply. Call commit_and_push after a batch of related edits.",
  ],
  // Serialize every ledger write: "sequential" makes pi run any batch containing this
  // tool one call at a time, so concurrent read/edit/write/validate cycles never
  // interleave on shared journal files.
  executionMode: "sequential",
  parameters: Params,

  async execute(_id, params, signal) {
    if (
      (params.action === "change_account" || params.action === "change_payee") &&
      (!params.from || params.from.trim() === "")
    ) {
      const noun = params.action === "change_account" ? "account" : "payee";
      throw new Error(`from is required for ${params.action}: the exact current ${noun} being replaced.`);
    }
    if ((params.action === "set_tag" || params.action === "remove_tag") && (!params.tag || params.tag.trim() === "")) {
      const verb = params.action === "set_tag" ? "set" : "remove";
      throw new Error(`tag is required for ${params.action}: the tag name to ${verb}.`);
    }

    const spec: BulkEditParams = {
      // Unknown actions (possible only when the schema is bypassed) fall through
      // verbatim so the ledger layer's "Unsupported field" error names them.
      field: (ACTION_FIELDS[params.action] ?? params.action) as BulkEditField,
      new_value: params.to,
      from_account: params.action === "change_account" ? params.from : undefined,
      from_payee: params.action === "change_payee" ? params.from : undefined,
      tag_name: params.action === "set_tag" || params.action === "remove_tag" ? params.tag : undefined,
    };

    let result: BulkEditResult;
    try {
      result = await bulkEditTransactions(params.query, spec, params.dry_run ?? false, signal);
    } catch (e) {
      throw renameParamsInError(e);
    }

    const lines: string[] = [];
    if (result.field === "tag_set" || result.field === "tag_remove") {
      lines.push(formatTagSummary(result, params.tag as string));
    } else {
      const verb = result.dryRun ? "Would modify" : "Modified";
      const detail =
        result.field === "account"
          ? `${result.postings} posting(s) across ${result.transactions} transaction(s) -> ${params.to}`
          : result.field === "payee"
            ? `${result.transactions} payee(s) renamed to "${params.to}"`
            : `${result.transactions} transaction(s) marked ${params.to}`;
      lines.push(`${verb}: ${detail} (query: ${result.query.join(" ")}).`);
    }

    if (result.dryRun) {
      lines.push(
        result.ledgerIsValid ? "Ledger would remain valid." : `Ledger would be INVALID:\n${result.validationError}`,
      );
    }
    for (const w of result.warnings) lines.push(`Warning: ${w}`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: result,
    };
  },
};
