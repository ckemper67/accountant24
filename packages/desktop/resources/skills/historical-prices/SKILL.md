---
name: historical-prices
description: Fetches historical daily closing prices for a stock, fund, or index from Yahoo Finance and records them in the ledger as hledger price directives, so reports can value holdings correctly on any date. Ask things like "get prices for VTSAX", "update my fund prices", "fetch historical prices for AAPL", or "what was my portfolio worth on <date>" (fetch prices first, then value it). The commodity must already exist in the ledger - this only adds price history, it never creates a holding.
---

# Historical Prices

Fetch daily closing prices for a commodity from Yahoo Finance and record
them as hledger `P` price directives, via the bundled `fetch_prices.py`
script (run with `bash`) - never write price directives by hand or shell out
to `curl`/`fetch` yourself, the script owns dedup, commodity validation, and
the post-write ledger check.

**This is the one place in the workspace that makes an outbound network
call.** Kept from a prior TypeScript implementation: a single hardcoded
host (Yahoo's chart API) and a ticker charset check before the symbol ever
reaches the URL. Not yet ported (a known, tracked gap - do not treat this as
resolved): rejecting HTTP redirects, and stricter cancel/timeout handling.
That gap is about network hardening; it does not affect the commodity
validation described below, which is a separate, already-enforced ledger
integrity check.

## Running it

1. Confirm the **ledger commodity symbol** the user means (as declared in
   `commodities.journal` and used in their transactions, e.g. `VTSAX`) and
   the **Yahoo ticker** to fetch (e.g. `VTSAX`, `AAPL`, `^GSPC`,
   `EURUSD=X`) - these can differ (a fund's ledger symbol is rarely its
   Yahoo ticker). If you don't already know the mapping, check `memory.md`
   first (past runs record it there - see step 3), then ask the user rather
   than guessing.
2. Run: `python3 <skill directory>/fetch_prices.py COMMODITY=TICKER
   [COMMODITY=TICKER ...] --start YYYY-MM-DD [--end YYYY-MM-DD]`. This
   invocation itself tells you `<skill directory>`: right above this text is
   a line reading "References are relative to `<path>`." - that `<path>` is
   the directory this file lives in; use it directly, do not guess an
   absolute path. Multiple commodities can be fetched in one call. `--end`
   defaults to today.
   - Pick `--start` from context: "the last year" means a year back from
     today; refreshing existing history means the day after the latest date
     already in `prices.journal` for that commodity (check the file first
     rather than re-fetching a huge range).
   - The script prints a one-line summary (`Added N price(s) for ...
     (M already present)` then `Ledger valid: yes`) on success. On failure
     it exits non-zero and prints the reason to stderr - most commonly an
     unknown commodity (not yet declared in the ledger) or a Yahoo fetch
     error (bad ticker, no data for the range). Relay that reason to the
     user rather than retrying blindly; don't invent a commodity that isn't
     declared.
3. After a successful fetch, record the commodity-to-Yahoo-ticker mapping in
   memory (`update_memory`) if it isn't already there, so future refreshes
   need no lookup.

## Boundaries

- Never write `P` directives directly (with `edit` or otherwise) or fetch
  prices from anywhere but this script - it's what keeps `prices.journal`
  deduplicated and the ledger strict-valid.
- Don't fetch a commodity the ledger doesn't already have declared; if the
  script rejects it as unknown, tell the user rather than declaring a new
  commodity yourself to work around the error - that's their call, not an
  automatic fix.
- If `python3` is not on PATH, say prices can't be fetched right now rather
  than attempting the request another way - there's no safe fallback
  through `bash`/`curl` for the ledger-write and validation steps this
  script performs.
