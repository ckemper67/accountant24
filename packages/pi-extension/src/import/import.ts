// Main import pipeline for CSV bank statement bulk import.
//
// Flow:
//   resolveWorkspacePath -> read file -> decodeBuffer -> parseCsv
//     -> detect formats (or use overrides) -> build rows
//     -> loadExistingImportIds + loadExistingFingerprintCounts
//     -> reconcile (dedup)
//     -> build AddTransactionParams[]
//     -> if dry_run: return summary without writing
//     -> else: addTransactions
//
// Dedup-read and write stay atomic because import_transactions runs executionMode
// "sequential" -- pi never runs a ledger writer concurrently with another.

import { readFileSync } from "node:fs";
import { resolveWorkspacePath } from "../files/paths";
import type { AddTransactionParams } from "../ledger/transactions";
import { addTransactions } from "../ledger/transactions";
import type { ColumnMap, CsvRow } from "./csv";
import { parseCsv } from "./csv";
import type { DateOrder } from "./dates";
import { detectDateOrder, parseDate } from "./dates";
import type { DedupRow } from "./dedup";
import { loadExistingImportIds, reconcile } from "./dedup";
import { decodeBuffer } from "./encoding";
import type { NumberFormat } from "./numbers";
import { detectNumberFormat, parseLocaleAmount } from "./numbers";

// ── Types ────────────────────────────────────────────────────────────

export interface ImportParams {
  /** Workspace-relative path to the CSV file. */
  file_path: string;
  /** Ledger account this statement belongs to, e.g. "Assets:Bank:Checking". */
  account: string;
  /** Statement currency (used when the CSV has no currency column). */
  currency?: string;
  /** Explicit number format override; omit to auto-detect. */
  number_format?: NumberFormat;
  /** Explicit date format override: "MDY" | "DMY". */
  date_format?: "MDY" | "DMY";
  /** Column name overrides. */
  column_map?: ColumnMap;
  /** If true, parse and report but do not write to the ledger. */
  dry_run?: boolean;
}

export interface ImportResult {
  parsed: number;
  imported: number;
  skipped: number;
  encoding: string;
  numberFormat: NumberFormat;
  dateOrder: DateOrder;
  dryRun: boolean;
  /** First few new transactions as formatted strings (preview). */
  sample: string[];
  /** On success: results from addTransactions. */
  transactions?: Array<{ transactionText: string; fullFilePath: string }>;
  diffs?: Array<{ fullFilePath: string; diff: string }>;
}

const MAX_SAMPLE = 5;

// ── Helpers ──────────────────────────────────────────────────────────

/** Pick the effective currency for a row: row-level > param-level > empty string. */
function rowCurrency(csvRow: CsvRow, paramCurrency: string): string {
  return csvRow.currency || paramCurrency || "";
}

/** Build the "payee" for a transaction from the CSV row. */
function buildPayee(row: CsvRow): string {
  const name = row.payee || row.description || "Unknown";
  return name.trim() || "Unknown";
}

/** Format a sample AddTransactionParams as a compact text string for the dry-run summary. */
function formatSample(p: AddTransactionParams): string {
  const header = p.description ? `${p.date} ${p.payee} | ${p.description}` : `${p.date} ${p.payee}`;
  const postingLines = p.postings.map((posting) => {
    const sign = posting.amount < 0 ? "-" : "";
    return `  ${posting.account}  ${sign}${Math.abs(posting.amount).toFixed(2)} ${posting.currency}`;
  });
  return [header, ...postingLines].join("\n");
}

// ── Main pipeline ────────────────────────────────────────────────────

export async function runImport(params: ImportParams, signal?: AbortSignal): Promise<ImportResult> {
  // 1. Resolve and read file.
  const filePath = resolveWorkspacePath(params.file_path);
  let fileBuffer: Buffer;
  try {
    fileBuffer = readFileSync(filePath);
  } catch {
    throw new Error(`Cannot read file: ${params.file_path}`);
  }

  // 2. Decode.
  const { text, encoding } = decodeBuffer(fileBuffer);

  // 3. Parse CSV.
  const csvRows = parseCsv(text, params.column_map);
  if (csvRows.length === 0) {
    return {
      parsed: 0,
      imported: 0,
      skipped: 0,
      encoding,
      numberFormat: "us",
      dateOrder: "mdy",
      dryRun: params.dry_run ?? false,
      sample: [],
    };
  }

  // 4. Detect formats (or use overrides). Sample ALL rows, not a prefix: a wrong number
  // format silently corrupts amounts by ~1000x (hledger can't catch it -- the entry still
  // balances), so detection must see every value, and a disambiguating out-of-range date
  // may appear anywhere in the column.
  const amountSamples = csvRows.map((r) => r.amount).filter(Boolean);
  const numberFormat: NumberFormat = params.number_format ?? detectNumberFormat(amountSamples);

  const dateSamples = csvRows.map((r) => r.date).filter(Boolean);

  let dateOrder: DateOrder;
  if (params.date_format) {
    dateOrder = params.date_format === "MDY" ? "mdy" : "dmy";
  } else {
    dateOrder = detectDateOrder(dateSamples);
  }

  // 5. Parse all amounts and dates, build DedupRows.
  const dedupRows: DedupRow[] = csvRows.map((row) => {
    const amount = parseLocaleAmount(row.amount, numberFormat);
    const date = parseDate(row.date, dateOrder);
    return { date, amount, description: row.description, payee: row.payee };
  });

  // 6. Do dedup and writes.
  // 6a. Load existing import_ids from the ledger.
  const existingIds = await loadExistingImportIds(signal);

  // 6b. Reconcile.
  const reconciled = reconcile(dedupRows, params.account, existingIds);

  // 6c. Build AddTransactionParams for new rows only.
  const toImport: AddTransactionParams[] = [];
  for (let i = 0; i < csvRows.length; i++) {
    if (!reconciled[i].isNew) continue;

    const csvRow = csvRows[i];
    const dedupRow = dedupRows[i];
    const currency = rowCurrency(csvRow, params.currency ?? "");
    if (!currency) {
      throw new Error(
        `Row ${i + 1} has no currency. Pass a "currency" for the statement, ` +
          "or map a currency column via column_map.",
      );
    }
    const payee = buildPayee(csvRow);
    const importId = reconciled[i].importId;

    // Determine account direction: negative amount = outflow = expense.
    // Balancing account:
    //   outflow (amount < 0): debit from `account`, credit Expenses:Uncategorized
    //   inflow  (amount > 0): credit to `account`, debit Income:Uncategorized
    const amount = dedupRow.amount;
    const isOutflow = amount < 0;
    const balancingAccount = isOutflow ? "Expenses:Uncategorized" : "Income:Uncategorized";

    // The posted amount to `account` matches the statement sign.
    // hledger convention: positive = debit (inflow), negative = credit (outflow).
    const postings: AddTransactionParams["postings"] = [
      {
        account: params.account,
        amount: amount, // negative for outflows, positive for inflows
        currency,
      },
      {
        account: balancingAccount,
        amount: -amount, // opposite
        currency,
      },
    ];

    const tags: AddTransactionParams["tags"] = [{ name: "import_id", value: importId }];
    if (csvRow.payee) {
      tags.push({ name: "original_payee_name", value: csvRow.payee });
    }
    if (csvRow.description) {
      tags.push({ name: "original_description", value: csvRow.description });
    }

    toImport.push({
      date: dedupRow.date,
      payee,
      description: csvRow.description || undefined,
      postings,
      tags,
    });
  }

  const newCount = toImport.length;
  const skipped = csvRows.length - newCount;

  // Build sample regardless of dry_run.
  const sample = toImport.slice(0, MAX_SAMPLE).map(formatSample);

  if (params.dry_run) {
    return {
      parsed: csvRows.length,
      imported: 0,
      skipped,
      encoding,
      numberFormat,
      dateOrder,
      dryRun: true,
      sample,
    };
  }

  if (newCount === 0) {
    return {
      parsed: csvRows.length,
      imported: 0,
      skipped,
      encoding,
      numberFormat,
      dateOrder,
      dryRun: false,
      sample,
    };
  }

  // 6d. Write the new transactions.
  const writeResult = await addTransactions(toImport, signal);

  return {
    parsed: csvRows.length,
    imported: newCount,
    skipped,
    encoding,
    numberFormat,
    dateOrder,
    dryRun: false,
    sample,
    transactions: writeResult.transactions,
    diffs: writeResult.diffs,
  };
}
