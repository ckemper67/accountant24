import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImportResult } from "../import/import";
import { renderImportResult, runImport } from "../import/import";
import {
  DateFormatParam,
  NumberFormatParam,
  RECATEGORIZE_GUIDELINE,
  UNCATEGORIZED_ACCOUNTS_GUIDELINE,
  UncategorizedExpenseAccountParam,
  UncategorizedIncomeAccountParam,
} from "./import-tool-shared";

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
      "For PDF/image statements, use extract_text first to get the text, then import_extracted_transactions.",
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
  uncategorized_expense_account: UncategorizedExpenseAccountParam,
  uncategorized_income_account: UncategorizedIncomeAccountParam,
  number_format: NumberFormatParam,
  date_format: DateFormatParam,
  column_map: ColumnMap,
  skip_rows: Type.Optional(
    Type.Number({
      description:
        "Number of leading metadata/preamble lines to skip before the header row. " +
        "Omit to auto-detect the header automatically -- only set this if auto-detection picks the wrong line.",
    }),
  ),
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
  "import_transactions reads a CSV file by path. For PDF or image statements, use extract_text then import_extracted_transactions instead.",
  "Run with dry_run:true before the real import to confirm parsed counts, detected formats, and a sample.",
  UNCATEGORIZED_ACCOUNTS_GUIDELINE,
  RECATEGORIZE_GUIDELINE,
  "If the number_format or date_format look wrong in the dry_run output, pass an explicit override.",
  "If a required column is not found, supply column_map with the exact header names from the CSV.",
  "Leading metadata/preamble rows before the header are skipped automatically; only set skip_rows if the wrong header line is picked.",
];

export const importTransactionsTool: ToolDefinition<typeof Params, ImportResult> = {
  name: "import_transactions",
  label: LABEL,
  description:
    "Bulk-import a CSV bank export into the ledger. Auto-detects encoding (UTF-8, windows-1252), " +
    "number format (US/DE/FR/CH), and date order. Deduplicates on re-import, including against untagged " +
    "transactions written before this tool existed. Routes each transaction through the standard validated " +
    "pipeline (monthly files, hledger check --strict).",
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
        skip_rows: params.skip_rows,
        uncategorized_expense_account: params.uncategorized_expense_account,
        uncategorized_income_account: params.uncategorized_income_account,
        dry_run: params.dry_run,
      },
      signal,
    );

    return {
      content: [{ type: "text", text: renderImportResult(result) }],
      details: result,
    };
  },
};
