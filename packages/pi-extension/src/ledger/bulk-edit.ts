import { isAbsolute, relative, resolve } from "node:path";
import { ACCOUNTANT24_WORKSPACE, LEDGER_DIR } from "../config";
import { JournalEditSession } from "./edit-session";
import { HledgerCommandError, hledgerCheck, runHledger } from "./hledger";
import { resolveSafePath } from "./paths";

// ── Types ───────────────────────────────────────────────────────────

/** The transaction/posting fields that are safe to change by surgical text replacement. */
export type BulkEditField = "account" | "payee" | "status" | "tag_set" | "tag_remove";

export interface BulkEditParams {
  field: BulkEditField;
  /** The replacement value: a new account (field "account"), a new payee (field "payee"), a
   * status name — "cleared" | "pending" | "unmarked" (field "status"), or a tag's value
   * (field "tag_set"; "" for a value-less tag). Ignored for field "tag_remove". */
  new_value: string;
  /** Required for field "account": selects which posting to change, by its current account. */
  from_account?: string;
  /** Required for field "payee": the exact current payee to rename, so a fuzzy query never
   * silently rewrites a different, unrelated payee. */
  from_payee?: string;
  /** Required for field "tag_set" and "tag_remove": the tag name to set or remove. */
  tag_name?: string;
}

/** Per-transaction result of a "tag_set"/"tag_remove" edit. */
export type TagOutcome = "added" | "overwritten" | "removed" | "unchanged" | "skipped";

export interface BulkEditResult {
  field: BulkEditField;
  query: string[];
  transactions: number;
  postings: number;
  diffs: Array<{ fullFilePath: string; diff: string }>;
  warnings: string[];
  ledgerIsValid: boolean;
  validationError?: string;
  dryRun: boolean;
  /** Only set for field "tag_set"/"tag_remove": a per-outcome breakdown so an overwrite is
   * never silent (see docs/proposals/bulk-edit-tags.md). */
  tagOutcomes?: Record<TagOutcome, number>;
}

// hledger separates a posting's account from its amount with 2+ spaces or a tab.
const ACCOUNT_AMOUNT_SEP = / {2,}|\t+/;

// A transaction header: date (optional secondary date), optional status, optional
// (code), then the description ("payee | note"). Captures [prefix, description].
const HEADER_RE = /^(\d{4}[-/.]\d{2}[-/.]\d{2}(?:=\d{4}[-/.]\d{2}[-/.]\d{2})?\s+(?:[*!]\s+)?(?:\([^)]*\)\s+)?)(.*)$/;

// A finer header split for status edits: date(s), the gap after them, an optional
// status marker with its trailing whitespace, then the rest (code, description, comment).
const STATUS_HEADER_RE =
  /^(\d{4}[-/.]\d{2}[-/.]\d{2}(?:=\d{4}[-/.]\d{2}[-/.]\d{2})?)([ \t]+|$)([*!](?:[ \t]+|$))?(.*)$/;

/** Journal status markers by their tool-facing names ("" = unmarked). */
const STATUS_MARKERS = { cleared: "*", pending: "!", unmarked: "" } as const;
type BulkEditStatus = keyof typeof STATUS_MARKERS;

// ── Public ──────────────────────────────────────────────────────────

/**
 * Run an hledger query and change one field on every matching transaction.
 * Supported fields (safe surgical text replacements):
 *   - account:    move postings in `from_account` to `new_value` (a new account).
 *   - payee:      replace each transaction's payee with `new_value`.
 *   - status:     set the header status marker to `new_value` (cleared/pending/unmarked).
 *   - tag_set:    ensure `tag_name` is present with value `new_value` ("" for value-less).
 *   - tag_remove: delete `tag_name` where present.
 *
 * `query` is an array of hledger query terms. Each element is passed verbatim as one
 * argv token to `hledger` (via spawn, never a shell), so a term containing spaces such
 * as `desc:whole foods` is a single element and needs no quoting.
 *
 * Edits are surgical (only the named field's text changes; the rest of the transaction
 * is preserved). The whole ledger is validated afterward and the batch is rolled back on
 * any error. `dryRun` previews without writing.
 *
 * Serialization is handled at the tool layer: the bulk_edit_transactions tool is registered
 * executionMode "sequential", so pi never runs it concurrently with another ledger-writing
 * tool. That keeps concurrent read/edit/write/validate cycles from interleaving on shared
 * journal files.
 */
export async function bulkEditTransactions(
  query: string[],
  params: BulkEditParams,
  dryRun = false,
  signal?: AbortSignal,
): Promise<BulkEditResult> {
  validate(query, params);
  const mainPath = resolveSafePath("main.journal", LEDGER_DIR);
  const session = new JournalEditSession();

  const matches = await discover(query, params, mainPath, signal);

  // Edit each file from its last matched transaction upward. Account/payee/status edits are
  // line-count-preserving, so this ordering is not strictly required for them; it matters for
  // tag_set/tag_remove, which can insert or delete a line — editing top-down there would
  // invalidate the `startLine` of every later match in the same file.
  const ordered = [...matches].sort((a, b) => b.startLine - a.startLine);

  const warnings: string[] = [];
  let transactions = 0;
  let postings = 0;
  const isTagField = params.field === "tag_set" || params.field === "tag_remove";
  const tagOutcomes: Record<TagOutcome, number> = { added: 0, overwritten: 0, removed: 0, unchanged: 0, skipped: 0 };

  for (const match of ordered) {
    const content = session.read(match.file);

    if (isTagField) {
      const { newContent, outcome, warn } = applyTagEdit(
        content,
        match,
        params.field === "tag_set",
        params.tag_name as string,
        params.new_value,
      );
      warnings.push(...warn);
      tagOutcomes[outcome] += 1;
      if (outcome === "added" || outcome === "overwritten" || outcome === "removed") {
        session.write(match.file, newContent);
        transactions += 1;
      }
      continue;
    }

    const { newContent, count, warn } =
      params.field === "account"
        ? applyAccountEdit(content, match, params.from_account as string, params.new_value)
        : params.field === "payee"
          ? applyPayeeEdit(content, match, params.from_payee as string, params.new_value)
          : applyStatusEdit(content, match, params.new_value as BulkEditStatus);

    warnings.push(...warn);
    if (count > 0) {
      session.write(match.file, newContent);
      transactions += 1;
      if (params.field === "account") postings += count;
    }
  }

  session.flush();

  // Validate the whole ledger.
  let ledgerIsValid = true;
  let validationError: string | undefined;
  try {
    await hledgerCheck(mainPath, { cwd: ACCOUNTANT24_WORKSPACE, signal });
  } catch (e) {
    if (e instanceof HledgerCommandError) {
      ledgerIsValid = false;
      validationError = e.stderr;
    } else {
      session.restore();
      throw e;
    }
  }

  const base: Omit<BulkEditResult, "ledgerIsValid" | "validationError" | "dryRun"> = {
    field: params.field,
    query,
    transactions,
    postings,
    diffs: session.diff(),
    warnings,
    ...(isTagField ? { tagOutcomes } : {}),
  };

  if (dryRun) {
    session.restore(); // preview only: leave the disk byte-for-byte unchanged
    return { ...base, ledgerIsValid, validationError, dryRun: true };
  }

  if (!ledgerIsValid) {
    session.restore();
    throw new Error(
      `Modification reverted — the ledger would have errors (is the new account declared in accounts.journal?):\n\n${validationError}`,
    );
  }

  return { ...base, ledgerIsValid: true, dryRun: false };
}

// ── Validation ──────────────────────────────────────────────────────

function validate(query: string[], params: BulkEditParams): void {
  if (!Array.isArray(query) || query.length === 0) {
    throw new Error("query must be a non-empty array of hledger query terms.");
  }
  for (const term of query) {
    if (!term || term.trim() === "") {
      throw new Error("query terms must not be empty.");
    }
    // Query terms never start with '-'; reject to prevent hledger option injection.
    if (term.startsWith("-")) {
      throw new Error(`Invalid query term "${term}": query terms must not start with '-'.`);
    }
  }
  if (
    params.field !== "account" &&
    params.field !== "payee" &&
    params.field !== "status" &&
    params.field !== "tag_set" &&
    params.field !== "tag_remove"
  ) {
    throw new Error(
      `Unsupported field: ${params.field}. Expected "account", "payee", "status", "tag_set", or "tag_remove".`,
    );
  }
  // tag_remove never reads new_value; tag_set allows "" (a value-less tag) where every
  // other field requires a non-empty value.
  if (params.field !== "tag_remove") {
    if (params.field !== "tag_set" && (!params.new_value || params.new_value.trim() === "")) {
      throw new Error("new_value must not be empty.");
    }
    if (params.new_value !== params.new_value.trim()) {
      throw new Error("new_value must not have leading or trailing whitespace.");
    }
  }
  if (params.field === "account") {
    if (!params.from_account || params.from_account.trim() === "") {
      throw new Error('from_account is required when field is "account".');
    }
    // hledger separates a posting's account from its amount with 2+ spaces or a tab, so an
    // account name containing either would be silently truncated when the line is re-parsed.
    if (/ {2,}|\t/.test(params.new_value)) {
      throw new Error("new_value (account) must not contain a tab or two or more consecutive spaces.");
    }
  }
  if (params.field === "payee") {
    if (!params.from_payee || params.from_payee.trim() === "") {
      throw new Error('from_payee is required when field is "payee".');
    }
    // '|' separates payee from note and ';' begins a comment; either in a payee value would
    // shift the header's parse boundaries and change more than the payee.
    if (/[|;]/.test(params.new_value)) {
      throw new Error("new_value (payee) must not contain '|' or ';'.");
    }
  }
  if (params.field === "status" && !(params.new_value in STATUS_MARKERS)) {
    throw new Error('new_value (status) must be "cleared", "pending", or "unmarked".');
  }
  if (params.field === "tag_set" || params.field === "tag_remove") {
    if (!params.tag_name || params.tag_name.trim() === "") {
      throw new Error(`tag_name is required when field is "${params.field}".`);
    }
    if (params.tag_name !== params.tag_name.trim()) {
      throw new Error("tag_name must not have leading or trailing whitespace.");
    }
    // A comma or colon in the name would be read by hledger as a tag/value boundary, and
    // this tool's own locator regex needs an unambiguous name to match against.
    if (/[,:\s]/.test(params.tag_name)) {
      throw new Error("tag_name must not contain ',', ':', or whitespace.");
    }
  }
  if (params.field === "tag_set") {
    // A comma would be read as a second tag by hledger; a newline would break the
    // comment-line model entirely.
    if (/[,\n]/.test(params.new_value)) {
      throw new Error("new_value (tag) must not contain ',' or a newline.");
    }
  }
}

// ── Discovery ───────────────────────────────────────────────────────

interface Match {
  file: string; // absolute path to the journal file the transaction lives in
  startLine: number; // 1-based line of the transaction's first (header) line
  /** Only populated for tag_set/tag_remove: hledger's own [name, value] pairs for this
   * transaction, the authoritative source for whether a tag is present and its value. */
  ttags?: Array<[string, string]>;
}

async function discover(
  query: string[],
  params: BulkEditParams,
  mainPath: string,
  signal?: AbortSignal,
): Promise<Match[]> {
  // Each query element is one argv token — spaces inside a term are preserved by spawn.
  const stdout = await runHledger(["print", "-f", mainPath, ...query, "-O", "json"], {
    cwd: ACCOUNTANT24_WORKSPACE,
    signal,
  });

  let txns: unknown;
  try {
    txns = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(txns)) return [];

  const matches: Match[] = [];
  for (const tx of txns) {
    // An "account" edit only touches transactions that actually hold a posting in
    // `from_account`; a "payee" edit applies to every query match.
    if (params.field === "account") {
      const postings = Array.isArray(tx?.tpostings) ? tx.tpostings : [];
      const hit = postings.some((p: { paccount?: string }) => p?.paccount === params.from_account);
      if (!hit) continue;
    }

    const loc = parseSourcePos(tx?.tsourcepos);
    if (!loc) continue;
    const absFile = resolveSourceFile(loc.sourceName);
    if (!absFile) continue;

    const match: Match = { file: absFile, startLine: loc.sourceLine };
    if (params.field === "tag_set" || params.field === "tag_remove") {
      match.ttags = parseTtags(tx?.ttags);
    }
    matches.push(match);
  }
  return matches;
}

/** hledger's per-transaction `ttags` JSON field: an array of [name, value] pairs. */
function parseTtags(ttags: unknown): Array<[string, string]> {
  if (!Array.isArray(ttags)) return [];
  const out: Array<[string, string]> = [];
  for (const t of ttags) {
    if (Array.isArray(t) && typeof t[0] === "string" && typeof t[1] === "string") out.push([t[0], t[1]]);
  }
  return out;
}

function parseSourcePos(tsourcepos: unknown): { sourceName: string; sourceLine: number } | null {
  if (!Array.isArray(tsourcepos) || tsourcepos.length === 0) return null;
  const start = tsourcepos[0];
  if (!start || typeof start.sourceName !== "string" || typeof start.sourceLine !== "number") return null;
  return { sourceName: start.sourceName, sourceLine: start.sourceLine };
}

/** Resolve an hledger source path to an absolute path, confirming it lives inside the ledger dir. */
function resolveSourceFile(sourceName: string): string | null {
  const abs = isAbsolute(sourceName) ? sourceName : resolve(ACCOUNTANT24_WORKSPACE, sourceName);
  try {
    resolveSafePath(relative(LEDGER_DIR, abs), LEDGER_DIR);
  } catch {
    return null;
  }
  return abs;
}

// ── Editing ─────────────────────────────────────────────────────────

interface ApplyResult {
  newContent: string;
  count: number; // postings changed (account edit) or 1/0 (payee edit)
  warn: string[];
}

/** Rewrite every posting in `sourceAccount` within one matched transaction to `newAccount`. */
function applyAccountEdit(content: string, match: Match, sourceAccount: string, newAccount: string): ApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const warn: string[] = [];
  let count = 0;

  // The header is at 0-based index startLine-1; the posting block follows it.
  for (let idx = match.startLine; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") break; // blank line ends the transaction
    if (!/^\s/.test(line)) break; // non-indented line ends the transaction
    if (line.replace(/^\s+/, "").startsWith(";")) continue; // comment line

    const rewritten = rewritePostingLine(line, sourceAccount, newAccount);
    if (rewritten) {
      lines[idx] = rewritten;
      count += 1;
    }
  }

  if (count === 0) {
    warn.push(
      `Skipped a matched transaction at ${match.file}:${match.startLine} — no "${sourceAccount}" posting found to move.`,
    );
  }

  return { newContent: lines.join(eol), count, warn };
}

/**
 * If the posting's account equals `sourceAccount`, return the line with the account
 * swapped to `newAccount`, keeping the amount at its original column. Null otherwise.
 */
function rewritePostingLine(line: string, sourceAccount: string, newAccount: string): string | null {
  const indent = line.match(/^\s+/)?.[0] ?? "";
  // Optional posting status marker (cleared '*' / pending '!') precedes the account.
  const status = line.slice(indent.length).match(/^[*!]\s+/)?.[0] ?? "";
  const body = line.slice(indent.length + status.length);

  const sepMatch = body.match(ACCOUNT_AMOUNT_SEP);
  let account = (sepMatch ? body.slice(0, sepMatch.index) : body).replace(/\s+$/, "");

  // Virtual '(acct)' / balanced-virtual '[acct]' postings — hledger reports the bare
  // account name, so unwrap for comparison and re-wrap with the same brackets on rewrite.
  let open = "";
  let close = "";
  if (account.startsWith("(") && account.endsWith(")")) {
    [open, close, account] = ["(", ")", account.slice(1, -1)];
  } else if (account.startsWith("[") && account.endsWith("]")) {
    [open, close, account] = ["[", "]", account.slice(1, -1)];
  }
  if (account !== sourceAccount) return null;

  const prefix = `${indent}${status}${open}${newAccount}${close}`;

  // Amountless balancing posting (no separator, or nothing after it): just swap the account.
  const rest = sepMatch ? body.slice((sepMatch.index ?? 0) + sepMatch[0].length) : "";
  if (rest.trim() === "") return prefix;

  // Preserve the amount's original column (character offset) so sibling alignment is kept.
  const originalRestCol = indent.length + status.length + (sepMatch?.index ?? 0) + (sepMatch?.[0].length ?? 0);
  const pad = Math.max(2, originalRestCol - prefix.length);
  return `${prefix}${" ".repeat(pad)}${rest}`;
}

/**
 * Rewrite the payee on the matched transaction's header line, preserving the rest.
 * Only rewrites when the header's current payee exactly equals `fromPayee`; a fuzzy
 * hledger query can match transactions with different payees, and this guard keeps the
 * edit from silently renaming an unrelated one.
 */
function applyPayeeEdit(content: string, match: Match, fromPayee: string, newPayee: string): ApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const warn: string[] = [];
  const headerIdx = match.startLine - 1;
  const line = lines[headerIdx] ?? "";

  const parsed = parseHeaderPayee(line);
  if (parsed === null) {
    warn.push(`Could not parse transaction header at ${match.file}:${match.startLine}; left unchanged.`);
    return { newContent: content, count: 0, warn };
  }
  if (parsed.oldPayee !== fromPayee) {
    // A query match whose payee differs from `fromPayee` — leave it untouched.
    return { newContent: content, count: 0, warn };
  }
  if (parsed.oldPayee === newPayee) {
    return { newContent: content, count: 0, warn }; // already named that; no-op
  }

  lines[headerIdx] = renderHeaderPayee(parsed, newPayee);
  return { newContent: lines.join(eol), count: 1, warn };
}

interface ParsedHeader {
  prefix: string; // date, status, and code up to the start of the payee
  oldPayee: string; // the current payee (trailing spaces trimmed)
  gap: string; // spaces between the payee and the '|'/';' separator
  trailing: string; // "| note" / "; comment" / "" (empty when there is no separator)
}

/** Parse a transaction header into its payee and surrounding parts, or null if not a header. */
function parseHeaderPayee(line: string): ParsedHeader | null {
  const m = line.match(HEADER_RE);
  if (!m) return null;

  const prefix = m[1];
  const rest = m[2];

  // The payee runs up to the first '|' (description) or ';' (comment).
  let splitIdx = rest.length;
  for (const ch of ["|", ";"]) {
    const i = rest.indexOf(ch);
    if (i >= 0 && i < splitIdx) splitIdx = i;
  }

  const left = rest.slice(0, splitIdx);
  const oldPayee = left.replace(/\s+$/, "");
  const gap = left.slice(oldPayee.length); // spaces between payee and the separator
  const trailing = rest.slice(splitIdx); // "| note" / "; comment" / ""
  return { prefix, oldPayee, gap, trailing };
}

/** Render a parsed header with its payee swapped for `newPayee`. */
function renderHeaderPayee({ prefix, gap, trailing }: ParsedHeader, newPayee: string): string {
  if (trailing === "") return `${prefix}${newPayee}`;
  // Keep at least one space before '|'/';' so hledger still reads it as a separator, even
  // when the original payee ran right up against it (gap === "").
  const safeGap = gap === "" ? " " : gap;
  return `${prefix}${newPayee}${safeGap}${trailing}`;
}

/**
 * Set the status marker on the matched transaction's header line to `newStatus`,
 * preserving the date, code, description, comments, and original spacing. Posting-level
 * status markers are deliberately left untouched (they override the header only when
 * present, so clearing the header does not change what they assert).
 */
function applyStatusEdit(content: string, match: Match, newStatus: BulkEditStatus): ApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const warn: string[] = [];
  const headerIdx = match.startLine - 1;
  const line = lines[headerIdx] ?? "";

  const m = line.match(STATUS_HEADER_RE);
  if (!m) {
    warn.push(`Could not parse transaction header at ${match.file}:${match.startLine}; left unchanged.`);
    return { newContent: content, count: 0, warn };
  }
  const [, date, gap, marker = "", rest] = m;
  const current: BulkEditStatus = marker.startsWith("*") ? "cleared" : marker.startsWith("!") ? "pending" : "unmarked";
  if (current === newStatus) {
    return { newContent: content, count: 0, warn }; // already there; no-op
  }

  const token = STATUS_MARKERS[newStatus];
  let header: string;
  if (token === "") {
    header = rest === "" ? date : `${date}${gap}${rest}`;
  } else if (rest === "") {
    header = `${date}${gap || " "}${token}`;
  } else {
    // Swapping markers keeps the old marker's trailing whitespace; adding one inserts a space.
    const markerGap = marker ? marker.slice(1) : " ";
    header = `${date}${gap || " "}${token}${markerGap}${rest}`;
  }
  lines[headerIdx] = header;
  return { newContent: lines.join(eol), count: 1, warn };
}

// ── Tag editing ─────────────────────────────────────────────────────
//
// See docs/proposals/bulk-edit-tags.md for the full design and its rationale. In short:
// `ttags` (hledger's own parse) is the source of truth for whether a tag is present and
// what its value is; raw text is only used to locate a dedicated `; name: value` comment
// line to edit. Any other shape (comma-separated, fused into the header's own comment, an
// `apply tag` directive, ...) is left alone with a warning rather than risked -- this tool
// only edits the one shape it (and add_transactions) ever writes itself.

interface TagApplyResult {
  newContent: string;
  outcome: TagOutcome;
  warn: string[];
}

/** A dedicated tag comment line: `; name: value` (or `; name:` for a value-less tag).
 * `[^,]*` also excludes a comma-separated line from matching -- such a line is a shape
 * this function deliberately does not edit. */
function tagLineRegExp(tagName: string): RegExp {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*;\\s*${escaped}\\s*:\\s*([^,]*)$`);
}

/** Render a tag as its dedicated comment line; "" renders a value-less tag. */
function formatTagLine(indent: string, tagName: string, value: string): string {
  return value === "" ? `${indent}; ${tagName}:` : `${indent}; ${tagName}: ${value}`;
}

/** Index just past the last pre-posting comment line (where a new tag line belongs), or
 * `startLine` if the transaction has none. Comment lines share the posting-block boundary
 * rules (a blank or non-indented line ends the transaction) plus stop at the first posting. */
function commentBlockEnd(lines: string[], startLine: number): number {
  let idx = startLine;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === "") break;
    if (!/^\s/.test(line)) break;
    if (!line.replace(/^\s+/, "").startsWith(";")) break; // a posting line ends the comment block
    idx += 1;
  }
  return idx;
}

/** Indentation for a newly inserted tag line: match the transaction's first indented line
 * (a comment or its first posting), falling back to four spaces (`add_transactions`' own
 * convention) only when there is none to infer from. */
function inferIndent(lines: string[], startLine: number): string {
  const line = lines[startLine];
  if (line !== undefined && /^\s/.test(line)) return line.match(/^\s*/)?.[0] ?? "    ";
  return "    ";
}

/**
 * Set or remove one tag on one matched transaction. `ttags` (already fetched by
 * `discover()`) decides whether the tag is present and what its current value is; the
 * raw-text scan below only locates *where* to write the edit, and is deliberately
 * conservative -- any shape it can't confidently confirm against `ttags` is left
 * untouched with a warning (see the module-header comment above).
 */
function applyTagEdit(
  content: string,
  match: Match,
  isSet: boolean,
  tagName: string,
  newValue: string,
): TagApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const warn: string[] = [];
  const ttags = match.ttags ?? [];

  const occurrences = ttags.filter(([name]) => name === tagName);
  if (occurrences.length > 1) {
    warn.push(
      `Skipped a matched transaction at ${match.file}:${match.startLine} — tag "${tagName}" appears more than once; which one to edit is ambiguous.`,
    );
    return { newContent: content, outcome: "skipped", warn };
  }
  const present = occurrences.length === 1;
  const currentValue = present ? occurrences[0][1] : undefined;

  if (!isSet && !present) {
    return { newContent: content, outcome: "unchanged", warn }; // remove_tag: already absent
  }

  // Locate the dedicated comment line, if any, within the pre-posting comment range.
  const re = tagLineRegExp(tagName);
  let foundIdx = -1;
  let foundValue: string | null = null;
  for (let idx = match.startLine; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") break;
    if (!/^\s/.test(line)) break;
    if (!line.replace(/^\s+/, "").startsWith(";")) break; // a posting line ends the comment block
    const m = line.match(re);
    if (m) {
      foundIdx = idx;
      foundValue = m[1].trim();
      break;
    }
  }

  if (present && (foundIdx === -1 || foundValue !== currentValue)) {
    // ttags says the tag exists, but its text couldn't be confirmed on a dedicated line
    // (a comma-separated line, a header-fused comment, an `apply tag` directive, ...).
    warn.push(
      `Skipped a matched transaction at ${match.file}:${match.startLine} — tag "${tagName}" exists but its text could not be safely located to edit.`,
    );
    return { newContent: content, outcome: "skipped", warn };
  }

  if (!isSet) {
    lines.splice(foundIdx, 1); // remove_tag, present and located
    return { newContent: lines.join(eol), outcome: "removed", warn };
  }

  if (present) {
    if (currentValue === newValue) {
      return { newContent: content, outcome: "unchanged", warn };
    }
    const indent = lines[foundIdx].match(/^\s*/)?.[0] ?? "    ";
    lines[foundIdx] = formatTagLine(indent, tagName, newValue);
    return { newContent: lines.join(eol), outcome: "overwritten", warn };
  }

  const insertIdx = commentBlockEnd(lines, match.startLine);
  const indent = inferIndent(lines, match.startLine);
  lines.splice(insertIdx, 0, formatTagLine(indent, tagName, newValue));
  return { newContent: lines.join(eol), outcome: "added", warn };
}
