// Number-format detection and locale-aware amount parsing for bank CSV imports.
//
// Supported formats:
//   US/UK:    1,234.56   (comma thousands, dot decimal)
//   German:   1.234,56   (dot thousands, comma decimal)
//   French/SI: 1 234,56  (space or NBSP thousands, comma decimal)
//   Swiss:    1'234.56   (apostrophe thousands, dot decimal)
//
// Sign conventions recognized:
//   - Leading or trailing minus:  -1234.56  /  1234.56-
//   - Parenthesized accounting:  (1,234.56) -> -1234.56
//   - CR/DR markers:  1234.56 CR  (credit, positive) / 1234.56 DR (debit, negative)
//   - S/H markers (Soll/Haben, German):  1234.56 S (debit) / 1234.56 H (credit)
//   - Unicode minus U+2212 and en-dash U+2013 treated as minus.
//
// Indian lakh/crore grouping (12,34,567.89) is explicitly rejected with an error
// message pointing the user to the number_format override.
//
// Detection is deliberately fail-loud: a wrong format silently corrupts amounts by
// ~1000x (e.g. "1.234,56" read as US becomes 1.23456) and hledger cannot catch it
// because the entry still balances. So when the sample gives conflicting or
// unresolvable evidence, detection THROWS and asks for an explicit number_format
// rather than defaulting to a guess. The only silent default is a separator-free
// column, where every format parses integers identically.

export type NumberFormat = "us" | "de" | "fr" | "ch";

// Space-like thousands separators: regular space, non-breaking space (U+00A0),
// narrow no-break space (U+202F). Global form for stripping, plain form for testing.
const SPACE_SEPARATORS_GLOBAL = /[ \u00a0\u202f]/g;
const SPACE_SEPARATOR = /[ \u00a0\u202f]/;

/** Normalize Unicode minus (U+2212) and en-dash (U+2013) to ASCII minus. */
function normalizeSignGlyphs(s: string): string {
  return s.replace(/[\u2212\u2013]/g, "-");
}

/** Strip leading sign/paren and trailing sign/marker so only the numeric body remains. */
function numericBody(raw: string): string {
  return normalizeSignGlyphs(raw)
    .trim()
    .replace(/^[-(]?\s*/, "")
    .replace(/\s*[)]?\s*(?:CR|DR|S|H)?\s*-?\s*$/i, "");
}

/**
 * Detect the number format from a sample of raw amount strings.
 *
 * @throws if the sample gives conflicting decimal evidence, or a separator is present
 *         but the decimal separator cannot be determined -- callers should surface the
 *         message and let the user pass an explicit number_format.
 */
export function detectNumberFormat(samples: string[]): NumberFormat {
  const bodies = samples.map(numericBody).filter((s) => s.length > 0);

  let commaDecimal = false; // comma seen acting as the decimal separator
  let dotDecimal = false; // dot seen acting as the decimal separator
  let commaGroup = false; // comma seen acting as a thousands separator
  let dotGroup = false; // dot seen acting as a thousands separator
  let hasSpaceThousands = false;
  let hasApostrophe = false;

  for (const body of bodies) {
    if (SPACE_SEPARATOR.test(body)) hasSpaceThousands = true;
    if (body.includes("'")) hasApostrophe = true;

    const dotCount = (body.match(/\./g) ?? []).length;
    const commaCount = (body.match(/,/g) ?? []).length;
    const dotIdx = body.lastIndexOf(".");
    const commaIdx = body.lastIndexOf(",");

    if (dotIdx !== -1 && commaIdx !== -1) {
      // Both separators present -- the rightmost one is the decimal.
      if (dotIdx > commaIdx) {
        dotDecimal = true;
        commaGroup = true;
      } else {
        commaDecimal = true;
        dotGroup = true;
      }
      continue;
    }

    if (commaIdx !== -1) {
      const after = body.slice(commaIdx + 1);
      if (commaCount > 1)
        commaGroup = true; // 1,234,567 -- comma is grouping
      else if (/^\d{1,2}$/.test(after))
        commaDecimal = true; // 12,34 -- comma is decimal
      else if (/^\d{3}$/.test(after)) commaGroup = true; // 1,234 -- comma likely grouping
      continue;
    }

    if (dotIdx !== -1) {
      const after = body.slice(dotIdx + 1);
      if (dotCount > 1)
        dotGroup = true; // 1.234.567 -- dot is grouping
      else if (/^\d{1,2}$/.test(after))
        dotDecimal = true; // 12.34 -- dot is decimal
      else if (/^\d{3}$/.test(after)) dotGroup = true; // 1.234 -- dot likely grouping
    }
  }

  // Conflicting decimal evidence -- refuse to guess.
  if (commaDecimal && dotDecimal) {
    throw new Error(
      "Ambiguous number format: the sample mixes comma-decimal and dot-decimal amounts. " +
        "Specify number_format explicitly (us, de, fr, ch).",
    );
  }

  if (commaDecimal) return hasSpaceThousands ? "fr" : "de";
  if (dotDecimal) return hasApostrophe ? "ch" : "us";

  // No decimal evidence -- infer the decimal separator from grouping evidence.
  if (dotGroup && !commaGroup) return "de"; // dot is thousands -> comma is decimal
  if (commaGroup && !dotGroup) return hasApostrophe ? "ch" : "us"; // comma is thousands -> dot is decimal
  if (dotGroup && commaGroup) {
    throw new Error(
      "Ambiguous number format: cannot determine the decimal separator from the sample. " +
        "Specify number_format explicitly (us, de, fr, ch).",
    );
  }

  // No separators at all -- integer parsing is identical across every format.
  return "us";
}

/**
 * Parse a locale-aware amount string to a number.
 *
 * @param raw    - The raw string from the CSV cell.
 * @param format - The detected or user-supplied number format.
 * @returns      The parsed number (negative for debits/outflows).
 * @throws       Error if Indian lakh/crore grouping is detected, or if the string
 *               cannot be parsed cleanly under the given format.
 */
export function parseLocaleAmount(raw: string, format: NumberFormat): number {
  const s = normalizeSignGlyphs(raw.trim());
  if (s === "" || s === "-" || s === "0") return 0;

  // Parenthesized accounting negative: (1.234,56) -> -1234.56
  const isParenNegative = s.startsWith("(") && s.endsWith(")");
  let body = isParenNegative ? s.slice(1, -1) : s;

  // Extract trailing CR/DR / S/H markers.
  let sign = 1;
  const trailingMatch = body.match(/[+\-\s]*(CR|DR|S|H)\s*$/i);
  if (trailingMatch) {
    const marker = trailingMatch[1].toUpperCase();
    // DR and S (Soll) are debits (negative); CR and H (Haben) are credits (positive).
    if (marker === "DR" || marker === "S") sign = -1;
    body = body.slice(0, body.length - trailingMatch[0].length);
  }

  // Trailing minus: 1234.56-
  if (body.endsWith("-")) {
    sign *= -1;
    body = body.slice(0, -1);
  }

  // Leading minus.
  if (body.startsWith("-")) {
    sign *= -1;
    body = body.slice(1);
  }

  if (isParenNegative) sign *= -1;

  body = body.trim();

  // Reject Indian lakh/crore grouping (a 3-digit group preceded by a 2-digit group).
  if (/\d,\d{2},\d{3}/.test(body)) {
    throw new Error(
      `Indian lakh/crore number grouping detected in "${raw}". ` +
        "Specify number_format explicitly to override (supported: us, de, fr, ch).",
    );
  }

  // Strip grouping separators and normalize the decimal separator to '.'.
  let normalized: string;
  switch (format) {
    case "us":
      normalized = body.replace(/,/g, "");
      break;
    case "de":
      normalized = body.replace(/\./g, "").replace(/,/g, ".");
      break;
    case "fr":
      normalized = body.replace(SPACE_SEPARATORS_GLOBAL, "").replace(/,/g, ".");
      break;
    case "ch":
      normalized = body.replace(/'/g, "");
      break;
    default:
      normalized = body;
  }

  // After normalization the body must be a plain decimal number. Anything else
  // (e.g. a stray second separator from a malformed or misdetected value) is a
  // parse failure rather than a silent truncation.
  if (!/^\d*\.?\d+$/.test(normalized)) {
    throw new Error(`Cannot parse amount "${raw}" as a number (format: ${format}).`);
  }

  const n = Number.parseFloat(normalized);
  if (Number.isNaN(n)) {
    throw new Error(`Cannot parse amount "${raw}" as a number (format: ${format}).`);
  }

  return sign * n;
}
