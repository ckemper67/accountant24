# Proposal: consolidate the two import tools into one

## Motivation

The lead wants to minimize the number of tools exposed to the agent. Today there are
three transaction-entry tools, two of which are nearly identical.

| Tool | Input | Purpose |
| --- | --- | --- |
| `add_transactions` | explicit postings | Manual entry; the caller supplies the full double-entry. |
| `import_transactions` | `file_path` (CSV) | Bank CSV: auto-detect encoding/number/date, dedup, auto-balance to a catch-all. |
| `import_transactions_from_rows` | `rows` (inline) | Same as above, but rows transcribed from a PDF/image statement. |

The two import tools share the **same backend** (`importStatementRows`) and about 90% of
their parameters. They differ only in **where the rows come from**: parse a CSV file, or
take rows verbatim.

## Proposal

Merge `import_transactions` and `import_transactions_from_rows` into a single
`import_transactions` tool that accepts **exactly one of** `file_path` or `rows`.
Net effect: 3 tools -> 2. `add_transactions` stays as-is.

### Parameters

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `file_path` | string | one-of | Workspace-relative CSV path. Provide this **or** `rows`. |
| `rows` | array of `{date, amount, description?, payee?, currency?}` | one-of | Inline rows (verbatim from a PDF/image via `extract_text`). Provide this **or** `file_path`. |
| `account` | string | yes | The statement's ledger account. |
| `uncategorized_expense_account` | string | yes | Catch-all for outflows (must already be declared). |
| `uncategorized_income_account` | string | yes | Catch-all for inflows (must already be declared). |
| `currency` | string | no | Statement currency when a row/column has none. |
| `number_format` | `us` \| `de` \| `fr` \| `ch` | no | Override; omit to auto-detect. |
| `date_format` | `MDY` \| `DMY` | no | Override; omit to auto-detect. |
| `column_map` | object | no | CSV only -- column-name overrides. |
| `skip_rows` | number | no | CSV only -- preamble lines before the header. |
| `dry_run` | boolean | no | Parse/dedup/validate without writing. |

### Validation

- Exactly one of `file_path` / `rows` -- error if both or neither are provided.
- `column_map` / `skip_rows` are only valid with `file_path` -- error (or ignore) if
  passed alongside `rows`.

### Behavior

- `file_path` -> existing `runImport` path (decode + parse CSV -> shared backend).
- `rows` -> existing `runRowImport` path (-> shared backend).
- Everything downstream is unchanged: dedup via `import_id`, catch-all balancing,
  monthly-file write, `hledger check`, and the dry-run preview.

## Impact

- **Removed:** `import_transactions_from_rows` (tool definition, schema, prompt guidelines).
- **Backend:** unchanged. `import.ts` `runImport` / `runRowImport` stay; only the tool
  layer merges.
- **Prompt guidance:** one merged guideline set ("CSV -> `file_path`; PDF/image ->
  transcribe to `rows`"). Slightly denser than two focused tools.
- **Tests:** merge the two tool tests; add one-of-input validation cases.

## Tradeoffs and open questions for the lead

1. **One tool, two modes vs. two focused tools.** Fewer tools (the goal) at the cost of a
   conditional parameter surface (`file_path` xor `rows`, plus CSV-only params). Agents
   handle "provide A or B" well, but the tool description carries a bit more nuance.
2. **Naming:** keep `import_transactions`, or rename to signal both modes
   (e.g. `import_statement`)?
3. **Strictness of CSV-only params with `rows`:** hard error vs. silently ignore
   `column_map` / `skip_rows`?
4. **Scope:** is the target 3 -> 2, or does the lead also want fewer transaction tools
   overall (i.e., is `add_transactions` in scope)? Recommendation: keep `add_transactions`
   separate -- merging manual entry with bank import bloats one parameter surface with two
   unrelated workflows (explicit postings vs. auto-balanced, deduplicated bank import).

## Recommendation

Adopt the 3 -> 2 merge (option 1). It removes a whole tool with no loss of capability, the
backend is untouched, and the only real cost is a slightly more conditional parameter
surface on a single tool.
