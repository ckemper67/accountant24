# Proposal: bulk statement import tooling

## Context

A user imported 2,000+ transactions into their Accountant24 ledger and reported six
friction points. Today's tools (`add_transactions`, `extract_text`, `modify_transactions`)
are built for a handful of transactions at a time, so the user fell back to hand-written
Python/bash: generating journal files, `cat >>`-appending them, writing hundreds of
`if 'TRADER JOE' in desc` categorization rules, manually diffing a 312-line OFX against 17
already-imported rows, and retrying on latin-1 decode errors.

The six pain points, verbatim from the feedback:

1. **No batch import.** `add_transactions` is fine for a few transactions, but importing
   2,000+ meant generating journal files via Python scripts and copying them in with bash. A
   tool that accepts a CSV/OFX/QBO file directly and bulk-imports would have saved hours.
2. **Manual dedup.** Given a longer BayFed OFX after a short one, the user had to manually
   compare all 312 transactions against the 17 already imported to find the 295 new ones.
   Import with built-in dedup (matching on date + amount + name) would catch this
   automatically.
3. **No OFX/QBO parser.** `extract_text` only handles PDFs and images. OFX and CSV had to be
   regex-parsed with bash/Python, which is fragile. A structured financial-file parser (OFX,
   QBO, CSV with flexible headers) would be cleaner.
4. **Manual categorization.** The user wrote long Python scripts with hundreds of
   `if 'TRADER JOE' in desc: return groceries` rules. There is no pattern-matching tool that
   learns from existing ledger data -- once a few Trader Joe's or Amazon entries are
   categorized, the rest could auto-match.
5. **Appending to monthly files.** Each import session meant appending to multiple existing
   journal files (e.g. `2025/01` already had BayFed + Citi + MM, then needed Checking +
   Chase). Using `edit` for bulk appends does not scale; the user resorted to `cat >>`, which
   felt hacky.
6. **Encoding gotchas.** German characters (u/a/o umlauts, sharp-s) in CSV files caused UTF-8
   decode errors. Better encoding detection upfront would remove the "oh right, latin-1"
   retry.

The user named the two biggest wins as a bulk CSV/OFX import tool with dedup, and a
categorization engine that learns from ledger history.

This is a broad ideas document: a survey of candidate tools across all six pain points,
lighter on implementation, meant to help decide what to build. Where it matters, it notes
which existing utilities each idea would reuse (the codebase's convention is a thin tool
wrapper that delegates to `ledger/`-style logic and routes all writes through one locked,
validated pipeline). As of this writing there is no dedup, CSV/OFX import, categorization,
or non-UTF-8 encoding support anywhere in the codebase.

Notably, `packages/pi-extension/src/system-prompt/system.md` already anticipates imports --
it documents tags `original_payee_name`, `original_description`, `related_file`, and the rule
"category: the user's explicit category wins; otherwise use ledger history for that payee."
The ideas below build on that existing intent rather than inventing new conventions.

Recommended starting point: **CSV** (reusing `parseCSVLine`); add OFX/QBO in a later pass.

## The ideas, by pain point

### Idea 1 -- `import_transactions` tool (pain #1, #3, #5; the anchor)

One tool that takes a workspace-relative path to a bank export and bulk-imports it.

- **Input**: `file_path` (confined via `resolveWorkspacePath`, `files/paths.ts`), the ledger
  `account` the statement belongs to (e.g. `Assets:Bank:BayFed:Checking`), an optional
  `column_map` for CSV, and a `dry_run` flag.
- **CSV first**: reuse `parseCSVLine` + `parseAmount` (`ledger/briefing.ts`). Support
  flexible headers and separate debit/credit columns; auto-detect common header names when
  `column_map` is omitted. OFX/QBO parsing is a later phase (see Idea 5).
- **Writing (#5)**: build `AddTransactionParams[]` and route through the existing
  `addTransactions()` (`ledger/transactions.ts`). That reuses monthly-file routing,
  commodity declaration, `main.journal` include maintenance, `withLedgerLock`, and
  `hledger check --strict` -- so bulk appends stop being a hand-rolled `cat >>` and scale to
  2000 rows through the same validated path as a single add.
- **Preserve provenance**: write `import_id`, `original_payee_name`, and
  `original_description` tags so nothing from the bank row is lost and each row stays
  re-identifiable on re-import (see Idea 2 for the `import_id` scheme).
- **`dry_run`**: parse + dedup + categorize + validate, then report a summary and sample
  WITHOUT writing (mirror the snapshot/restore in `modify.ts`). Lets the agent preview a
  large import before committing.

This is the anchor other ideas plug into.

### Idea 2 -- built-in dedup (pain #2)

Fold dedup into `import_transactions` (and/or expose a `find_duplicate_transactions` probe).
Both formats share one generic transaction id so dedup is a single code path.

- **One canonical tag, `import_id`, namespaced by source** so values never collide across
  formats or institutions:
  - OFX/QBO: `import_id: ofx:<institution>:<FITID>` -- the bank-assigned id; exact.
  - CSV: `import_id: csv:<hash>` -- a derived, deterministic hash.
- **Dedup is format-agnostic**: read existing `import_id:` tags via
  `hledger print -f main.journal -O json` (reuse the discovery pattern in `ledger/modify.ts`),
  then skip any incoming id already present. Report counts (parsed / new / skipped) and list
  the skipped rows so re-importing a longer statement over a shorter one just works -- no
  manual 312-vs-17 diff.
- **CSV derived id** = hash of `account | date | amount | normalized-description | occurrence
  ordinal`. The ordinal (0, 1, 2... assigned to identical keys within a file) keeps genuine
  same-day duplicates -- two identical coffees -- distinct instead of collapsing them into one.
- **Correctness backstop: multiset reconciliation, not just set membership.** Count existing
  transactions sharing the same base fingerprint (K) versus the file's count (N) and import
  only `N - K`. This keeps re-imports idempotent even when row order shifts between exports,
  where the ordinal alone would not be stable. OFX skips this entirely because the FITID is
  authoritative.
- Note: a FITID is unique only within an account at one institution, which is why the
  `import_id` value is namespaced rather than a bare FITID.

### Idea 3 -- `suggest_accounts`, a learning categorizer (pain #4; the second "big win")

Shared logic in a new `ledger/categorize.ts`, usable inline by `import_transactions` and as
its own tool -- replacing hand-written `if 'TRADER JOE' ...` chains.

- Index history from `hledger print -O json`: map each transaction's payee/description to its
  non-asset/liability counterpart account, with frequency counts.
- Match an incoming description: exact payee first, then token/substring
  (`TRADER JOE'S #123` -> `TRADER JOE`); return the most frequent account plus a confidence
  (match count). Amount sign disambiguates income vs expense. This directly implements the
  system.md rule "use ledger history for that payee."
- Standalone tool: accept a batch of `{ description, amount }`, return best-guess accounts +
  confidence; unmatched -> `Expenses:Uncategorized`. Categorize once, reuse across a session.

### Idea 4 -- locale robustness: encoding + numbers + dates (pain #6)

Deterministic helpers so foreign-locale exports "just work" without the LLM eyeballing raw
bytes, separators, or ambiguous dates. All are small, testable, and shared by every import
path. Numbers and dates follow one common principle: **detect per-column across the whole
file (not per-value), disambiguate using out-of-range components, always allow an explicit
override, and echo the inferred format back to the user** -- with `hledger check --strict` as
the backstop.

**Encoding auto-detection (`import/encoding.ts`).**

- Check BOM; attempt strict UTF-8 decode; on failure fall back to windows-1252/latin-1 via
  `TextDecoder`. (For OFX later, honor the header's `ENCODING`/`CHARSET`.)
- Removes the "oh right, latin-1" retry for German umlauts. Low effort, high annoyance-removal.

**Number-format detection and normalization (`import/numbers.ts`).**

- The existing `parseAmount` (`ledger/briefing.ts`) assumes US format: it strips `,` as a
  thousands separator and treats `.` as the decimal point, so a German `1.234,56` silently
  becomes `1.23456`. This is needed for CSV import the moment a German bank export appears --
  it is not PDF-specific.
- **Detect per-column/per-document, not per-value.** A lone `1.234` is ambiguous (1234 vs
  1.234); the whole column disambiguates: whichever separator appears last and is followed by
  1-2 digits is the decimal, and when both separators occur the rightmost is the decimal.
- **Grouping/decimal chars to recognize** (decimal is one of `. ,`; grouping is one of
  `, . space NBSP ' none`): US/UK `1,234.56`, German `1.234,56`, French/SI space or
  non-breaking-space `1 234,56` (the NBSP is a common invisible gotcha), Swiss apostrophe
  `1'234.56`. Indian lakh/crore grouping (`12,34,567.89`) is explicitly out of scope --
  detect and reject with a clear message rather than mis-parse.
- **Sign/negative conventions**: leading vs trailing `-`, parenthesized accounting negatives
  `(1,234.56)` -> `-1234.56`, `CR`/`DR` or `S`/`H` (Soll/Haben) markers, separate
  debit/credit columns, and non-ASCII minus glyphs (Unicode minus U+2212, en-dash) that some
  banks emit.
- **Always allow an explicit override** (`number_format: "de" | "us" | ...` on the import
  tool). Detection is a heuristic and a wrong guess corrupts amounts silently, so the tool
  reports the inferred format back to the user.
- Reusable by any future "parse extracted PDF text into rows" path; PDF line-break/reflow
  cleanup itself is intentionally out of scope (layouts vary too much for a reliable
  deterministic cleaner, and the LLM already un-wraps mangled `extract_text` output well).

**Date-format detection and normalization (`import/dates.ts`).**

- Higher stakes than numbers: the date decides which `YYYY/MM.journal` file a transaction
  lands in, and `modify_transactions` deliberately cannot fix dates afterward (changing a
  date means moving the entry, not editing text). A mis-parsed date is expensive to unwind,
  so getting this right up front matters more than for any other field.
- **Formats**: ISO `YYYY-MM-DD` (our normalization target), US `MM/DD/YYYY`, EU
  `DD/MM/YYYY`, German dotted `DD.MM.YYYY`, 2-digit years, and textual months
  (`15. Jan 2025`, `Jan 15, 2025`) with locale-dependent month names.
- **Disambiguate `03/04/2025` per-column, not per-row**: scan the column for any value whose
  first component is `>12` to force day/month order. If *every* row is ambiguous (all
  components `<=12`), detection cannot decide -- fall back to an explicit `date_format`
  override or the statement's known reporting period, and echo the chosen order back.

### Idea 5 -- OFX/QBO parser (pain #3; later phase)

New `import/ofx.ts` for the SGML and XML variants: extract `STMTTRN` records (`DTPOSTED`,
`TRNAMT`, `NAME`/`MEMO`, `FITID`, `CHECKNUM`). Feeds the same `import_transactions` pipeline
and provides an authoritative `import_id` (`ofx:<institution>:<FITID>`), making dedup exact
rather than heuristic (Idea 2). Deferred because it is the largest single piece and CSV
covers the common case first.

### Idea 6 (optional) -- `parse_statement` preview / structured read

A read-only sibling of `extract_text` that returns parsed rows as structured JSON without
writing, for inspection/transform. Largely subsumed by `import_transactions` `dry_run`;
list it only if a pure "look, don't touch" step proves useful in practice.

## Suggested priority

1. `import_transactions` (CSV) + locale robustness (encoding + numbers + dates) + dedup --
   the core loop, one PR.
2. `suggest_accounts` categorizer (wire into import once it exists).
3. OFX/QBO parser (adds FITID dedup).
4. Optional `parse_statement` preview, only if dry_run proves insufficient.

## Reuse inventory (do NOT re-implement)

- `parseCSVLine`, `parseAmount` -- `ledger/briefing.ts` (note: `parseAmount` is US-only;
  extend or wrap it for locale number formats per Idea 4)
- `addTransactions()` (routing, commodities, lock, validate) -- `ledger/transactions.ts`
- `withLedgerLock` -- `ledger/lock.ts`; snapshot/rollback + `dry_run` -- `ledger/modify.ts`
- `hledger print -O json` discovery -- `ledger/modify.ts`
- `resolveWorkspacePath` -- `files/paths.ts`; `listPayees`/`listAccounts` -- `ledger/*.ts`
- Tool pattern (typebox `Type.Object`, `ToolDefinition`) -- any `tools/*.ts`; register with
  `pi.registerTool(...)` in `extension.ts` (prompt snippet injected automatically).
- Import tag conventions already documented in `system-prompt/system.md`.

## Verification (when a build lands)

- `npm run typecheck` and `npm test` (vitest), spec-first per `AGENTS.md`: fixtures for CSV
  with latin-1 German chars, number formats (`1.234,56`, `1 234,56` with NBSP, `1'234.56`,
  parenthesized negatives, trailing-`-`/Soll-Haben signs) with detection and
  explicit-override cases, date formats (US `MM/DD` vs EU `DD/MM` vs dotted `DD.MM`, the
  `03/04` ambiguity resolved by an out-of-range row and the all-ambiguous fallback), dedup
  overlap (short then long statement), and categorization ranking from a seeded ledger.
- End-to-end: point `ACCOUNTANT24_HOME` at a scratch workspace, `npm run start:agent`, drop a
  CSV into `files/`, call `import_transactions` with `dry_run` then for real; confirm dupes
  are skipped and `hledger check --strict` passes.
- Optionally add a bulk-import eval case under `packages/evals/cases/`.
