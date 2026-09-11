---
name: accountant
description: Manage a personal hledger ledger through conversation
version: 1.0.0
platforms: [macos, linux]
required_environment_variables:
  - name: ACCOUNTANT24_WORKSPACE
    prompt: Path to the Accountant24 workspace folder (holds ledger/, files/)
    required_for: pointing the MCP server at a non-default workspace
metadata:
  hermes:
    tags: [finance, accounting, hledger, bookkeeping]
    category: finance
    requires_tools: [mcp__accountant__query]
    config:
      - key: accountant.workspace
        description: Accountant24 workspace folder
        default: "~/.accountant24"
        prompt: Workspace folder path
---

# Accountant24

Turn plain-language money talk ("spent 12 euros on lunch at the deli", "what did
I spend on groceries in June?", "import this bank statement") into a clean,
validated hledger ledger. The ledger and stored documents live in one workspace
folder; the `mcp__accountant__*` tools are the only way this skill changes it.
Durable facts and preferences go in Hermes' own memory, not a workspace file.

Read `reference/accountant-prompt.md` before your first tool call and follow
it for the session -- it has the full persona, formatting, and categorization
rules. The two rules below are repeated here because they're load-bearing and
this file is the one Hermes always shows; the reference file only loads if you
open it.

**Never read a journal file directly** (`read_file`, `terminal`, `cat`, ...) to
answer a question or inspect the ledger -- always use `mcp__accountant__query`
or `mcp__accountant__lookup`. The tools already handle multi-file includes,
price directives, and valuation that a raw file read would get wrong.
**Never write a journal file directly** either -- every ledger change goes
through an `mcp__accountant__*` writer tool.

## When to Use

- The user wants to log spending, income, transfers, or account balances.
- The user asks a question about their own finances (spending by category, net worth, a specific payee, a balance).
- The user wants to import or reconcile a bank statement, receipt, or invoice.
- The user wants to reorganize the ledger (recategorize transactions, rename a payee, mark transactions cleared).
- The user wants to record or update a durable preference (default currency, a categorization rule, a recurring arrangement).

Not for: questions unrelated to the user's finances, or ledgers this MCP server
is not configured against.

## Procedure

1. Adopt `reference/accountant-prompt.md` for the session.
2. At session start, call `mcp__accountant__lookup` for `accounts`, `payees`, and `tags` so you know what already exists.
3. For a question, use `mcp__accountant__query` with structured filters. A large result spills to a scratch file; read that file instead of re-running.
4. For a change:
   - Confirm any new account, payee, or commodity with the user first; re-run `mcp__accountant__lookup` because your view may be stale.
   - Use the right writer: `add_transactions`, `add_balance_assertions`, `add_prices`, or `bulk_edit` (run `bulk_edit` with `dry_run: true` first on a broad or unfamiliar query).
   - Every write is validated; a write that would leave the ledger invalid is rolled back entirely (nothing is saved) and the result says so. Every successful write is committed by the server.
5. Save durable facts, preferences, and recurring arrangements in Hermes' own memory, the way you normally would -- this skill does not use a separate memory file.

## Pitfalls

- `bulk_edit` query terms are case-insensitive regex substrings -- anchor them (`payee:^EDEKA$`) and dry-run first, or you will edit the wrong transactions.
- `add_balance_assertions` fails if the ledger balance doesn't already match reality -- reconcile first, then assert.
- A `bulk_edit` `change_account` whose target account isn't declared reverts the whole batch. Declare it first (ask the user).
- This integration needs Hermes' local terminal backend so the MCP server and the file tools share one filesystem.

## Verification

- After any change, `mcp__accountant__validate` reports the whole ledger is valid (the writers also run it internally).
- Re-`query` the affected account or period and confirm the numbers moved the way the user expects.
- For an import, spot-check that `original_payee_name`, `original_description`, and `related_file` tags are on the new transactions.
