// Import pipeline for bank statements.
//
// Two front-ends feed one shared back-end:
//   - runImport:    a CSV file  -> decode + parseCsv -> importStatementRows
//   - runRowImport: inline rows (e.g. an agent reading a PDF via extract_text) ->
//                   importStatementRows
//
// importStatementRows is format-agnostic: it detects/normalizes locale number and date
// formats, dedups via import_id, builds double-entry transactions, and writes them
// through addTransactions. Dedup-read and write stay atomic because the import tools
// run executionMode "sequential" -- pi never runs a ledger writer concurrently with
// another.

import { readFileSync } from "node:fs";
import { ACCOUNTANT24_HOME, LEDGER_DIR } from "../config";
import { resolveWorkspacePath } from "../files/paths";
import { listAccounts } from "../ledger/accounts";
import { JournalEditSession } from "../ledger/edit-session";
import { HledgerCommandError, hledgerCheck } from "../ledger/hledger";
import { resolveSafePath } from "../ledger/paths";
import type { SourcePos } from "../ledger/source-pos";
import type { AddTransactionParams } from "../ledger/transactions";
import { addTransactions } from "../ledger/transactions";
import { backfillTransaction } from "./backfill";
import type { ColumnMap, StatementRow } from "./csv";
import { parseCsvWithMeta } from "./csv";
import type { DateOrder } from "./dates";
import { detectDateOrder, parseDate } from "./dates";
import type { DedupRow, ImportSource } from "./dedup";
import { loadExistingImportIds, reconcile } from "./dedup";
import { decodeBuffer } from "./encoding";
import type { NumberFormat } from "./numbers";
import { detectNumberFormat, parseLocaleAmount } from "./numbers";
import { looksLikeOfx, parseOfx } from "./ofx";

// ── Types ────────────────────────────────────────────────────────────

/** File format for runImport. "auto" (the default) detects from the file extension. */
export type ImportFileFormat = "csv" | "ofx";

export interface ImportParams {
  /** Workspace-relative path to the statement file (CSV or OFX/QFX). */
  file_path: string;
  /** Ledger account this statement belongs to, e.g. "Assets:Bank:Checking". */
  account: string;
  /**
   * File format; omit to detect from the file extension (.csv/.tsv -> csv, .ofx/.qfx ->
   * ofx). If detection fails, or the content doesn't match the chosen/detected format, the
   * tool errors with a preview of the file so you can inspect it and retry explicitly.
   */
  format?: ImportFileFormat;
  /** Statement currency (used when the CSV has no currency column). */
  currency?: string;
  /** Explicit number format override; omit to auto-detect. Ignored for OFX (always "us"). */
  number_format?: NumberFormat;
  /** Explicit date format override: "MDY" | "DMY". Ignored for OFX (dates are unambiguous). */
  date_format?: "MDY" | "DMY";
  /** Column name overrides. CSV only. */
  column_map?: ColumnMap;
  /** Number of leading (non-empty) lines to skip before the header; omit to auto-detect. CSV only. */
  skip_rows?: number;
  /** Catch-all account for outflow (negative) rows, in the workspace's own naming. */
  uncategorized_expense_account?: string;
  /** Catch-all account for inflow (positive) rows, in the workspace's own naming. */
  uncategorized_income_account?: string;
  /** If true, parse and report but do not write to the ledger. */
  dry_run?: boolean;
  /**
   * If true, unambiguous dedup matches against an existing untagged/cross-source/pdf-tagged
   * transaction backfill that transaction's import_id and original_description tags instead
   * of just reporting it as a possible duplicate -- so a future re-import matches it
   * exactly. Only the two tags are touched; the transaction's own payee/description and any
   * other tag are left exactly as they are. Ambiguous matches (multiple existing candidates
   * share the same account/date/amount) are still reported as possibleDuplicates, never
   * guessed at.
   */
  backfill?: boolean;
}

/** A single raw row supplied inline (e.g. transcribed by the agent from a PDF). */
export interface StatementRowInput {
  /** Raw date string, e.g. "15.01.2025" (normalized by the shared pipeline). */
  date: string;
  /** Raw amount string, e.g. "-1.234,56" (parsed by the shared pipeline; negative = outflow). */
  amount: string;
  description?: string;
  payee?: string;
  currency?: string;
}

export interface RowImportParams {
  /** Ledger account this statement belongs to, e.g. "Assets:Bank:Checking". */
  account: string;
  /** The rows to import, as raw strings. */
  rows: StatementRowInput[];
  /** Statement currency (used when a row has no currency of its own). */
  currency?: string;
  number_format?: NumberFormat;
  date_format?: "MDY" | "DMY";
  /** Catch-all account for outflow (negative) rows, in the workspace's own naming. */
  uncategorized_expense_account?: string;
  /** Catch-all account for inflow (positive) rows, in the workspace's own naming. */
  uncategorized_income_account?: string;
  dry_run?: boolean;
  /** See ImportParams.backfill. */
  backfill?: boolean;
}

/** CSV header-detection metadata, surfaced so the caller/LLM can validate the auto-detect. */
export interface ImportDetection {
  /** Number of leading metadata lines skipped before the header. */
  preambleRows: number;
  /** The skipped preamble lines (raw), for a peek if the mapping needs adjusting. */
  preamble: string[];
  /** The detected header fields. */
  header: string[];
  /** The first parsed data row (raw), showing how columns were mapped. */
  sampleRow?: StatementRow;
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
  /**
   * Rows NOT written because they weakly matched an existing description-less transaction
   * on (account, date, amount) alone -- ambiguous, so treated as a likely duplicate rather
   * than written. Review and re-add via add_transactions if any of these are genuinely new.
   */
  possibleDuplicates: Array<{ date: string; amount: number; currency: string; payee: string; description?: string }>;
  /**
   * Rows that unambiguously matched an existing untagged/cross-source/pdf-tagged
   * transaction and had that transaction's import_id + original_description tags
   * backfilled (only when `backfill: true` was passed). Not written as new; their
   * (date, amount, currency, payee) identify which existing entry was updated.
   */
  backfilled: Array<{ date: string; amount: number; currency: string; payee: string; description?: string }>;
  /** CSV header/preamble detection (absent for inline-row imports). */
  detection?: ImportDetection;
  /** The resolved balancing (catch-all) accounts used, and whether each was already declared. */
  balancing?: Array<{ direction: "expense" | "income"; account: string; declared: boolean }>;
  /** On success: results from addTransactions. */
  transactions?: Array<{ transactionText: string; fullFilePath: string }>;
  diffs?: Array<{ fullFilePath: string; diff: string }>;
}

/** Shared options for the format-agnostic back-end. */
interface CoreParams {
  account: string;
  currency?: string;
  number_format?: NumberFormat;
  date_format?: "MDY" | "DMY";
  dry_run?: boolean;
  backfill?: boolean;
  uncategorized_expense_account?: string;
  uncategorized_income_account?: string;
  /** Namespaces the import_id and is reported for provenance. */
  source: ImportSource;
  /** Reported in the result; "inline" for row imports with no file encoding. */
  encoding: string;
  /** CSV detection metadata to echo back (absent for inline-row imports). */
  detection?: ImportDetection;
}

const MAX_SAMPLE = 5;

// ── Result rendering ─────────────────────────────────────────────────

/** Render an ImportResult as the user-facing text block shared by the import tools. */
export function renderImportResult(result: ImportResult): string {
  const lines: string[] = [];
  if (result.dryRun) lines.push("DRY RUN -- no transactions written.");
  lines.push(`Parsed: ${result.parsed} rows | New: ${result.imported} | Skipped (already imported): ${result.skipped}`);
  lines.push(`Encoding: ${result.encoding} | Number format: ${result.numberFormat} | Date order: ${result.dateOrder}`);

  if (result.balancing && result.balancing.length > 0) {
    const parts = result.balancing.map((b) => `${b.direction} -> ${b.account}`);
    lines.push(`Balancing (uncategorized): ${parts.join(" | ")}`);
  }

  const d = result.detection;
  if (d) {
    lines.push("");
    lines.push(`Header: detected on line ${d.preambleRows + 1} (skipped ${d.preambleRows} preamble line(s)).`);
    if (d.preamble.length > 0) lines.push(`  Preamble: ${d.preamble.join(" / ")}`);
    lines.push(`  Columns: ${d.header.join(" | ")}`);
    if (d.sampleRow) {
      const r = d.sampleRow;
      lines.push(
        `  First row -> date="${r.date}" amount="${r.amount}" payee="${r.payee}" ` +
          `description="${r.description}" currency="${r.currency}"`,
      );
    }
    lines.push("  If the header, columns, or field mapping look wrong, set skip_rows or column_map and retry.");
  }

  if (result.sample.length > 0) {
    lines.push("");
    lines.push(`Sample (first ${result.sample.length} new transactions):`);
    for (const s of result.sample) lines.push(`\n${s}`);
  }

  if (result.possibleDuplicates.length > 0) {
    lines.push("");
    lines.push(
      `Possible duplicates -- NOT imported (matched an existing transaction on account+date+amount, ` +
        `but its description could not be recovered to confirm it's the same one). If any of these are ` +
        `genuinely new, add them with add_transactions. Re-run with backfill: true to tag the matched ` +
        `entries instead, if they're confirmed duplicates:`,
    );
    for (const p of result.possibleDuplicates) {
      const desc = p.description ? ` | ${p.description}` : "";
      lines.push(`  ${p.date} ${p.payee}${desc} -- ${p.amount.toFixed(2)} ${p.currency}`);
    }
  }

  if (result.backfilled.length > 0) {
    lines.push("");
    lines.push(
      `${result.dryRun ? "Would backfill" : "Backfilled"} import_id + original_description onto ${result.backfilled.length} ` +
        `existing matched transaction(s) instead of importing them as new:`,
    );
    for (const b of result.backfilled) {
      const desc = b.description ? ` | ${b.description}` : "";
      lines.push(`  ${b.date} ${b.payee}${desc} -- ${b.amount.toFixed(2)} ${b.currency}`);
    }
  }

  if (!result.dryRun && result.transactions && result.transactions.length > 0) {
    const files = [...new Set(result.transactions.map((t) => t.fullFilePath))];
    lines.push("");
    lines.push(`Written to: ${files.join(", ")}`);
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Pick the effective currency for a row: row-level > param-level > empty string. */
function rowCurrency(row: StatementRow, paramCurrency: string): string {
  return row.currency || paramCurrency || "";
}

/** Build the "payee" for a transaction from a row. */
function buildPayee(row: StatementRow): string {
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

function emptyResult(encoding: string, dryRun: boolean, detection?: ImportDetection): ImportResult {
  return {
    parsed: 0,
    imported: 0,
    skipped: 0,
    encoding,
    numberFormat: "us",
    dateOrder: "mdy",
    dryRun,
    sample: [],
    possibleDuplicates: [],
    backfilled: [],
    detection,
  };
}

// ── Format detection ────────────────────────────────────────────────

/** Detect the file format from its extension; undefined if not recognized. */
function detectFormatFromExtension(filePath: string): ImportFileFormat | undefined {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "ofx" || ext === "qfx") return "ofx";
  if (ext === "csv" || ext === "tsv") return "csv";
  return undefined;
}

/** Build a "look at the file and retry with an explicit format" error, with a content preview. */
function formatError(filePath: string, reason: string, text: string): Error {
  const preview = text.split(/\r?\n/).slice(0, 5).join("\n");
  return new Error(
    `${reason} for "${filePath}".\nFirst 5 lines:\n${preview}\n\n` +
      `Read the file to check its actual format, then retry with format: "csv" or format: "ofx".`,
  );
}

// ── Front-ends ───────────────────────────────────────────────────────

/** Import a CSV or OFX file from the workspace. */
export async function runImport(params: ImportParams, signal?: AbortSignal): Promise<ImportResult> {
  // Resolve and read the file.
  const filePath = resolveWorkspacePath(params.file_path);
  let fileBuffer: Buffer;
  try {
    fileBuffer = readFileSync(filePath);
  } catch {
    throw new Error(`Cannot read file: ${params.file_path}`);
  }

  const { text, encoding } = decodeBuffer(fileBuffer);
  const format = params.format ?? detectFormatFromExtension(params.file_path);
  if (!format) {
    throw formatError(params.file_path, "Cannot determine the format", text);
  }

  if (format === "ofx") {
    if (!looksLikeOfx(text)) {
      throw formatError(params.file_path, "File does not look like OFX (no OFXHEADER/<OFX> found)", text);
    }
    const { rows, accountCount } = parseOfx(text);
    if (accountCount > 1) {
      throw new Error(
        `"${params.file_path}" contains ${accountCount} account blocks; this importer only supports one ` +
          `account per OFX file. Split the file or import each account separately.`,
      );
    }

    return importStatementRows(
      rows,
      {
        account: params.account,
        currency: params.currency,
        // OFX amounts are always '.'-decimal per spec -- skip locale auto-detect, which
        // could otherwise misread e.g. "1.234" as European thousands-grouping.
        number_format: "us",
        dry_run: params.dry_run,
        backfill: params.backfill,
        uncategorized_expense_account: params.uncategorized_expense_account,
        uncategorized_income_account: params.uncategorized_income_account,
        source: "ofx",
        encoding,
      },
      signal,
      rows.map((r) => r.fitid),
    );
  }

  let rows: StatementRow[];
  let headers: string[];
  let headerRowIndex: number;
  let preamble: string[];
  try {
    ({ rows, headers, headerRowIndex, preamble } = parseCsvWithMeta(text, params.column_map, params.skip_rows));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw formatError(params.file_path, `File does not look like CSV (${reason})`, text);
  }

  return importStatementRows(
    rows,
    {
      account: params.account,
      currency: params.currency,
      number_format: params.number_format,
      date_format: params.date_format,
      dry_run: params.dry_run,
      backfill: params.backfill,
      uncategorized_expense_account: params.uncategorized_expense_account,
      uncategorized_income_account: params.uncategorized_income_account,
      source: "csv",
      encoding,
      detection: {
        preambleRows: headerRowIndex,
        preamble,
        header: headers,
        sampleRow: rows[0],
      },
    },
    signal,
  );
}

/** Import rows supplied inline (e.g. transcribed by the agent from a PDF/image). */
export async function runRowImport(params: RowImportParams, signal?: AbortSignal): Promise<ImportResult> {
  const rows: StatementRow[] = params.rows.map((r) => ({
    date: r.date,
    amount: r.amount,
    description: r.description ?? "",
    payee: r.payee ?? "",
    currency: r.currency ?? "",
  }));

  return importStatementRows(
    rows,
    {
      account: params.account,
      currency: params.currency,
      number_format: params.number_format,
      date_format: params.date_format,
      dry_run: params.dry_run,
      backfill: params.backfill,
      uncategorized_expense_account: params.uncategorized_expense_account,
      uncategorized_income_account: params.uncategorized_income_account,
      source: "pdf",
      encoding: "inline",
    },
    signal,
  );
}

// ── Shared back-end ──────────────────────────────────────────────────

async function importStatementRows(
  rows: StatementRow[],
  core: CoreParams,
  signal?: AbortSignal,
  nativeIds?: Array<string | undefined>,
): Promise<ImportResult> {
  if (rows.length === 0) {
    return emptyResult(core.encoding, core.dry_run ?? false, core.detection);
  }

  // Detect formats (or use overrides). Sample ALL rows, not a prefix: a wrong number
  // format silently corrupts amounts by ~1000x (hledger can't catch it -- the entry still
  // balances), so detection must see every value, and a disambiguating out-of-range date
  // may appear anywhere in the column.
  const amountSamples = rows.map((r) => r.amount).filter(Boolean);
  const numberFormat: NumberFormat = core.number_format ?? detectNumberFormat(amountSamples);

  const dateSamples = rows.map((r) => r.date).filter(Boolean);
  const dateOrder: DateOrder = core.date_format
    ? core.date_format === "MDY"
      ? "mdy"
      : "dmy"
    : detectDateOrder(dateSamples);

  // Parse all amounts and dates, build DedupRows.
  const dedupRows: DedupRow[] = rows.map((row, i) => ({
    date: parseDate(row.date, dateOrder),
    amount: parseLocaleAmount(row.amount, numberFormat),
    description: row.description,
    payee: row.payee,
    nativeId: nativeIds?.[i],
  }));

  const [existingFingerprints, declaredAccounts] = await Promise.all([
    loadExistingImportIds(core.account, core.source, signal),
    listAccounts(),
  ]);
  const reconciled = reconcile(dedupRows, core.account, existingFingerprints, core.source);

  // Resolve the catch-all account for each direction. The tool never invents accounts
  // (account creation is the user's/LLM's job, as with add_transactions): the LLM must
  // pass a catch-all that already exists, and we fail loud otherwise.
  const declaredSet = new Set(declaredAccounts);
  const resolvedBuckets = new Map<"expense" | "income", string>();
  const resolveBucket = (direction: "expense" | "income"): string => {
    const cached = resolvedBuckets.get(direction);
    if (cached) return cached;

    const supplied = direction === "expense" ? core.uncategorized_expense_account : core.uncategorized_income_account;
    const flow = direction === "expense" ? "outflows" : "inflows";
    const param = `uncategorized_${direction}_account`;
    const declaredList = declaredAccounts.slice(0, 60).join(", ") || "(none declared)";

    if (!supplied) {
      throw new Error(
        `This statement has ${flow} but no ${param} was provided. Pass the workspace's ` +
          `catch-all account for ${flow}. Declared accounts: ${declaredList}`,
      );
    }
    if (!declaredSet.has(supplied)) {
      const ci = declaredAccounts.find((a) => a.toLowerCase() === supplied.toLowerCase());
      const hint = ci ? ` Did you mean "${ci}"?` : "";
      throw new Error(
        `Account "${supplied}" is not declared.${hint} Declare it first (accounts are the ` +
          `user's to create) or pass an existing account. Declared accounts: ${declaredList}`,
      );
    }
    resolvedBuckets.set(direction, supplied);
    return supplied;
  };

  // Build AddTransactionParams for new rows only.
  const toImport: AddTransactionParams[] = [];
  const possibleDuplicates: ImportResult["possibleDuplicates"] = [];
  const backfilled: ImportResult["backfilled"] = [];
  const backfillActions: Array<{ target: SourcePos; importId: string; description: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dedupRow = dedupRows[i];

    if (!reconciled[i].isNew) {
      const report = {
        date: dedupRow.date,
        amount: dedupRow.amount,
        currency: rowCurrency(row, core.currency ?? ""),
        payee: buildPayee(row),
        description: row.description || undefined,
      };
      const target = reconciled[i].backfillTarget;
      if (core.backfill && target) {
        backfillActions.push({ target, importId: reconciled[i].importId, description: row.description ?? "" });
        backfilled.push(report);
      } else if (reconciled[i].weakMatch) {
        possibleDuplicates.push(report);
      }
      continue;
    }

    const currency = rowCurrency(row, core.currency ?? "");
    if (!currency) {
      throw new Error(
        `Row ${i + 1} has no currency. Pass a "currency" for the statement, or give each row a currency.`,
      );
    }
    const payee = buildPayee(row);
    const importId = reconciled[i].importId;

    // The posted amount to `account` keeps the statement sign (negative = outflow); the
    // balancing posting goes to the LLM-supplied catch-all for that direction.
    const amount = dedupRow.amount;
    const balancingAccount = resolveBucket(amount < 0 ? "expense" : "income");

    const postings: AddTransactionParams["postings"] = [
      { account: core.account, amount, currency },
      { account: balancingAccount, amount: -amount, currency },
    ];

    const tags: AddTransactionParams["tags"] = [{ name: "import_id", value: importId }];
    if (row.payee) tags.push({ name: "original_payee_name", value: row.payee });
    if (row.description) tags.push({ name: "original_description", value: row.description });

    toImport.push({
      date: dedupRow.date,
      payee,
      description: row.description || undefined,
      postings,
      tags,
    });
  }

  const newCount = toImport.length;
  const skipped = rows.length - newCount;
  const sample = toImport.slice(0, MAX_SAMPLE).map(formatSample);
  const balancing = [...resolvedBuckets.entries()].map(([direction, account]) => ({
    direction,
    account,
    declared: true,
  }));

  const base = {
    parsed: rows.length,
    skipped,
    encoding: core.encoding,
    numberFormat,
    dateOrder,
    sample,
    possibleDuplicates,
    backfilled,
    detection: core.detection,
    balancing,
  };

  if (core.dry_run) {
    return { ...base, imported: 0, dryRun: true };
  }

  // Backfill runs as its own validated, atomic edit -- separate from the addTransactions
  // batch below -- since it touches existing on-disk transactions rather than appending
  // new ones. Runs before addTransactions so a backfill failure aborts the whole import
  // rather than leaving new transactions written against tags that never got fixed up.
  if (backfillActions.length > 0) {
    await applyBackfillActions(backfillActions, signal);
  }

  if (newCount === 0) {
    return { ...base, imported: 0, dryRun: false };
  }

  const writeResult = await addTransactions(toImport, signal);
  return {
    ...base,
    imported: newCount,
    dryRun: false,
    transactions: writeResult.transactions,
    diffs: writeResult.diffs,
  };
}

/**
 * Apply a batch of backfill edits (see ReconcileOutput.backfillTarget) as one validated,
 * atomic unit: edit every target transaction's import_id + original_description tags,
 * validate the whole ledger, and roll back all of it if the result would be invalid.
 */
async function applyBackfillActions(
  actions: Array<{ target: SourcePos; importId: string; description: string }>,
  signal?: AbortSignal,
): Promise<void> {
  const session = new JournalEditSession();

  // Process highest line number first within each file: backfillTransaction can insert a
  // line, which shifts every later line in that file down by one -- processing bottom-up
  // means an insertion never invalidates a not-yet-processed target's startLine, since every
  // remaining target in that file sits above the insertion point.
  const ordered = [...actions].sort((a, b) => b.target.startLine - a.target.startLine);

  for (const { target, importId, description } of ordered) {
    const content = session.read(target.file);
    const { newContent, changed } = backfillTransaction(content, target, importId, description);
    if (changed) session.write(target.file, newContent);
  }

  session.flush();

  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  try {
    await hledgerCheck(mainPath, { cwd: ACCOUNTANT24_HOME, signal });
  } catch (e) {
    session.restore();
    if (e instanceof HledgerCommandError) {
      throw new Error(`Backfill reverted -- the ledger would have errors:\n\n${e.stderr}`);
    }
    throw e;
  }
}
