// OFX (Open Financial Exchange) statement parsing.
//
// OFX 1.x is SGML, not XML: only aggregate (container) tags are closed with a matching
// </TAG> -- leaf value tags (e.g. <DTPOSTED>20250115120000[-8:PST]) are never closed; the
// value runs to the next tag or end of line. A general SGML-to-tree parser is unnecessary
// here since only a handful of known leaf fields are needed per transaction: each
// <STMTTRN>...</STMTTRN> block is extracted and the leaf fields are regexed out of it
// directly, the same targeted-extraction approach csv.ts and the PDF table extractor use
// rather than reaching for a dependency.
//
// Only <NAME> is read for the payee, not <PAYEE> -- in the OFX spec <PAYEE> is itself an
// aggregate (NAME/ADDR1/CITY/...), not a leaf, so treating it as one would misparse it.

import type { StatementRow } from "./csv";

export interface OfxRow extends StatementRow {
  /** The bank-assigned FITID for this transaction, when present -- a durable dedup key. */
  fitid?: string;
}

export interface OfxParseResult {
  rows: OfxRow[];
  /** Number of distinct <BANKACCTFROM>/<CCACCTFROM> account blocks found in the file. */
  accountCount: number;
}

/** True if the text looks like an OFX file (SGML header or <OFX> root tag). */
export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096);
  return /OFXHEADER:/i.test(head) || /<OFX>/i.test(head);
}

/** Extract a leaf tag's value (text up to the next tag/newline), or undefined if absent/empty. */
function extractLeaf(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^\\r\\n<]*)`, "i").exec(block);
  const value = match?.[1]?.trim();
  return value || undefined;
}

/** Convert an OFX date ("20250115120000[-8:PST]" or "20250115") to ISO YYYY-MM-DD. */
function ofxDateToIso(raw: string): string {
  const digits = raw.slice(0, 8);
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`Cannot parse OFX date "${raw}": expected an 8-digit YYYYMMDD prefix.`);
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** Parse OFX statement text into rows ready for the shared import backend. */
export function parseOfx(text: string): OfxParseResult {
  const accountCount = (text.match(/<(BANKACCTFROM|CCACCTFROM)>/gi) ?? []).length;

  // CURDEF is declared once per statement, ahead of the transaction list.
  const currency = extractLeaf(text, "CURDEF") ?? "";

  const rows: OfxRow[] = [];
  const blockRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text))) {
    const block = match[1];
    const dtposted = extractLeaf(block, "DTPOSTED");
    const amount = extractLeaf(block, "TRNAMT");
    if (!dtposted || !amount) {
      throw new Error(`Malformed <STMTTRN> block (missing DTPOSTED or TRNAMT):\n${block.trim().slice(0, 300)}`);
    }

    rows.push({
      date: ofxDateToIso(dtposted),
      amount,
      description: extractLeaf(block, "MEMO") ?? "",
      payee: extractLeaf(block, "NAME") ?? "",
      currency,
      fitid: extractLeaf(block, "FITID"),
    });
  }

  return { rows, accountCount };
}
