#!/usr/bin/env python3
"""Fetch daily closing prices from Yahoo Finance and append them to the
ledger as hledger `P` price directives.

Usage:
  python3 fetch_prices.py COMMODITY=TICKER [COMMODITY=TICKER ...] \
      --start YYYY-MM-DD [--end YYYY-MM-DD]

COMMODITY is the ledger commodity symbol as used in transactions (e.g.
VTSAX). TICKER is the Yahoo Finance ticker to fetch (e.g. VTSAX, AAPL,
^GSPC, EURUSD=X) - they can differ (a fund's ledger symbol is rarely its
Yahoo ticker). --end defaults to today (local date).

This is the only place in the workspace that makes an outbound network
call. Kept from the original TypeScript implementation: a single
hardcoded host, and a ticker charset check before the symbol ever enters
the URL path. NOT yet ported (deferred, tracked as follow-up hardening,
not silently dropped): rejecting HTTP redirects and the abort/cancel-signal
plumbing the TypeScript version had. Do not weaken the commodity-validation
step below to compensate for that gap - it guards ledger integrity
(preventing a phantom commodity from a mistyped ticker), not network safety,
and both matter independently.

Reads ACCOUNTANT24_HOME from the environment (same convention as the rest
of the workspace), falling back to ~/Accountant24. Requires the `hledger`
binary on PATH (already true inside the app; install separately to run
this script standalone: https://hledger.org/install).

Exits non-zero on any failure - an unknown commodity, a Yahoo fetch error,
or a failed `hledger check --strict` after writing - and prints the reason
to stderr. A non-zero exit always means nothing was left half-written to
prices.journal/commodities.journal beyond what is reported.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
REQUEST_TIMEOUT_SECONDS = 15
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9.^=-]{1,20}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class FetchPricesError(Exception):
    pass


# ---- Yahoo fetch ------------------------------------------------------------


def day_start_unix(d: str) -> int:
    m = DATE_RE.match(d)
    if not m:
        raise FetchPricesError(f"Invalid date: {d}. Expected YYYY-MM-DD.")
    y, mo, da = int(d[0:4]), int(d[5:7]), int(d[8:10])
    return int(datetime(y, mo, da, tzinfo=timezone.utc).timestamp())


def fetch_yahoo_daily_closes(symbol: str, start: str, end: str) -> tuple[str, list[dict]]:
    """Returns (currency, points) where each point is {"date": ..., "close": ...}."""
    if not SYMBOL_PATTERN.match(symbol):
        raise FetchPricesError(f"Invalid ticker symbol: {symbol!r}")

    period1 = day_start_unix(start)
    period2 = day_start_unix(end) + 86_400  # advance one day so `end` is included

    url = f"{YAHOO_CHART_URL}/{urllib.parse.quote(symbol, safe='')}?period1={period1}&period2={period2}&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "accountant24"})

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as res:
            body = json.loads(res.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        body = None
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            pass
        api_error = (body or {}).get("chart", {}).get("error")
        if api_error:
            raise FetchPricesError(f"Yahoo error for {symbol}: {api_error.get('description') or api_error.get('code')}")
        raise FetchPricesError(f"Yahoo returned HTTP {e.code} for {symbol}")
    except TimeoutError:
        raise FetchPricesError(f"Request to Yahoo timed out after {REQUEST_TIMEOUT_SECONDS}s")
    except urllib.error.URLError as e:
        raise FetchPricesError(f"Failed to reach Yahoo: {e.reason}")

    api_error = (body or {}).get("chart", {}).get("error")
    if api_error:
        raise FetchPricesError(f"Yahoo error for {symbol}: {api_error.get('description') or api_error.get('code')}")

    result = (((body or {}).get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise FetchPricesError(f"No price data returned for {symbol}")

    meta = result.get("meta") or {}
    currency = meta.get("currency") or "USD"
    gmtoffset = meta.get("gmtoffset") or 0
    timestamps = result.get("timestamp") or []
    closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []

    points = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue  # holiday / missing datapoint
        d = datetime.fromtimestamp(ts + gmtoffset, tz=timezone.utc).strftime("%Y-%m-%d")
        points.append({"date": d, "close": close})

    return currency, points


# ---- P-directive formatting --------------------------------------------------


def format_price(n: float) -> str:
    """2-4 decimal places, trailing zeros beyond the 2nd trimmed."""
    trimmed = f"{n:.4f}".rstrip("0").rstrip(".")
    if "." in trimmed:
        int_part, frac = trimmed.split(".", 1)
    else:
        int_part, frac = trimmed, ""
    return f"{int_part}.{frac.ljust(2, '0')}"


def format_price_directive(d: str, commodity: str, close: float, currency: str) -> str:
    return f"P {d} {commodity} {format_price(close)} {currency}"


def bare_name(symbol: str) -> str:
    m = re.match(r'^"(.*)"$', symbol)
    return m.group(1) if m else symbol


# ---- Ledger state -------------------------------------------------------------


def existing_keys(content: str) -> set[str]:
    keys = set()
    for line in content.split("\n"):
        m = re.match(r'^P\s+(\d{4}-\d{2}-\d{2})\s+("[^"]+"|\S+)', line)
        if m:
            keys.add(f"{m.group(1)}\t{bare_name(m.group(2))}")
    return keys


def parse_commodity_declaration(arg: str):
    quoted = re.search(r'"([^"]+)"', arg)
    if quoted:
        return quoted.group(1), quoted.group(0)
    for token in arg.strip().split():
        if not re.match(r"^[-+]?\d[\d.,]*$", token):
            return token, token
    return None


def declared_commodities(ledger_dir: Path) -> dict[str, str]:
    path = ledger_dir / "commodities.journal"
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    result: dict[str, str] = {}
    for line in content.split("\n"):
        m = re.match(r"^\s*commodity\s+(.+?)\s*$", line)
        if not m:
            continue
        parsed = parse_commodity_declaration(m.group(1))
        if parsed:
            bare, declared_form = parsed
            result[bare] = declared_form
    return result


def write_lines(path: Path, existing: str, new_text: str) -> None:
    sep = "" if existing == "" or existing.endswith("\n") else "\n"
    path.write_text(f"{existing}{sep}{new_text}", encoding="utf-8")


def write_prices(ledger_dir: Path, entries: list[dict]) -> tuple[int, int]:
    """entries: [{"commodity", "currency", "points"}, ...]. Returns (added, skipped)."""
    declared = declared_commodities(ledger_dir)

    unknown = sorted({bare_name(e["commodity"]) for e in entries} - set(declared.keys()))
    if unknown:
        valid = ", ".join(sorted(declared.keys()))
        raise FetchPricesError(
            f"Unknown commodity: {', '.join(unknown)}. "
            "The commodity must be a symbol already declared in the ledger, not a Yahoo ticker. "
            f"Declared commodities: {valid}."
        )

    prices_path = ledger_dir / "prices.journal"
    old_content = prices_path.read_text(encoding="utf-8") if prices_path.exists() else ""

    seen = existing_keys(old_content)
    new_lines = []
    skipped = 0

    for entry in entries:
        bare = bare_name(entry["commodity"])
        symbol = declared.get(bare, bare)
        currency = declared.get(bare_name(entry["currency"]), bare_name(entry["currency"]))
        for point in entry["points"]:
            key = f"{point['date']}\t{bare}"
            if key in seen:
                skipped += 1
                continue
            seen.add(key)
            new_lines.append(format_price_directive(point["date"], symbol, point["close"], currency))

    new_lines.sort()

    if new_lines:
        write_lines(prices_path, old_content, "\n".join(new_lines) + "\n")

    declare_missing_currencies(ledger_dir, entries, declared)
    ensure_prices_included(ledger_dir)

    return len(new_lines), skipped


def declare_missing_currencies(ledger_dir: Path, entries: list[dict], declared: dict[str, str]) -> None:
    missing = sorted({bare_name(e["currency"]) for e in entries} - set(declared.keys()))
    if not missing:
        return
    commodities_path = ledger_dir / "commodities.journal"
    content = commodities_path.read_text(encoding="utf-8") if commodities_path.exists() else ""
    declarations = "\n".join(f"commodity {c}" for c in missing) + "\n"
    write_lines(commodities_path, content, declarations)


def ensure_prices_included(ledger_dir: Path) -> None:
    main_path = ledger_dir / "main.journal"
    if not main_path.exists():
        return
    content = main_path.read_text(encoding="utf-8")
    if "include prices.journal" in content:
        return
    write_lines(main_path, content, "include prices.journal\n")


def hledger_check(main_path: Path) -> None:
    result = subprocess.run(
        ["hledger", "check", "--strict", "-f", str(main_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise FetchPricesError(
            f"Prices saved to prices.journal but the ledger has errors:\n\n{result.stderr}"
        )


# ---- CLI ------------------------------------------------------------------


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: fetch_prices.py COMMODITY=TICKER [COMMODITY=TICKER ...] --start YYYY-MM-DD [--end YYYY-MM-DD]", file=sys.stderr)
        sys.exit(1)

    mappings = []
    start = None
    end = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--start":
            i += 1
            start = args[i] if i < len(args) else None
        elif arg == "--end":
            i += 1
            end = args[i] if i < len(args) else None
        elif "=" in arg:
            commodity, symbol = arg.split("=", 1)
            mappings.append((commodity, symbol))
        else:
            print(f"error: unrecognized argument {arg!r}", file=sys.stderr)
            sys.exit(1)
        i += 1

    if not mappings:
        print("error: at least one COMMODITY=TICKER mapping is required", file=sys.stderr)
        sys.exit(1)
    if not start:
        print("error: --start is required", file=sys.stderr)
        sys.exit(1)
    if not end:
        end = date.today().isoformat()

    if not DATE_RE.match(start):
        print(f"error: invalid start date: {start}. Expected YYYY-MM-DD.", file=sys.stderr)
        sys.exit(1)
    if not DATE_RE.match(end):
        print(f"error: invalid end date: {end}. Expected YYYY-MM-DD.", file=sys.stderr)
        sys.exit(1)
    if end < start:
        print(f"error: end ({end}) is before start ({start}).", file=sys.stderr)
        sys.exit(1)

    home = Path(os.environ.get("ACCOUNTANT24_HOME") or (Path.home() / "Accountant24"))
    ledger_dir = home / "ledger"

    entries = []
    try:
        for commodity, symbol in mappings:
            currency, points = fetch_yahoo_daily_closes(symbol, start, end)
            entries.append({"commodity": commodity, "currency": currency, "points": points})

        added, skipped = write_prices(ledger_dir, entries)
        hledger_check(ledger_dir / "main.journal")
    except FetchPricesError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    names = ", ".join(commodity for commodity, _ in mappings)
    skipped_note = f" ({skipped} already present)" if skipped > 0 else ""
    print(f"Added {added} price(s) for {names}{skipped_note}.")
    print("Ledger valid: yes")


if __name__ == "__main__":
    main()
