// Date-format detection and normalization for bank CSV imports.
//
// Target format: ISO 8601 YYYY-MM-DD (what hledger expects and what the monthly
// file router in ledger/transactions.ts uses to pick the right journal file).
//
// Supported input formats:
//   ISO:       2025-01-15  (unambiguous -- always accepted)
//   US:        01/15/2025  (MM/DD/YYYY)
//   EU:        15/01/2025  (DD/MM/YYYY)
//   Dotted:    15.01.2025  (DD.MM.YYYY, German)
//   2-digit:   01/15/25   (pivot year: 00-49 -> 20xx, 50-99 -> 19xx)
//   Textual:   "15. Jan 2025" / "Jan 15, 2025" (day-first and month-first variants)
//
// Disambiguation strategy:
//   Scan the column for any value whose first component is > 12 -- that component
//   must be the day, establishing day-first (DD/MM) order. If every row is ambiguous
//   (all components <= 12) and no explicit override is given, throw a clear error.

export type DateOrder = "mdy" | "dmy";

// Textual month names, English and German. Ordinal: 1-based (Jan = 1).
// German is included because the primary locale for this app writes textual months
// as e.g. "Mai", "Okt", "Dez", "Maerz"/"Marz" (u+00e4). Keys are lowercased.
const MONTH_NAMES: Record<string, number> = {
  // English abbreviations
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // English full
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  // German abbreviations
  mrz: 3,
  "m\u00e4r": 3,
  mai: 5,
  okt: 10,
  dez: 12,
  // German full
  januar: 1,
  februar: 2,
  "m\u00e4rz": 3,
  juni: 6,
  juli: 7,
  oktober: 10,
  dezember: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Assemble an ISO date, validating month/day ranges so a bad parse fails loudly. */
function toIso(year: number, month: number, day: number, raw: string): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date "${raw}": month/day out of range (got ${pad2(month)}-${pad2(day)}).`);
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Expand a 2-digit year to 4 digits: 00-49 -> 20xx, 50-99 -> 19xx. */
function expandYear(y: number): number {
  if (y < 0 || y > 99) return y;
  return y <= 49 ? 2000 + y : 1900 + y;
}

/**
 * Detect the day/month order for a column of date strings.
 *
 * Returns 'mdy' (US: MM/DD/YYYY) or 'dmy' (EU/dotted: DD/MM/YYYY).
 * - ISO dates (YYYY-MM-DD) are skipped; if ALL dates are ISO the result defaults to 'mdy'
 *   (the order is moot because parseDate handles ISO directly).
 * - Throws if the column has non-ISO ambiguous dates and no unambiguous value to resolve.
 */
export function detectDateOrder(samples: string[]): DateOrder {
  let hasNonIso = false;

  for (const raw of samples) {
    const s = raw.trim();

    // ISO dates are unambiguous and do not contribute to order detection.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;

    // Try numeric numeric-separator formats: MM/DD/YYYY or DD/MM/YYYY or DD.MM.YYYY
    const numMatch = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (numMatch) {
      hasNonIso = true;
      const a = Number.parseInt(numMatch[1], 10);
      const b = Number.parseInt(numMatch[2], 10);
      if (a > 12) return "dmy"; // first component > 12 -- must be a day
      if (b > 12) return "mdy"; // second component > 12 -- must be a day (so first is month)
      // Both <= 12: ambiguous, continue scanning.
    }
  }

  if (!hasNonIso) {
    // All dates are ISO (YYYY-MM-DD) or no recognizable numeric dates at all.
    // Return 'mdy' as a safe default; parseDate will handle ISO correctly regardless.
    return "mdy";
  }

  // Every non-ISO row was ambiguous.
  throw new Error(
    "Cannot determine date order: all date values have both components <= 12. " +
      'Specify date_format explicitly (e.g. date_format: "MM/DD/YYYY" or "DD/MM/YYYY").',
  );
}

/**
 * Parse a date string to ISO YYYY-MM-DD.
 *
 * @param raw   - The raw date string from the CSV cell.
 * @param order - The detected or user-supplied day/month order for numeric dates.
 * @returns     ISO date string YYYY-MM-DD.
 * @throws      If the string cannot be parsed.
 */
export function parseDate(raw: string, order: DateOrder): string {
  const s = raw.trim();
  if (!s) throw new Error("Empty date string.");

  // ISO YYYY-MM-DD (unambiguous -- skip order detection).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return toIso(Number.parseInt(iso[1], 10), Number.parseInt(iso[2], 10), Number.parseInt(iso[3], 10), raw);
  }

  // Textual month: "15. Jan 2025" or "Jan 15, 2025" or "January 15 2025".
  // The month class allows Latin letters with diacritics (German "Maerz"/"Marz").
  const textMatch =
    s.match(/^(\d{1,2})\.?\s+([A-Za-z\u00c0-\u024f]+)\.?\s+(\d{2,4})$/) ||
    s.match(/^([A-Za-z\u00c0-\u024f]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (textMatch) {
    let day: number;
    let monthStr: string;
    let yearRaw: number;
    // Which group is which depends on the order captured.
    if (/^[A-Za-z\u00c0-\u024f]/.test(textMatch[1])) {
      // Month-first: "Jan 15, 2025"
      monthStr = textMatch[1];
      day = Number.parseInt(textMatch[2], 10);
      yearRaw = Number.parseInt(textMatch[3], 10);
    } else {
      // Day-first: "15. Jan 2025"
      day = Number.parseInt(textMatch[1], 10);
      monthStr = textMatch[2];
      yearRaw = Number.parseInt(textMatch[3], 10);
    }
    const month = MONTH_NAMES[monthStr.toLowerCase()];
    if (!month) throw new Error(`Unknown month name "${monthStr}" in date "${raw}".`);
    const year = expandYear(yearRaw);
    return toIso(year, month, day, raw);
  }

  // Numeric: MM/DD/YYYY, DD/MM/YYYY, DD.MM.YYYY, or 2-digit year variants.
  const numMatch = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (numMatch) {
    const a = Number.parseInt(numMatch[1], 10);
    const b = Number.parseInt(numMatch[2], 10);
    const c = Number.parseInt(numMatch[3], 10);

    // If first component is 4 digits it is the year (ISO-like YYYY/MM/DD or YYYY.MM.DD).
    if (numMatch[1].length === 4) {
      return toIso(a, b, c, raw);
    }

    // Otherwise use the provided order.
    let day: number;
    let month: number;
    let yearRaw: number;

    if (order === "mdy") {
      month = a;
      day = b;
      yearRaw = c;
    } else {
      day = a;
      month = b;
      yearRaw = c;
    }
    const year = expandYear(yearRaw);
    return toIso(year, month, day, raw);
  }

  throw new Error(`Cannot parse date "${raw}".`);
}
