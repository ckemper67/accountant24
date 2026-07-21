import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImportResult } from "../import/import";
import { renderImportResult, runRowImport } from "../import/import";

const Row = Type.Object({
  date: Type.String({
    description:
      "Raw date string EXACTLY as it appears, e.g. 15.01.2025 or 01/15/2025. " +
      "Do NOT reformat or convert to ISO -- the tool normalizes dates itself; reformatting risks corruption.",
  }),
  amount: Type.String({
    description:
      "Raw amount string EXACTLY as it appears, e.g. -1.234,56 or (45.00). " +
      "Negative (or parenthesized/DR/S) = outflow, positive = inflow. " +
      "Do NOT convert the number (no decimal/thousands changes) -- the tool parses locale formats itself.",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Transaction description / memo, if any. Transcribe verbatim from the statement text -- exact wording " +
        "matters for deduplication: re-importing the same statement later matches on (account, date, amount) " +
        "when the description text differs at all between runs, which only flags a possible duplicate for " +
        "review rather than skipping it outright.",
    }),
  ),
  payee: Type.Optional(Type.String({ description: "Payee / merchant name, if identifiable" })),
  currency: Type.Optional(Type.String({ description: "Per-row currency code; omit to use the statement currency" })),
});

const Params = Type.Object({
  account: Type.String({
    description: "Ledger account the statement belongs to, e.g. Assets:Bank:BayFed:Checking",
  }),
  rows: Type.Array(Row, {
    minItems: 1,
    description:
      "The transactions read from the statement, as RAW strings. Transcribe each entry verbatim -- copy the " +
      "bank's exact date and amount text, do NOT normalize, reformat, or convert them. The tool handles all " +
      "locale parsing (dates -> ISO, decimal/thousands separators); pre-converting risks double-conversion.",
  }),
  currency: Type.Optional(
    Type.String({ description: "Statement currency code (e.g. USD, EUR) used for rows without their own currency." }),
  ),
  uncategorized_expense_account: Type.String({
    description:
      "REQUIRED. Existing account that outflow (negative) rows balance to, in the workspace's own naming " +
      "(e.g. expenses:uncategorized) -- take it from the injected account list. The tool does not create " +
      "accounts and fails if it is not declared. If the statement has no outflows, pass any declared expense account.",
  }),
  uncategorized_income_account: Type.String({
    description:
      "REQUIRED. Existing account that inflow (positive) rows balance to (e.g. income:uncategorized), from the " +
      "injected account list. For a credit-card/liability statement, point both at an expense catch-all since " +
      "charges are spending, not income. If the statement has no inflows, pass any declared income account.",
  }),
  number_format: Type.Optional(
    Type.Union(
      [
        Type.Literal("us", { description: "US/UK: 1,234.56 (comma thousands, dot decimal)" }),
        Type.Literal("de", { description: "German: 1.234,56 (dot thousands, comma decimal)" }),
        Type.Literal("fr", { description: "French/SI: 1 234,56 (space/NBSP thousands, comma decimal)" }),
        Type.Literal("ch", { description: "Swiss: 1'234.56 (apostrophe thousands, dot decimal)" }),
      ],
      {
        description:
          "Number format override. Omit to auto-detect. With few rows, detection may be ambiguous and will " +
          "error -- pass the statement's format explicitly. A mis-parsed amount silently corrupts the ledger.",
      },
    ),
  ),
  date_format: Type.Optional(
    Type.Union(
      [
        Type.Literal("MDY", { description: "US: MM/DD/YYYY" }),
        Type.Literal("DMY", { description: "EU/German: DD/MM/YYYY or DD.MM.YYYY" }),
      ],
      {
        description:
          "Date order override for ambiguous dates (both components <= 12). Omit to auto-detect. " +
          "IMPORTANT: a mis-parsed date sends the transaction to the wrong monthly file.",
      },
    ),
  ),
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "If true, parse, dedup, and validate but do NOT write. Returns counts, detected formats, and a sample. " +
        "Use this to verify the rows look correct before committing.",
    }),
  ),
  backfill: Type.Optional(
    Type.Boolean({
      description:
        "If true, a row that unambiguously matches an existing untagged/cross-source/pdf-tagged transaction " +
        "backfills that transaction's import_id and original_description tags instead of just being reported " +
        "as a possible duplicate -- so a future re-import of the same statement matches it exactly. Only " +
        "those two tags are touched; the transaction's payee/description and every other tag are left as-is. " +
        "Ambiguous matches (multiple existing candidates share the account/date/amount) are still reported " +
        "as possibleDuplicates, never guessed at. Run a dry_run first to review what would be backfilled.",
    }),
  ),
});

const LABEL = "Import Transactions From Rows";

const PROMPT_SNIPPET =
  "Import transactions transcribed from a PDF/image statement (same locale parsing, dedup, and validation as CSV import)";

const PROMPT_GUIDELINES = [
  "Use this for PDF or image statements: call extract_text first, read the transactions, then pass them here as rows.",
  "For a long statement, import in page-sized batches rather than one huge call; dedup makes re-runs and overlaps safe -- overlapping rows are skipped outright when the description matches exactly, or held back and reported as possibleDuplicates for manual review when it doesn't (or backfilled onto the matched entry if backfill:true and the match is unambiguous), but never silently double-written.",
  "Transcribe dates, amounts, AND descriptions VERBATIM -- do not reformat, convert to ISO, reword, or change decimal/thousands separators. The tool parses locale formats deterministically; if the auto-detect looks wrong in dry_run, pass number_format/date_format instead of editing the values. Verbatim descriptions also keep re-imports of the same statement matching exactly instead of falling back to the weaker possible-duplicate check.",
  "With only a few rows, auto-detection may be ambiguous -- pass number_format and date_format explicitly.",
  "Run with dry_run:true first to confirm parsed counts, detected formats, and a sample.",
  "uncategorized_expense_account and uncategorized_income_account are required: pass accounts that already exist in the injected list (the tool does not create accounts). Pick them before calling, even for dry_run.",
  "After import, re-categorize the uncategorized accounts with the modify-transactions skill's bundled script (run via bash) - or the edit tool on the monthly journal files if that skill isn't installed in this build.",
];

export const importTransactionsFromRowsTool: ToolDefinition<typeof Params, ImportResult> = {
  name: "import_transactions_from_rows",
  label: LABEL,
  description:
    "Import transactions supplied inline as rows (e.g. read from a PDF or image statement via extract_text). " +
    "Applies the same locale number/date parsing, import_id deduplication, provenance tags, and validated " +
    "monthly-file write pipeline as import_transactions -- only the CSV parsing step is skipped.",
  promptSnippet: PROMPT_SNIPPET,
  promptGuidelines: PROMPT_GUIDELINES,
  // Serialize every ledger write: "sequential" makes pi run any batch containing this
  // tool one call at a time, so the import's dedup-read and write stay atomic against
  // other ledger writers.
  executionMode: "sequential",
  parameters: Params,

  async execute(_id, params, signal) {
    const result = await runRowImport(
      {
        account: params.account,
        rows: params.rows,
        currency: params.currency,
        number_format: params.number_format,
        date_format: params.date_format,
        uncategorized_expense_account: params.uncategorized_expense_account,
        uncategorized_income_account: params.uncategorized_income_account,
        dry_run: params.dry_run,
        backfill: params.backfill,
      },
      signal,
    );

    return {
      content: [{ type: "text", text: renderImportResult(result) }],
      details: result,
    };
  },
};
