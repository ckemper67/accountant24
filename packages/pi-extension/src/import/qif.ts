// QIF (Quicken Interchange Format) statement parsing.
//
// QIF is a much older, line-based format, unrelated to OFX: a `!Type:...` header declares
// the account type, then one record per transaction, one field per line, each line led by a
// single-letter code (D=date, T=amount, P=payee, M=memo, ...), terminated by a lone `^`.
// There is no XML/SGML structure to lean on, so this parses line-by-line rather than
// block-matching like ofx.ts does.
//
// QIF has no currency field (it predates multi-currency exports) and no bank-assigned
// transaction id -- rows carry no `fitid`-equivalent, so dedup falls back to the shared
// (account, date, amount, ordinal) fingerprint in dedup.ts, the same as a CSV row with no
// id column.
//
// Quicken also writes a `'` before 2-digit years in dates on some exports (e.g. "1/15'25"
// for 2025) -- normalized to `/` here so the shared date parser (dates.ts) can handle it
// like any other numeric date.

import type { StatementRow } from "./csv";

/** True if the text looks like a QIF file (starts with a `!Type:` header). */
export function looksLikeQif(text: string): boolean {
  return /^\s*!Type:/im.test(text.slice(0, 4096));
}

/** Normalize Quicken's `'`-before-year date shorthand (e.g. "1/15'25") to a `/` separator. */
function normalizeQifDate(raw: string): string {
  return raw.trim().replace(/'/g, "/");
}

/** Parse QIF statement text into rows ready for the shared import backend. */
export function parseQif(text: string): StatementRow[] {
  const rows: StatementRow[] = [];

  let date: string | undefined;
  let amount: string | undefined;
  let payee = "";
  let memo = "";
  let recordLines: string[] = [];

  const flush = () => {
    if (recordLines.length === 0) return; // nothing accumulated (e.g. blank line before the first record)
    if (!date || !amount) {
      throw new Error(`Malformed QIF record (missing D or T/U line):\n${recordLines.join("\n")}`);
    }
    rows.push({ date: normalizeQifDate(date), amount, description: memo, payee, currency: "" });
    date = undefined;
    amount = undefined;
    payee = "";
    memo = "";
    recordLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line === "^") {
      flush();
      continue;
    }

    const code = line[0];
    const value = line.slice(1).trim();
    switch (code) {
      case "!":
        // Header line (!Type:Bank, !Type:CCard, ...) -- not part of any record.
        continue;
      case "D":
        date = value;
        break;
      case "T":
      case "U":
        // T is the canonical amount; U is Quicken's alternate display amount, only used as
        // a fallback when T is absent.
        if (code === "T" || amount === undefined) amount = value;
        break;
      case "P":
        payee = value;
        break;
      case "M":
        memo = value;
        break;
      default:
        // Other QIF field codes (L=category, N=number, C=cleared, A=address, ...) are not
        // needed for the shared import row shape; ignored rather than erroring so a real
        // statement with extra fields still imports.
        break;
    }
    recordLines.push(line);
  }
  // A file with no trailing "^" (or trailing blank lines after the last one) still has a
  // fully-accumulated record in flight -- flush it.
  flush();

  return rows;
}
