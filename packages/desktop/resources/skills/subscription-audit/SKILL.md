---
name: subscription-audit
description: Reviews your subscriptions and memberships, like streaming, apps, SaaS, gym, and news services. Shows what each costs per month and per year, when it renews, and flags price increases, duplicate services, forgotten charges, and subscriptions you likely cancelled. Ask things like "list my subscriptions", "what can I cancel", "when does Netflix renew", or "did Spotify get more expensive". For rent, utilities, and the full recurring picture, use the recurring-spending skill.
---

# Subscription Audit

Find the user's cancellable services in the ledger — streaming, software,
memberships — present them as one overview, and flag what deserves attention.
This is a read-only analysis: use the `query` tool only — never modify the
journal in this workflow.

## Get recurring charges from the shared cache

This skill doesn't run its own detection. recurring-spending already detects
every recurring charge (bills and subscriptions) and caches the result in
`recurring-expenses.md` at the workspace root - reuse it instead of
re-scanning the journal:

1. Read `recurring-expenses.md`. If it doesn't exist, or its `Last refreshed`
   date is more than 14 days old, invoke the recurring-spending skill's
   detection process once to (re)create a fresh cache, then continue from its
   output. Don't re-derive recurring charges yourself.
2. Take the **Subscriptions and memberships** table from the cache as your
   working set - the bills table is out of scope for this skill. The cache
   already applies the cancel-today test (see recurring-spending's
   "Grouping" section), so don't re-litigate that classification here.
3. Drop any cached entry whose Notes mention a banded/variable amount (e.g.
   "amount varies") - a metered, fluctuating charge is a utility-like bill,
   not a subscription with a fixed or stepped price, even if recurring-spending
   grouped it as cancellable.

If the user's question is really about total monthly costs or bills, use the
recurring-spending skill instead of stretching this one.

## Reporting

Present a single table sorted by monthly-equivalent cost:

| Payee | Account | Cadence | Amount | ≈ Monthly | First charged | Last charged | Next expected | Notes |

- **Next expected** = last charge date + cadence, as computed by the cache.
  Flag anything more than one full cadence overdue as *probably cancelled* -
  list it separately, don't count it in the totals. The cache's own
  "Expected but not seen" callout already identifies these; cross-check
  against it rather than re-deriving.
- Below the table show the total **per month and per year** in the ledger's
  own currency — the yearly figure is what makes people act. If several
  currencies appear, keep separate totals per currency; do not convert unless
  the user asks.

After the table, call out only what's noteworthy, in this order:

- **Price increases** - read directly off the cache's "Price increases"
  callout, filtered to subscription payees: show old → new, the percentage,
  and the per-year impact.
- **Possible duplicates** — overlapping services of the same kind (two music
  streaming payees, two cloud-storage payees).
- **Annual renewals coming up** within the next 60 days.
- **Recently started** — a subscription whose First charged date is within
  the last ~2 months: mention it ("started five weeks ago") so a forgotten
  trial conversion doesn't slip by.

## Boundaries

- If the ledger covers less than ~3 months, say the history is too short for a
  reliable audit instead of guessing. Annual subscriptions need more than a
  year of history — say so when the ledger is younger than that.
- Cancellation is the user's action in the outside world — you can only
  report; never remove or edit journal entries as part of this audit.
