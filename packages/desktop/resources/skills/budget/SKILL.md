---
name: budget
description: Builds a monthly and yearly spending budget per account from your last 13 months of expenses, writes it to budget.md, and refines it with your input. Ask things like "set up a budget", "create a budget for me", or "update my budget". Once budget.md exists, future runs revise it in place instead of starting over.
---

# Budget

Build a per-account monthly and yearly budget from the user's spending
history, write it to `budget.md`, and refine it with the user before treating
it as final. This file becomes the reference a future comparison ("am I on
budget?") reads against, so get its shape right — every account name must
match the ledger exactly, and every number must be traceable to real data.

## Pulling the data

1. Check whether `budget.md` already exists in the workspace root. If it
   does, follow "Updating an existing budget" below instead of starting from
   scratch.
2. Pull the last 13 months of expense postings, grouped by month, with the
   `query` tool: `report: "bal"`, `account_pattern: "Expenses"`,
   `period: "monthly"`, `begin_date: <13 months ago>`, `depth: 2` or `3`
   (deep enough for meaningful categories — Groceries, not just Expenses;
   shallow enough to stay readable — usually not the full account path),
   `output_format: "csv"`. This returns one row per account with one column
   per month, which is exactly the shape needed to compute an average.
3. 13 months, not 12, so the sample includes the current, still-in-progress
   month for context — but **exclude that partial month from every average**,
   since it will always read low and skew the budget down. Use it only to
   say "so far this month you've spent X against a budget of Y".
4. If the ledger has less than ~6 full months of history, say the sample is
   too small for a reliable budget and ask the user whether to proceed
   anyway rather than silently guessing.

## Computing the proposal

For each account, over the 12 full months:

- **Monthly budget** = the average of the 12 months, after excluding
  one-off outlier months (a single large one-time purchase, a rare repair).
  Say what was excluded and why — don't silently drop data.
- **Yearly budget** = monthly x 12, **except** for accounts with a clear
  annual or seasonal pattern (insurance, an annual renewal, holiday
  spending) — for those, compute the yearly figure from the actual annual
  total instead of monthly x 12, and mark the row's basis as `annual`.
- Round to sensible amounts (nearest 5 or 10 in the ledger's currency) — a
  budget is a target, not a restated average.
- If multiple currencies appear in the ledger, keep the budget per currency;
  never convert between them.
- Never invent an account that doesn't appear in the ledger's query results.

## Writing budget.md

Write the file to `budget.md` in the workspace root (same location as
`memory.md`), using this format:

```markdown
# Budget

Currency: <e.g. USD>
Based on: <start date> to <end date> (12 full months)
Last revised: <YYYY-MM-DD>

| Account | Monthly budget | Yearly budget | Basis | Notes |
|---|---|---|---|---|
| Expenses:Groceries | 450 | 5400 | avg | |
| Expenses:Insurance | 80 | 960 | annual | paid yearly in March |
| ... | | | | |
| **Total** | **X** | **Y** | | |
```

- **Account** = the full account name exactly as it appears in the ledger
  (e.g. `Expenses:Groceries`), so a future query can match it directly.
- **Basis** = `avg` (flat 12-month average) or `annual` (computed from a
  yearly total) — a future comparison needs to know which one to check.
- **Notes** = short flags: excluded outlier months, merged categories,
  anything the user should sanity-check. Leave empty when there's nothing to
  note.
- Include a totals row summing the monthly and yearly columns.
- The header (currency, date range, last revised) is required — it's the
  context any future "are we on track" comparison needs.

## Review loop

1. After writing the file, present the table to the user in chat and
   explicitly ask for corrections: amounts to adjust, accounts to merge or
   split, accounts to exclude.
2. Revise `budget.md` in place based on the answer — rewrite the whole file
   each time rather than patching individual lines, and update
   "Last revised" to today's date.
3. Repeat until the user confirms the budget looks right. Don't treat a
   first draft as final without at least one round of confirmation.

## Updating an existing budget

If `budget.md` already exists, don't regenerate it from scratch:

1. Read the existing file.
2. Re-pull the last 13 months as above.
3. Propose deltas — accounts trending meaningfully over or under their
   current budgeted figure — rather than silently overwriting the file.
4. Apply changes the user agrees to, following the same review loop as a
   first-time budget, and update "Last revised".

## Boundaries

- This is a planning skill: use the `query` tool only, and only for reading.
  Never modify journal entries as part of building or revising a budget.
- If the ledger covers less than ~6 months, say the history is too short for
  a reliable budget instead of guessing.
