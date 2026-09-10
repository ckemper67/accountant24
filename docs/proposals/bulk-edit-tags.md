# Proposal: tag support in `bulk_edit_transactions`

*Revised twice: once after an architecture review found a data-loss bug in an earlier
two-priority editing scheme (fixed by unifying into one algorithm), and again after a
simplification review found that unified algorithm itself was more than the common case
needs. The current design narrows editing to the one shape this codebase's own tools
ever write, and treats every other shape as an existing, already-necessary skip+warn
case rather than a new one to parse.*

## Motivation

`bulk_edit_transactions` currently handles three actions -- `change_account`,
`change_payee`, `set_status` -- but has no way to add or remove a **tag** across a batch
of matching transactions. Tags are already a first-class concept elsewhere in the app
(`listTags()`, the `<tags>` context block, the `:tag[name]` mention chip, and
`system.md`'s rule to tag imports with `original_payee_name` / `original_description` /
`related_file`), so a bulk tagging pass -- e.g. "tag every Amazon purchase this year
`review`" -- is a natural gap.

## How hledger actually represents tags

`add_transactions` (`ledger/transactions.ts`), the only existing writer of tags in this
codebase, always emits one tag per comment line, right after the header:

```
2026-03-14 * Amazon
    ; original_payee_name: AMAZON.COM
    ; related_file: files/2026/03/receipt.pdf
```

hledger's grammar is more permissive than this -- it also accepts multiple
comma-separated tags on one line, and tags fused into a transaction's or posting's
description-trailing comment -- but this codebase never writes those shapes itself, and
a personal ledger's tags come either from this app's own tools or from a user hand-
editing in a reasonably disciplined way, not from an adversarial or wildly heterogeneous
external source. **This design edits exactly the shape this codebase writes** --
a dedicated `; name: value` (or `; name:` for value-less) comment line -- and, for
anything else, falls back to the same conservative behavior the design already needs
for other reasons (see below): confirm via `ttags`, skip with a warning if the text
can't be confidently located and edited.

`ttags` -- the flat `[name, value]` array in `hledger print -O json`'s per-transaction
output -- is the source of truth for whether a tag is present and what its value is;
`dedup.ts`'s `tagValue()` already trusts this same field rather than re-parsing comment
text by hand. Raw text is only consulted to locate *where* to write the edit.

A tag requires a colon in hledger's grammar; a plain `; review` with no colon is just a
comment and never appears in `ttags`.

Posting-level tags (`ptags`) stay out of scope -- `ttags` already excludes them, and
restricting the search to the comment lines between the header and the first posting
(see Editing) structurally guarantees a posting's own comment is never touched.

## Proposed schema

Two new actions, following the existing `action` + `from`/`to` shape
(`tools/bulk-edit-transactions.ts`):

| Action | `tag` | `from` | `to` | Effect |
| --- | --- | --- | --- | --- |
| `set_tag` | required (tag name) | unused | required (tag value; pass `""` for a value-less tag) | Ensure every matched transaction carries this tag with this value. |
| `remove_tag` | required (tag name) | unused | unused | Delete this tag from every matched transaction that has it. |

`tag` is a new top-level param (name), parallel to `from`/`to`, required only for these
two actions -- the same conditional-requirement pattern the tool already uses for `from`
on `change_account`/`change_payee`.

`to` stays `Type.String(...)` (required) exactly as it is today -- **no schema
weakening**. `set_tag` expresses a value-less tag as `to: ""` rather than by omitting
`to`. This keeps the free presence guarantee TypeBox already gives the three existing
actions, with no new "`to` is required" checks to add anywhere.

### Ledger layer (`ledger/bulk-edit.ts`)

- `BulkEditField` gains `"tag_set"` and `"tag_remove"`.
- `BulkEditParams` gains `tag_name?: string` (required for both) and reuses `new_value`
  for the tag's value on `tag_set` (`""` means value-less; the existing "`new_value`
  must not be empty" check is scoped to exclude `tag_set`, but the sibling "`new_value`
  must not have leading or trailing whitespace" check is **kept** for it -- see
  Validation below for why).
- `discover()` already fetches `print -O json` per query match; it's extended to keep
  each match's `ttags` alongside `file`/`startLine`, so the apply step can consult the
  authoritative current value without a second hledger call.

#### Editing (`applyTagEdit`)

For each match, classify against `ttags`:

| `ttags` state | `set_tag` | `remove_tag` |
| --- | --- | --- |
| Tag absent | insert | no-op (not a warning -- "already doesn't have it" isn't a mistake) |
| Tag present, same value | no-op | delete |
| Tag present, different value | overwrite | delete |
| Tag present per `ttags`, but not on its own dedicated comment line anywhere in the transaction's pre-posting comment range (comma-separated line, fused into the header's trailing comment, injected by an `apply tag` directive, or any other shape this tool doesn't write itself) | skip + warn: can't safely locate it to edit | skip + warn: same |
| Tag name appears **more than once** in `ttags` (malformed/duplicate source) | skip + warn: ambiguous, which one to edit is undefined | skip + warn: same |

The last two rows collapse into one code path: "found in `ttags` but not safely
editable" and "ambiguous" both mean *skip, warn, touch nothing*. Nothing about that path
depends on which of those reasons applied.

The algorithm:

1. Restrict to the comment lines (`;`-prefixed) between the header and the first
   posting line -- exactly the range `applyAccountEdit` already walks, filtered to
   comment lines.
2. Match each such line against
   `^\s*;\s*<escaped_tag_name>\s*:\s*([^,]*)$` (`tag_name` regex-escaped -- see
   Validation; the `[^,]*` at the end additionally guards against matching a line that
   turns out to hold more than one comma-separated tag, which this tool doesn't parse).
3. **Safety guard**: if a line matches, parse its captured value and compare it
   (trimmed) against the value `ttags` reports for that tag. If they disagree, treat it
   as not found (skip + warn) rather than editing a line that might not mean what it
   looks like it means.
4. If found (and confirmed): rewrite the line in place (`set_tag`) or delete it
   (`remove_tag`).
5. If not found anywhere in the range:
   - `ttags` said absent -> insert (below).
   - `ttags` said present -> this is the "present but unlocatable" row -- skip + warn,
     **never insert** (inserting here would create a second, conflicting definition of
     a tag that already exists elsewhere in a shape this tool doesn't parse).

New tags are appended as a new comment line immediately after the last existing comment
line in the pre-posting range (or immediately after the header, if there are none) --
no sort, no attempt to interleave alphabetically among existing tags. hledger doesn't
care about tag ordering, and `add_transactions`' own alphabetical sort is a
new-transaction convenience, not a correctness requirement this tool needs to replicate
when editing an existing one.

Indentation for the new line matches the indentation of the first indented line already
in the transaction (a comment line if one exists, else the first posting -- every valid
hledger transaction has at least one), falling back to four spaces only if neither
exists.

**Line-count changes and edit ordering.** Unlike `account`/`payee`/`status` (always 1:1
line replacements), inserting a new line or deleting the only tag on a line changes the
file's line count. The existing bottom-up processing order
(`[...matches].sort((a, b) => b.startLine - a.startLine)`) already exists specifically
for this -- its docstring already calls out "a future edit type that inserts or removes
lines" -- so **no change to the ordering/session machinery is needed**, only to the
per-match apply step. `JournalEditSession.read()` returns *staged* content (not disk
content), so within one file, edits applied bottom-up compose correctly: an earlier
(lower-line-number) insertion or deletion never shifts the `startLine` of a match still
queued above it, because matches are processed strictly top-to-bottom in the sort order
already used today. This is verified directly in tests (see below), not just assumed
from the docstring.

**Atomicity.** Inherited unchanged from the existing pipeline: every edit in the batch is
staged in the `JournalEditSession`, the whole ledger is `hledger check`ed once at the
end, and the entire batch is rolled back (nothing partially written) if validation
fails or `dryRun` is set. No new failure mode is introduced by tag edits changing line
counts -- the session's snapshot/restore is per-file content, not per-line, so it's
insensitive to how many lines an edit added or removed.

### Validation

- `tag_name`: required, non-empty, no leading/trailing whitespace, and must not contain
  `,`, `:`, or whitespace. Intentionally **stricter** than hledger's own tag-name
  grammar -- the tool only needs to round-trip names it can also unambiguously *locate*
  later, so it fails closed on anything unusual. `tag_name` is interpolated into a
  `RegExp` (step 2 of Editing above), so it's also regex-escaped before use, the same
  way `declareMissingCommodities` in `transactions.ts` already escapes a currency
  symbol before interpolating it (`c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`) -- reuse
  that exact pattern.
- `set_tag`'s value (`new_value`): may be `""` (value-less); when non-empty, must not
  contain `,` or a newline (a comma would be read as a second tag by hledger; a newline
  would break the comment-line model entirely), and -- kept from the existing
  validation, not relaxed -- must not have leading or trailing whitespace. hledger trims
  a tag's value when it parses it, so a value written with surrounding whitespace would
  never compare equal to its own `ttags` readback on a later run; without this check,
  `set_tag` would never reach a stable no-op state and would rewrite the same
  transaction every time it's re-run with the same input.
- `tag_remove` ignores `new_value` (like `set_status` ignores `from`).

### Auditability

A bulk operation that can silently overwrite an existing tag's value needs to say so,
not just leave it discoverable in the per-file diff. `BulkEditResult` gains per-outcome
counts instead of one flat `transactions` number for tag actions:

```ts
tagOutcomes?: { added: number; overwritten: number; removed: number; unchanged: number; skipped: number };
```

Five discriminants, no fewer: `added` vs. `overwritten` is exactly the distinction that
makes an overwrite non-silent (collapsing them back into one count would reopen that
problem); `skipped` is reported separately from `unchanged` because they mean different
things to someone reading the summary ("nothing needed doing" vs. "something needed
doing but the tool declined").

`applyTagEdit` returns this outcome directly (`"added" | "overwritten" | "removed" |
"unchanged" | "skipped"`) alongside the usual `newContent`/`warn` -- it is *not* derived
from a generic "count changed" signal, since `unchanged` and `skipped` are both
"nothing written" but need to be tallied under different labels. The caller increments
`tagOutcomes[outcome]` directly from this field and only calls `session.write(...)` when
the outcome is `"added"`, `"overwritten"`, or `"removed"`.

The tool-layer summary spells out overwrites explicitly, e.g.:

> Tagged 12 transaction(s) with `review` (9 newly, 3 value changed), 2 unchanged
> (already `review`), 1 skipped (couldn't safely locate the existing tag -- see
> warnings).

This resolves the "silent overwrite" concern without a separate confirmation flag:
overwriting stays the default behavior (consistent with `set_status`'s
unconditional-set semantics, and reversible via the existing `dry_run` + diff +
revert-on-error safety net), but the batch-level summary now makes it impossible to
overwrite something without the response saying so.

### Tool layer (`tools/bulk-edit-transactions.ts`)

- `ACTION_FIELDS` gains `set_tag: "tag_set"`, `remove_tag: "tag_remove"`.
- New `tag` param, required (validated in `execute`, same pattern as the existing `from`
  check) when `action` is `set_tag` or `remove_tag`.
- `to`'s description gains a note that `set_tag` uses `""` for a value-less tag; no
  schema type change.
- Result message uses the `tagOutcomes` breakdown above rather than a single count.

## Testing plan

Unit tests in `ledger/__tests__/bulk-edit.test.ts`:

- add a tag to a transaction with no existing tags (new line right after the header,
  indentation matching the transaction's postings).
- add a tag to a transaction that already has other dedicated tag lines (appended after
  the last one, no reordering).
- add a tag whose name already exists (via `ttags`) with a different value, written as
  a dedicated line -- overwritten in place, no line-count change.
- add a tag whose name already exists with the same value -- no-op.
- add a value-less tag (`to: ""` -> `; name:`).
- add a tag whose name already exists via a comma-separated line, a header-fused
  comment, or an `apply tag` directive -- all three collapse to the same outcome: skipped
  with a warning, file byte-for-byte unchanged. One representative test per shape is
  enough; they exercise the same code path.
- **tag-name prefix collision**: editing `review` on a transaction that also carries a
  dedicated `review_date` tag line must not touch the latter.
- **tag value containing a colon** (`; url: https://example.com`): the matcher splits on
  the first colon only.
- remove a tag on its own dedicated line (deletes the line; other tags/postings
  untouched).
- remove the last remaining tag (comment block disappears entirely; header goes
  straight into the first posting).
- remove a tag that isn't present -- no-op, no warning.
- a tag name appearing more than once in `ttags` (duplicate/malformed source) -- both
  `set_tag` and `remove_tag` skip with a warning rather than guess.
- **a comment line after the first posting** -- confirms the search range is correctly
  restricted to the pre-posting comment block; that line must never be read or edited as
  a transaction-level tag (it belongs to the posting it follows).
- **CRLF-terminated files** -- a newly inserted tag line uses the same EOL style as the
  rest of the file, matching how `applyAccountEdit`/`applyStatusEdit` already sniff it.
- multi-transaction, multi-file batch mixing inserts and deletes -- regression coverage
  that line-count-changing edits on one transaction don't shift the `startLine` of
  matches still queued to be processed (the bottom-up-ordering claim above, verified,
  not assumed).
- `dry_run` on a batch that both adds and overwrites tags -- disk unchanged, diff and
  `tagOutcomes` still accurately reflect what *would* happen.
- a batch where one transaction's edit would make the ledger invalid (e.g. malformed by
  an unrelated concurrent hand-edit) -- whole batch reverts, matching existing
  `account`/`payee`/`status` behavior.
- a `tag_name` containing a regex metacharacter (e.g. `review.2026`) -- matches only the
  literal tag name, not an unintended pattern.

Tool-layer tests in `tools/__tests__/bulk-edit-transactions.test.ts` for the new actions'
param wiring, the `tagOutcomes` summary text, error messages, and dry-run preview --
same shape as the existing `change_account`/`change_payee`/`set_status` tests.
