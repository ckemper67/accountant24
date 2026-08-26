// OFX (Open Financial Exchange) statement parsing.
//
// OFX 1.x is SGML, not XML: only aggregate (container) tags are closed with a matching
// </TAG> -- leaf value tags (e.g. <DTPOSTED>20250115120000[-8:PST]) are never closed; the
// value runs to the next tag or end of line. A general SGML-to-tree parser is unnecessary
// here since only a handful of known aggregate blocks are needed (STMTTRN, LEDGERBAL,
// BANKTRANLIST): each is extracted with a targeted regex and the leaf fields are regexed
// out of it directly, the same targeted-extraction approach csv.ts and the PDF table
// extractor use rather than reaching for a dependency. This is sound specifically because
// none of these aggregates nest inside themselves in OFX 1.x -- if a needed field ever
// lived inside a self-nesting aggregate, or the field set stopped being known ahead of
// time, a real tag-stream parser would become the right tool.
//
// Only <NAME> is read for the payee, not <PAYEE> -- in the OFX spec <PAYEE> is itself an
// aggregate (NAME/ADDR1/CITY/...), not a leaf, so treating it as one would misparse it.
// LEDGERBAL is the same trap: it is a closed aggregate (BALAMT/DTASOF inside), not a leaf.

import type { StatementRow } from "./csv";

export interface OfxRow extends StatementRow {
  /** The bank-assigned FITID for this transaction, when present -- a durable dedup key. */
  fitid?: string;
}

/** The bank's reported ending balance for the statement, when present. */
export interface OfxBalance {
  /** Raw BALAMT string, kept verbatim (like TRNAMT) so the shared backend parses it under
   *  the same forced "us" number_format rather than diverging with a local parseFloat. */
  amount: string;
  /** ISO date the balance is true as-of (DTASOF from LEDGERBAL) -- the primary date to use
   *  for a balance assertion. Some issuers stamp this with the download time rather than
   *  the statement period end, so it can postdate the last transaction in the file. */
  asOfDate: string;
}

export interface OfxParseResult {
  rows: OfxRow[];
  /** Number of distinct <BANKACCTFROM>/<CCACCTFROM> account blocks found in the file. */
  accountCount: number;
  /** Which account block matched: "cc" (CCACCTFROM) or "bank" (BANKACCTFROM), when exactly
   *  one is present. The BALAMT sign convention for a credit card's owed balance is
   *  issuer-dependent and does not always match hledger's negative-liability convention --
   *  this is surfaced so a caller building a balance assertion knows to check it, not
   *  something the parser can resolve on its own. Undefined when accountCount is 0 or >1. */
  accountKind?: "bank" | "cc";
  /** The statement's ending balance (LEDGERBAL), when present. Undefined if LEDGERBAL is
   *  absent or malformed -- a missing/bad balance never blocks importing the transactions. */
  ledgerBalance?: OfxBalance;
  /** ISO end date of the transaction list (DTEND from BANKTRANLIST), when present. Some
   *  issuers emit this exclusive (the day after the last transaction), so prefer
   *  ledgerBalance.asOfDate for a balance assertion date -- this is a fallback/cross-check. */
  statementEndDate?: string;
  /** CURDEF, the statement-level currency, when declared -- the same value applied to every
   *  row's currency. Exposed separately so the caller can pair it with ledgerBalance even
   *  when there are zero transaction rows to read it off of. */
  statementCurrency?: string;
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

/** Extract an aggregate (container) tag's content, or undefined if absent. Only safe for
 *  tags that do not nest inside themselves -- true for every aggregate this file reads. */
function extractBlock(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(text);
  return match?.[1];
}

/** Convert an OFX date ("20250115120000[-8:PST]" or "20250115") to ISO YYYY-MM-DD. */
function ofxDateToIso(raw: string): string {
  const digits = raw.slice(0, 8);
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`Cannot parse OFX date "${raw}": expected an 8-digit YYYYMMDD prefix.`);
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** Parse the LEDGERBAL block (BALAMT/DTASOF), if present and well-formed. A malformed or
 *  unparseable DTASOF drops the balance rather than throwing -- unlike a transaction's
 *  DTPOSTED, a bad balance date should never block importing the transactions themselves. */
function parseLedgerBalance(text: string): OfxBalance | undefined {
  const block = extractBlock(text, "LEDGERBAL");
  if (!block) return undefined;

  const amount = extractLeaf(block, "BALAMT");
  const dtasof = extractLeaf(block, "DTASOF");
  if (!amount || !dtasof) return undefined;

  try {
    return { amount, asOfDate: ofxDateToIso(dtasof) };
  } catch {
    return undefined;
  }
}

/** Parse the account kind from the account-block tag, when exactly one is present. */
function parseAccountKind(text: string, accountCount: number): "bank" | "cc" | undefined {
  if (accountCount !== 1) return undefined;
  if (/<CCACCTFROM>/i.test(text)) return "cc";
  if (/<BANKACCTFROM>/i.test(text)) return "bank";
  return undefined;
}

/** Parse DTEND from the BANKTRANLIST block, if present and well-formed. */
function parseStatementEndDate(text: string): string | undefined {
  const block = extractBlock(text, "BANKTRANLIST");
  if (!block) return undefined;

  const dtend = extractLeaf(block, "DTEND");
  if (!dtend) return undefined;

  try {
    return ofxDateToIso(dtend);
  } catch {
    return undefined;
  }
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

  return {
    rows,
    accountCount,
    accountKind: parseAccountKind(text, accountCount),
    ledgerBalance: parseLedgerBalance(text),
    statementEndDate: parseStatementEndDate(text),
    statementCurrency: currency || undefined,
  };
}
