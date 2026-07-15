// CSV parsing and column resolution for bank statement imports.
//
// Reuses parseCSVLine from ledger/briefing.ts so the quoting logic is shared.
// Supports:
//   - Auto-detection of common column headers (date, amount, description, payee, currency).
//   - Explicit column_map override for non-standard headers.
//   - Separate debit/credit columns collapsed to a single signed amount.

import { parseCSVLine } from "../ledger/briefing";

// ── Types ────────────────────────────────────────────────────────────

export interface ColumnMap {
  date?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  description?: string;
  payee?: string;
  currency?: string;
}

export interface CsvRow {
  date: string; // raw date string (not yet normalized)
  amount: string; // raw amount string (not yet parsed); sign: positive = inflow
  description: string;
  payee: string;
  currency: string;
}

// ── Header matching ────────────────────────────────────────────────

// Common header names for each logical column. Case-insensitive match.
const DATE_HEADERS = [
  "date",
  "datum",
  "buchungsdatum",
  "valutadatum",
  "value date",
  "posting date",
  "transaction date",
  "trans. date",
];
const AMOUNT_HEADERS = ["amount", "betrag", "value", "sum", "total", "amount (eur)", "amount (usd)"];
const DEBIT_HEADERS = ["debit", "debit amount", "withdrawal", "withdrawal amount", "ausgabe", "soll"];
const CREDIT_HEADERS = ["credit", "credit amount", "deposit", "deposit amount", "einnahme", "haben"];
const DESCRIPTION_HEADERS = [
  "description",
  "memo",
  "note",
  "notes",
  "details",
  "transaction description",
  "verwendungszweck",
  "buchungstext",
  "zahlungsreferenz",
  "reference",
];
const PAYEE_HEADERS = [
  "payee",
  "merchant",
  "vendor",
  "name",
  "recipient",
  "sender",
  "auftraggeber",
  "empfanger",
  "beguenstigter",
  "beguenstigter/auftraggeber",
];
const CURRENCY_HEADERS = ["currency", "waehrung", "ccy", "currency code"];

function matchHeader(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function resolveColumnIndex(headers: string[], userKey: string | undefined, candidates: string[]): number {
  if (userKey !== undefined) {
    // Explicit key: match by header name, then by 0-based index string.
    const idx = matchHeader(headers, [userKey]);
    if (idx !== -1) return idx;
    const asIndex = Number.parseInt(userKey, 10);
    if (!Number.isNaN(asIndex) && asIndex >= 0 && asIndex < headers.length) return asIndex;
    throw new Error(`column_map key "${userKey}" not found in CSV headers: ${headers.join(", ")}`);
  }
  return matchHeader(headers, candidates);
}

// ── Public ───────────────────────────────────────────────────────────

/**
 * Parse a CSV text into an array of structured rows.
 *
 * @param text      - The decoded CSV text (no BOM).
 * @param columnMap - Optional override for column header names.
 * @returns         Array of CsvRow (raw strings; amounts and dates not yet normalized).
 * @throws          If required columns (date + at least one amount column) cannot be found.
 */
export function parseCsv(text: string, columnMap?: ColumnMap): CsvRow[] {
  // Split into lines, strip carriage returns, drop blank lines.
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");

  if (lines.length === 0) return [];

  // First non-blank line is the header.
  const headers = parseCSVLine(lines[0]);

  // Resolve column indices.
  const dateCol = resolveColumnIndex(headers, columnMap?.date, DATE_HEADERS);
  const amountCol = resolveColumnIndex(headers, columnMap?.amount, AMOUNT_HEADERS);
  const debitCol = resolveColumnIndex(headers, columnMap?.debit, DEBIT_HEADERS);
  const creditCol = resolveColumnIndex(headers, columnMap?.credit, CREDIT_HEADERS);
  const descCol = resolveColumnIndex(headers, columnMap?.description, DESCRIPTION_HEADERS);
  const payeeCol = resolveColumnIndex(headers, columnMap?.payee, PAYEE_HEADERS);
  const currencyCol = resolveColumnIndex(headers, columnMap?.currency, CURRENCY_HEADERS);

  if (dateCol === -1) {
    throw new Error(`Cannot find a date column in CSV headers: ${headers.join(", ")}. Use column_map to specify it.`);
  }

  const hasAmount = amountCol !== -1;
  const hasDebitCredit = debitCol !== -1 || creditCol !== -1;

  if (!hasAmount && !hasDebitCredit) {
    throw new Error(
      `Cannot find amount columns in CSV headers: ${headers.join(", ")}. ` +
        `Use column_map to specify "amount", "debit", or "credit".`,
    );
  }

  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    const dateRaw = (fields[dateCol] ?? "").trim();
    if (!dateRaw) continue; // skip rows with no date (e.g. summary footer rows)

    let amountRaw: string;
    if (hasAmount) {
      amountRaw = (fields[amountCol] ?? "").trim();
    } else {
      // Combine debit and credit columns.
      // Convention: debit = outflow (negative), credit = inflow (positive).
      // A cell is non-empty for the relevant column and empty for the other.
      const debitRaw = debitCol !== -1 ? (fields[debitCol] ?? "").trim() : "";
      const creditRaw = creditCol !== -1 ? (fields[creditCol] ?? "").trim() : "";

      if (debitRaw && !creditRaw) {
        // Debit (outflow): negate by prefixing a minus if not already negative.
        amountRaw = debitRaw.startsWith("-") ? debitRaw : `-${debitRaw}`;
      } else if (creditRaw && !debitRaw) {
        amountRaw = creditRaw;
      } else if (debitRaw && creditRaw) {
        // Both filled -- prefer debit and negate.
        amountRaw = debitRaw.startsWith("-") ? debitRaw : `-${debitRaw}`;
      } else {
        amountRaw = "0";
      }
    }

    const description = (fields[descCol] ?? "").trim();
    const payee = (fields[payeeCol] ?? "").trim();
    const currency = (fields[currencyCol] ?? "").trim();

    rows.push({ date: dateRaw, amount: amountRaw, description, payee, currency });
  }

  return rows;
}
