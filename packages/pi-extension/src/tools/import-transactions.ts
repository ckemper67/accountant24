import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImportResult } from "../import/import";
import { runImport } from "../import/import";

const ColumnMap = Type.Optional(
  Type.Object(
    {
      date: Type.Optional(Type.String({ description: "Header name (or 0-based index) of the date column" })),
      amount: Type.Optional(Type.String({ description: "Header name of the combined amount column" })),
      debit: Type.Optional(Type.String({ description: "Header name of the debit (outflow) column" })),
      credit: Type.Optional(Type.String({ description: "Header name of the credit (inflow) column" })),
      description: Type.Optional(Type.String({ description: "Header name of the description/memo column" })),
      payee: Type.Optional(Type.String({ description: "Header name of the payee/merchant column" })),
      currency: Type.Optional(Type.String({ description: "Header name of the currency column" })),
    },
    { description: "Override CSV column names when auto-detection does not find them" },
  ),
);

const Params = Type.Object({
  file_path: Type.String({
    description:
      "Workspace-relative path to the CSV bank export, e.g. files/2025/01/statement.csv. " +
      "For PDF/image statements, use extract_text first to get the text, then import_transactions.",
  }),
  account: Type.String({
    description: "Ledger account the statement belongs to, e.g. Assets:Bank:BayFed:Checking",
  }),
  currency: Type.Optional(
    Type.String({
      description:
        "Statement currency code (e.g. USD, EUR). Used when the CSV has no currency column. " +
        "If omitted and no currency column is detected, transactions will be written without a currency.",
    }),
  ),
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
          "Number format override. Omit to auto-detect. Always specify if the auto-detected " +
          "format is wrong -- a mis-parsed amount silently corrupts the ledger.",
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
          "Date order override for ambiguous dates (both components <= 12). " +
          "Omit to auto-detect from the column. " +
          "IMPORTANT: a mis-parsed date sends the transaction to the wrong monthly file.",
      },
    ),
  ),
  column_map: ColumnMap,
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "If true, parse, dedup, and validate but do NOT write to the ledger. " +
        "Returns counts (parsed/new/skipped), detected formats, encoding, and a sample of " +
        "the first few transactions. Use this to verify the import looks correct before committing.",
    }),
  ),
});

const LABEL = "Import Transactions";

const PROMPT_SNIPPET =
  "Bulk-import a CSV bank export (auto-detects encoding, number format, date order; deduplicates on re-import)";

const PROMPT_GUIDELINES = [
  "For PDF or image bank statements, call extract_text first to get text, then import_transactions.",
  "Run with dry_run:true before the real import to confirm parsed counts, detected formats, and a sample.",
  "After import, re-categorize Expenses:Uncategorized / Income:Uncategorized with modify_transactions.",
  "If the number_format or date_format look wrong in the dry_run output, pass an explicit override.",
  "If a required column is not found, supply column_map with the exact header names from the CSV.",
];

export const importTransactionsTool: ToolDefinition<typeof Params, ImportResult> = {
  name: "import_transactions",
  label: LABEL,
  description:
    "Bulk-import a CSV bank export into the ledger. Auto-detects encoding (UTF-8, windows-1252), " +
    "number format (US/DE/FR/CH), and date order. Deduplicates on re-import via import_id tags. " +
    "Routes each transaction through the standard validated pipeline (monthly files, hledger check --strict).",
  promptSnippet: PROMPT_SNIPPET,
  promptGuidelines: PROMPT_GUIDELINES,
  // Serialize every ledger write: "sequential" makes pi run any batch containing this
  // tool one call at a time, so the dedup-read and write stay atomic without an
  // in-code lock.
  executionMode: "sequential",
  parameters: Params,

  async execute(_id, params, signal) {
    const result = await runImport(
      {
        file_path: params.file_path,
        account: params.account,
        currency: params.currency,
        number_format: params.number_format,
        date_format: params.date_format,
        column_map: params.column_map,
        dry_run: params.dry_run,
      },
      signal,
    );

    const lines: string[] = [];

    if (result.dryRun) {
      lines.push(`DRY RUN -- no transactions written.`);
    }

    lines.push(
      `Parsed: ${result.parsed} rows | New: ${result.imported} | Skipped (already imported): ${result.skipped}`,
    );
    lines.push(
      `Encoding: ${result.encoding} | Number format: ${result.numberFormat} | Date order: ${result.dateOrder}`,
    );

    if (result.sample.length > 0) {
      lines.push("");
      lines.push(`Sample (first ${result.sample.length} new transactions):`);
      for (const s of result.sample) {
        lines.push(`\n${s}`);
      }
    }

    if (!result.dryRun && result.transactions && result.transactions.length > 0) {
      const files = [...new Set(result.transactions.map((t) => t.fullFilePath))];
      lines.push("");
      lines.push(`Written to: ${files.join(", ")}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: result,
    };
  },
};
