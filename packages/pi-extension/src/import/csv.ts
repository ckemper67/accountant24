// CSV parsing and column resolution for bank statement imports.
//
// Supports:
//   - Auto-detection of common column headers (date, amount, description, payee, currency).
//   - Explicit column_map override for non-standard headers.
//   - Separate debit/credit columns collapsed to a single signed amount.

// ── RFC 4180 line parsing ──────────────────────────────────────────────

/** Split one CSV line into fields, honoring double-quoted fields with "" as an escaped quote. */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

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

export interface StatementRow {
  date: string; // raw date string (not yet normalized)
  amount: string; // raw amount string (not yet parsed); sign: positive = inflow
  description: string;
  payee: string;
  currency: string;
}

export interface ParsedCsv {
  rows: StatementRow[];
  /** The detected header fields. */
  headers: string[];
  /** 0-based index (among non-empty lines) of the header -- also the preamble line count. */
  headerRowIndex: number;
  /** The raw metadata lines skipped before the header, so a caller can validate detection. */
  preamble: string[];
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
const DEBIT_HEADERS = ["debit", "debit amount", "amount debit", "withdrawal", "withdrawal amount", "ausgabe", "soll"];
const CREDIT_HEADERS = ["credit", "credit amount", "amount credit", "deposit", "deposit amount", "einnahme", "haben"];
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

/** Resolve a column index: an explicit key matches by header name then by 0-based index
 *  string; otherwise the first matching candidate header name wins. -1 if unresolved. */
function tryResolveIndex(headers: string[], userKey: string | undefined, candidates: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const wanted = userKey !== undefined ? [userKey] : candidates;
  for (const candidate of wanted) {
    const idx = normalized.indexOf(candidate.toLowerCase());
    if (idx !== -1) return idx;
  }
  if (userKey !== undefined) {
    const asIndex = Number.parseInt(userKey, 10);
    if (!Number.isNaN(asIndex) && asIndex >= 0 && asIndex < headers.length) return asIndex;
  }
  return -1;
}

/** Like tryResolveIndex, but throws when an explicit userKey doesn't resolve to anything. */
function resolveColumnIndex(headers: string[], userKey: string | undefined, candidates: string[]): number {
  const idx = tryResolveIndex(headers, userKey, candidates);
  if (idx === -1 && userKey !== undefined) {
    throw new Error(`column_map key "${userKey}" not found in CSV headers: ${headers.join(", ")}`);
  }
  return idx;
}

// ── Header detection ───────────────────────────────────────────────

// How many leading lines to scan for the real header (bank exports often prepend
// account/metadata rows before it).
const HEADER_SCAN_LIMIT = 25;

/** A line is the header if it resolves a date column plus at least one amount-ish column. */
function looksLikeHeader(headers: string[], columnMap?: ColumnMap): boolean {
  if (tryResolveIndex(headers, columnMap?.date, DATE_HEADERS) === -1) return false;
  const amount = tryResolveIndex(headers, columnMap?.amount, AMOUNT_HEADERS);
  const debit = tryResolveIndex(headers, columnMap?.debit, DEBIT_HEADERS);
  const credit = tryResolveIndex(headers, columnMap?.credit, CREDIT_HEADERS);
  return amount !== -1 || debit !== -1 || credit !== -1;
}

/** Find the header line, skipping any leading metadata/preamble rows. */
function findHeaderRow(lines: string[], columnMap?: ColumnMap): number {
  const limit = Math.min(lines.length, HEADER_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    if (looksLikeHeader(parseCSVLine(lines[i]), columnMap)) return i;
  }
  return 0; // fall back to the first line; downstream resolution throws a helpful error
}

// ── Public ───────────────────────────────────────────────────────────

/**
 * Parse a CSV text into structured rows (raw strings; amounts and dates not yet normalized),
 * plus header-detection metadata so a caller can validate that the right header was found.
 *
 * @param text      - The decoded CSV text (no BOM).
 * @param columnMap - Optional override for column header names.
 * @param skipRows  - Optional number of leading (non-empty) lines to skip before the header;
 *                    omit to auto-detect the header row past any metadata preamble.
 * @throws          If required columns (date + at least one amount column) cannot be found.
 */
export function parseCsvWithMeta(text: string, columnMap?: ColumnMap, skipRows?: number): ParsedCsv {
  // Split into lines, strip carriage returns, drop blank lines.
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");

  if (lines.length === 0) return { rows: [], headers: [], headerRowIndex: 0, preamble: [] };

  // Locate the header row: an explicit skip wins; otherwise auto-detect past any preamble.
  const headerRow =
    skipRows != null ? Math.min(Math.max(skipRows, 0), lines.length - 1) : findHeaderRow(lines, columnMap);
  const headers = parseCSVLine(lines[headerRow]);
  const preamble = lines.slice(0, headerRow);

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

  const rows: StatementRow[] = [];

  for (let i = headerRow + 1; i < lines.length; i++) {
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

  return { rows, headers, headerRowIndex: headerRow, preamble };
}
