---
name: weekly-recap
description: A weekly check-in on your finances, covering three things - how your net worth moved over the last week, what you spent on and in which categories, and what recurring payments are expected in the coming week. Ask things like "give me my weekly recap", "how did my finances do this week", or "what's coming up this week".
---

# Weekly Recap

Give the user a short, three-part status update on the last 7 days and the 7
ahead. This is a read-only analysis: use the `query` tool only -- never modify
the journal in this workflow.

## 1. Net worth changes over the last week

Compare total Assets + Liabilities now vs. 7 days ago:

- `report: "bal"`, `account_pattern: "Assets|Liabilities"`, `depth: 0` (flat
  total), `end_date: tomorrow`, `output_format: "csv"` for the current total.
- Same query with `end_date: <7 days ago>` for the prior total.
- Report the current net worth, the absolute and percentage change over the
  week, and which currency it's in. If several currencies appear, report each
  separately -- do not convert unless the user asks.
- If a single account or category drove most of the change (e.g. a large
  transfer, a market move on an investment account), call it out by name.

## 2. Spending breakdown by category

- `report: "bal"`, `account_pattern: "Expenses"`, `begin_date: <7 days ago>`,
  `end_date: tomorrow`, `depth: 2`, `output_format: "csv"`.
- Present a table of categories sorted by amount, largest first, with each
  category's share of the week's total spending as a percentage.
- State the week's total spend and, if income postings exist in the same
  window, whether spending stayed within income.
- Compare against the trailing 4-week average per category (same query with
  `begin_date: <28 days ago>`, dividing by 4) and flag any category that's
  meaningfully above its average (roughly 50% or more) as standing out this
  week. Skip this comparison silently if there's under a month of history.

## 3. Upcoming scheduled transactions for the week ahead

The journal has no native "scheduled transaction" record, so recurring
payments are inferred from history by the recurring-spending skill, which
caches the result at the workspace root in `recurring-expenses.md` (see that
skill's "Cache" section). Reuse that cache instead of redoing the detection:

1. Read `recurring-expenses.md`. If it doesn't exist, invoke the
   recurring-spending skill's detection process once to create it, then
   continue from its output. Don't re-derive recurring charges yourself.
2. If the file's `Last refreshed` date is more than 14 days old, treat the
   projection as approximate and say so briefly, but still use the cached
   data rather than re-scanning 13 months of history -- a full refresh is the
   recurring-spending skill's job, not this one's.
3. For each cached payee (bills and subscriptions both), project the next
   expected date as last charge date + cadence, and keep only the ones
   landing within the next 7 days.
4. List them ordered by date: payee, expected date, expected amount (or a
   range if the amount varies), and account.

If nothing recurring is expected in the next 7 days, say so plainly instead of
stretching older history to fill the section.

## Reporting

Structure the recap as three short sections, in the order above, each with a
one-line headline before any table or numbers (e.g. "Net worth is up 320 EUR
this week"). Keep it scannable -- this is a quick check-in, not a full audit.
Use the recurring-spending or subscription-audit skills instead if the user
wants the full recurring-payments picture rather than just the next week.

## Boundaries

- If the ledger covers less than 7 days, say there isn't enough history for a
  weekly recap yet instead of guessing.
- This is a report, not a change to the user's finances -- never remove or
  edit journal entries as part of this recap.
