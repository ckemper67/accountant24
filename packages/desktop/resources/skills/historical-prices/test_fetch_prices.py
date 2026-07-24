#!/usr/bin/env python3
"""Tests for fetch_prices.py.

Run with: python3 -m unittest test_fetch_prices -v   (from this directory)

Uses only the standard library (unittest + unittest.mock), matching the
script itself - the vendored interpreter has no pip. Expected values are
taken from the original TypeScript implementation's spec (see
prices.test.ts, yahoo.test.ts, fetch-prices.test.ts on
feat/historical-prices) - hardcoded here, not re-derived from this script's
own formulas, so a regression in the logic actually fails a test instead of
being rubber-stamped by it.
"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

import fetch_prices as fp


# ---- format_price / format_price_directive ---------------------------------


class TestDayStartUnix(unittest.TestCase):
    def test_should_raise_on_a_malformed_date(self):
        with self.assertRaises(fp.FetchPricesError) as ctx:
            fp.day_start_unix("not-a-date")
        self.assertIn("Invalid date", str(ctx.exception))


class TestParseCommodityDeclaration(unittest.TestCase):
    def test_should_return_none_when_every_token_is_numeric(self):
        self.assertIsNone(fp.parse_commodity_declaration("1.000 2,000.00"))


class TestFormatPrice(unittest.TestCase):
    def test_should_render_with_2_to_4_decimals(self):
        cases = [
            (150, "150.00"),
            (150.25, "150.25"),
            (150.2537, "150.2537"),
            (1234.5, "1234.50"),
            (0.1, "0.10"),
        ]
        for close, expected in cases:
            with self.subTest(close=close):
                self.assertEqual(fp.format_price(close), expected)

    def test_should_build_the_full_p_directive(self):
        self.assertEqual(
            fp.format_price_directive("2026-01-15", "VTSAX", 150, "USD"),
            "P 2026-01-15 VTSAX 150.00 USD",
        )


# ---- write_prices -----------------------------------------------------------


DEFAULT_COMMODITIES = "; Commodity declarations\ncommodity USD\ncommodity VTSAX\n"
MAIN_WITH_INCLUDE = "; Accountant24\n\ninclude commodities.journal\ninclude prices.journal\ninclude accounts.journal\n"
MAIN_WITHOUT_INCLUDE = "; Accountant24\n\ninclude commodities.journal\ninclude accounts.journal\n"


class TestWritePrices(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger_dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.seed()

    def seed(self, commodities=None, prices="", main=None):
        (self.ledger_dir / "main.journal").write_text(main if main is not None else MAIN_WITH_INCLUDE)
        (self.ledger_dir / "commodities.journal").write_text(
            commodities if commodities is not None else DEFAULT_COMMODITIES
        )
        prices_path = self.ledger_dir / "prices.journal"
        if prices is None:
            prices_path.unlink(missing_ok=True)
        else:
            prices_path.write_text(prices)

    def prices_file(self):
        return (self.ledger_dir / "prices.journal").read_text()

    def commodities_file(self):
        return (self.ledger_dir / "commodities.journal").read_text()

    def main_file(self):
        return (self.ledger_dir / "main.journal").read_text()

    def test_should_append_p_directives_for_each_point_and_report_the_count(self):
        added, skipped = fp.write_prices(
            self.ledger_dir,
            [
                {
                    "commodity": "VTSAX",
                    "currency": "USD",
                    "points": [
                        {"date": "2026-01-02", "close": 100.5},
                        {"date": "2026-01-03", "close": 101.25},
                    ],
                }
            ],
        )
        self.assertEqual((added, skipped), (2, 0))
        self.assertIn("P 2026-01-02 VTSAX 100.50 USD", self.prices_file())
        self.assertIn("P 2026-01-03 VTSAX 101.25 USD", self.prices_file())

    def test_should_skip_a_date_commodity_pair_that_already_exists(self):
        self.seed(prices="P 2026-01-02 VTSAX 100.00 USD\n")

        added, skipped = fp.write_prices(
            self.ledger_dir,
            [
                {
                    "commodity": "VTSAX",
                    "currency": "USD",
                    "points": [
                        {"date": "2026-01-02", "close": 999},
                        {"date": "2026-01-03", "close": 101.25},
                    ],
                }
            ],
        )
        self.assertEqual((added, skipped), (1, 1))
        # The pre-existing rate is untouched (not overwritten with 999).
        self.assertIn("P 2026-01-02 VTSAX 100.00 USD", self.prices_file())
        self.assertNotIn("999", self.prices_file())
        self.assertIn("P 2026-01-03 VTSAX 101.25 USD", self.prices_file())

    def test_should_reject_a_commodity_not_declared_in_the_ledger(self):
        self.seed(commodities="commodity USD\n", prices="")

        with self.assertRaises(fp.FetchPricesError) as ctx:
            fp.write_prices(
                self.ledger_dir,
                [{"commodity": "VTHRX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100}]}],
            )
        self.assertIn("Unknown commodity: VTHRX", str(ctx.exception))
        # Nothing is written: no phantom commodity, no price line.
        self.assertNotIn("VTHRX", self.commodities_file())
        self.assertNotIn("VTHRX", self.prices_file())

    def test_should_auto_declare_the_quote_currency_but_never_the_commodity(self):
        self.seed(commodities="commodity VTSAX\n")
        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "EUR", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        self.assertRegex(self.commodities_file(), r"(?m)^commodity EUR$")

    def test_should_not_redeclare_an_already_declared_commodity(self):
        self.seed(commodities="commodity USD\ncommodity VTSAX\n")
        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        declarations = [l for l in self.commodities_file().splitlines() if l == "commodity VTSAX"]
        self.assertEqual(len(declarations), 1)

    def test_should_treat_a_quoted_commodity_the_same_as_unquoted_for_dedup(self):
        self.seed(commodities="commodity USD\ncommodity FDRXX\n", prices="P 2026-01-02 FDRXX 1.00 USD\n")

        added, skipped = fp.write_prices(
            self.ledger_dir,
            [{"commodity": '"FDRXX"', "currency": "USD", "points": [{"date": "2026-01-02", "close": 999}]}],
        )
        self.assertEqual((added, skipped), (0, 1))
        self.assertNotIn("999", self.prices_file())

    def test_should_render_the_p_directive_using_the_declared_quoting_form(self):
        self.seed(commodities='commodity USD\ncommodity "VANG_TARGET_2030"\n', prices="")

        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VANG_TARGET_2030", "currency": "USD", "points": [{"date": "2026-01-02", "close": 45.49}]}],
        )
        self.assertIn('P 2026-01-02 "VANG_TARGET_2030" 45.49 USD', self.prices_file())

    def test_should_render_the_quote_currency_in_its_declared_form(self):
        self.seed(commodities='commodity VTSAX\ncommodity "GBP"\n', prices="")

        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "GBP", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        self.assertIn('P 2026-01-02 VTSAX 100.00 "GBP"', self.prices_file())

    def test_should_recognize_an_amount_style_commodity_declaration(self):
        self.seed(commodities="commodity 1.000 USD\ncommodity 1,000.00 VTSAX\n", prices="")

        added, _ = fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        self.assertEqual(added, 1)
        self.assertIn("P 2026-01-02 VTSAX 100.00 USD", self.prices_file())

    def test_should_write_directives_for_every_commodity_in_a_multi_commodity_batch(self):
        self.seed(commodities="commodity USD\ncommodity VTSAX\ncommodity AAPL\n", prices="")

        added, _ = fp.write_prices(
            self.ledger_dir,
            [
                {"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100.5}]},
                {"commodity": "AAPL", "currency": "USD", "points": [{"date": "2026-01-02", "close": 150.25}]},
            ],
        )
        self.assertEqual(added, 2)
        self.assertIn("P 2026-01-02 VTSAX 100.50 USD", self.prices_file())
        self.assertIn("P 2026-01-02 AAPL 150.25 USD", self.prices_file())

    def test_should_dedupe_per_commodity_not_across_commodities_on_the_same_date(self):
        self.seed(
            commodities="commodity USD\ncommodity VTSAX\ncommodity AAPL\n",
            prices="P 2026-01-02 VTSAX 100.00 USD\n",
        )

        added, skipped = fp.write_prices(
            self.ledger_dir,
            [
                {"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 999}]},
                {"commodity": "AAPL", "currency": "USD", "points": [{"date": "2026-01-02", "close": 150.25}]},
            ],
        )
        self.assertEqual((added, skipped), (1, 1))
        self.assertNotIn("999", self.prices_file())
        self.assertIn("P 2026-01-02 AAPL 150.25 USD", self.prices_file())

    def test_should_report_zero_added_and_skipped_for_an_empty_points_list(self):
        added, skipped = fp.write_prices(self.ledger_dir, [{"commodity": "VTSAX", "currency": "USD", "points": []}])
        self.assertEqual((added, skipped), (0, 0))

    def test_should_add_the_prices_journal_include_when_main_journal_lacks_it(self):
        self.seed(main=MAIN_WITHOUT_INCLUDE)
        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        self.assertIn("include prices.journal", self.main_file())

    def test_should_not_duplicate_an_existing_prices_journal_include(self):
        fp.write_prices(
            self.ledger_dir,
            [{"commodity": "VTSAX", "currency": "USD", "points": [{"date": "2026-01-02", "close": 100}]}],
        )
        includes = [l for l in self.main_file().splitlines() if "include prices.journal" in l]
        self.assertEqual(len(includes), 1)

    def test_ensure_prices_included_should_be_a_no_op_when_main_journal_is_missing(self):
        (self.ledger_dir / "main.journal").unlink()
        fp.ensure_prices_included(self.ledger_dir)  # must not raise
        self.assertFalse((self.ledger_dir / "main.journal").exists())


class TestHledgerCheck(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.main_path = Path(self._tmp.name) / "main.journal"
        self.main_path.write_text("; empty\n")
        self.addCleanup(self._tmp.cleanup)

    def test_should_run_hledger_check_strict_against_main_journal(self):
        with mock.patch("fetch_prices.subprocess.run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            fp.hledger_check(self.main_path)
            args = run.call_args[0][0]
        self.assertIn("check", args)
        self.assertIn("--strict", args)
        self.assertTrue(str(args[-1]).endswith("main.journal"))

    def test_should_raise_with_hledger_stderr_when_the_ledger_fails_validation(self):
        with mock.patch("fetch_prices.subprocess.run") as run:
            run.return_value = mock.Mock(returncode=1, stdout="", stderr="commodity VTSAX is not declared")
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.hledger_check(self.main_path)
        self.assertIn("commodity VTSAX is not declared", str(ctx.exception))


# ---- fetch_yahoo_daily_closes -----------------------------------------------


def chart_body(currency="USD", gmtoffset=0, timestamp=None, close=None, error=None, result=None):
    if error is not None:
        return {"chart": {"result": None, "error": error}}
    if result is not None:
        return {"chart": {"result": result, "error": None}}
    return {
        "chart": {
            "error": None,
            "result": [
                {
                    "meta": {"currency": currency, "gmtoffset": gmtoffset},
                    "timestamp": timestamp or [],
                    "indicators": {"quote": [{"close": close or []}]},
                }
            ],
        }
    }


class FakeResponse:
    def __init__(self, body):
        self._body = json.dumps(body).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, body):
    return urllib.error.HTTPError(
        url="https://query1.finance.yahoo.com/x", code=code, msg="err", hdrs=None, fp=io.BytesIO(json.dumps(body).encode())
    )


class TestFetchYahooDailyCloses(unittest.TestCase):
    def test_should_query_the_hardcoded_host_with_utc_midnight_period_bounds(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(chart_body())
            fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-03")

            req = urlopen.call_args[0][0]
            url = req.full_url

        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(url)
        self.assertEqual(f"{parsed.scheme}://{parsed.netloc}", "https://query1.finance.yahoo.com")
        self.assertEqual(parsed.path, "/v8/finance/chart/AAPL")
        qs = parse_qs(parsed.query)
        self.assertEqual(qs["interval"][0], "1d")

        period1 = int(qs["period1"][0])
        period2 = int(qs["period2"][0])
        expected_period1 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())
        expected_period2 = int(datetime(2026, 1, 4, tzinfo=timezone.utc).timestamp())
        self.assertEqual(period1, expected_period1)
        self.assertEqual(period2, expected_period2)

    def test_should_reject_a_symbol_with_a_slash_without_calling_the_network(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            with self.assertRaises(fp.FetchPricesError):
                fp.fetch_yahoo_daily_closes("../evil", "2026-01-01", "2026-01-02")
            urlopen.assert_not_called()

    def test_should_reject_invalid_symbols(self):
        for symbol in ["EVIL HOST", "a@b", "AAPL/../x", ""]:
            with self.subTest(symbol=symbol):
                with mock.patch("fetch_prices.urllib.request.urlopen"):
                    with self.assertRaises(fp.FetchPricesError):
                        fp.fetch_yahoo_daily_closes(symbol, "2026-01-01", "2026-01-02")

    def test_should_accept_valid_yahoo_tickers(self):
        for symbol in ["^GSPC", "EURUSD=X", "BRK-B", "BRK.B"]:
            with self.subTest(symbol=symbol):
                with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
                    urlopen.return_value = FakeResponse(chart_body())
                    currency, points = fp.fetch_yahoo_daily_closes(symbol, "2026-01-01", "2026-01-02")
                self.assertEqual((currency, points), ("USD", []))

    def test_should_map_each_close_to_its_exchange_local_trading_date_and_skip_nulls(self):
        # 02:00 UTC on Jan 3 at a -5h exchange is 21:00 on Jan 2 -> trading date Jan 2.
        t1 = int(datetime(2026, 1, 3, 2, 0, tzinfo=timezone.utc).timestamp())
        t2 = int(datetime(2026, 1, 4, 2, 0, tzinfo=timezone.utc).timestamp())
        t3 = int(datetime(2026, 1, 5, 2, 0, tzinfo=timezone.utc).timestamp())

        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(
                chart_body(gmtoffset=-18000, timestamp=[t1, t2, t3], close=[100.5, None, 101.25])
            )
            _, points = fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-06")

        self.assertEqual(
            points,
            [{"date": "2026-01-02", "close": 100.5}, {"date": "2026-01-04", "close": 101.25}],
        )

    def test_should_report_the_currency_from_yahoo_metadata(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(chart_body(currency="EUR"))
            currency, _ = fp.fetch_yahoo_daily_closes("SAP.DE", "2026-01-01", "2026-01-02")
        self.assertEqual(currency, "EUR")

    def test_should_surface_yahoos_structured_error_envelope(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.side_effect = http_error(
                404,
                {"chart": {"result": None, "error": {"code": "Not Found", "description": "No data found, symbol may be delisted"}}},
            )
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("NOPE", "2026-01-01", "2026-01-02")
        self.assertIn("No data found, symbol may be delisted", str(ctx.exception))

    def test_should_throw_on_a_non_ok_response_with_no_error_envelope(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.side_effect = http_error(500, {})
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-02")
        self.assertIn("HTTP 500", str(ctx.exception))

    def test_should_throw_when_the_payload_has_no_result(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(chart_body(result=[]))
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-02")
        self.assertIn("No price data", str(ctx.exception))

    def test_should_wrap_a_network_failure_as_fetchpriceserror(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.URLError("unexpected redirect")
            with self.assertRaises(fp.FetchPricesError):
                fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-02")

    def test_should_wrap_a_timeout_as_fetchpriceserror(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.side_effect = TimeoutError("timed out")
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-02")
        self.assertIn("timed out", str(ctx.exception))

    def test_should_fall_back_to_the_http_status_when_the_error_body_is_not_json(self):
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.side_effect = urllib.error.HTTPError(
                url="https://query1.finance.yahoo.com/x", code=503, msg="err", hdrs=None, fp=io.BytesIO(b"not json")
            )
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("AAPL", "2026-01-01", "2026-01-02")
        self.assertIn("HTTP 503", str(ctx.exception))

    def test_should_surface_an_error_envelope_on_an_otherwise_successful_response(self):
        # Yahoo can report an unknown symbol inside a 200 response too, not
        # just alongside a non-2xx status.
        with mock.patch("fetch_prices.urllib.request.urlopen") as urlopen:
            urlopen.return_value = FakeResponse(
                chart_body(error={"code": "Not Found", "description": "No data found"})
            )
            with self.assertRaises(fp.FetchPricesError) as ctx:
                fp.fetch_yahoo_daily_closes("NOPE", "2026-01-01", "2026-01-02")
        self.assertIn("No data found", str(ctx.exception))


# ---- CLI (main()) -----------------------------------------------------------


class TestMainCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        (self.home / "ledger").mkdir()
        (self.home / "ledger" / "main.journal").write_text("include commodities.journal\ninclude prices.journal\n")
        (self.home / "ledger" / "commodities.journal").write_text(
            "; Commodity declarations\ncommodity AAPL\ncommodity VTSAX\n"
        )
        (self.home / "ledger" / "prices.journal").write_text("; Market price history\n")
        self.addCleanup(self._tmp.cleanup)

        self._env_patch = mock.patch.dict("os.environ", {"ACCOUNTANT24_HOME": str(self.home)})
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)

        self._hledger_patch = mock.patch("fetch_prices.subprocess.run")
        run = self._hledger_patch.start()
        run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
        self.addCleanup(self._hledger_patch.stop)

    def run_main(self, argv):
        with mock.patch.object(sys, "argv", ["fetch_prices.py", *argv]):
            out, err = io.StringIO(), io.StringIO()
            code = 0
            try:
                with redirect_stdout(out), redirect_stderr(err):
                    fp.main()
            except SystemExit as e:
                code = e.code or 0
            return code, out.getvalue(), err.getvalue()

    def test_should_fetch_each_mapping_and_write_p_directives_under_its_ledger_commodity(self):
        def fake_fetch(symbol, start, end):
            return "USD", [{"date": "2026-01-02", "close": {"AAPL": 150.25, "VTSAX": 100.5}[symbol]}]

        with mock.patch("fetch_prices.fetch_yahoo_daily_closes", side_effect=fake_fetch):
            code, out, err = self.run_main(["AAPL=AAPL", "VTSAX=VTSAX", "--start", "2026-01-01", "--end", "2026-01-03"])

        self.assertEqual(code, 0)
        prices = (self.home / "ledger" / "prices.journal").read_text()
        self.assertIn("P 2026-01-02 AAPL 150.25 USD", prices)
        self.assertIn("P 2026-01-02 VTSAX 100.50 USD", prices)
        self.assertIn("Added 2 price(s) for AAPL, VTSAX", out)

    def test_should_default_the_end_date_to_today_when_omitted(self):
        captured = {}

        def fake_fetch(symbol, start, end):
            captured["end"] = end
            return "USD", []

        with mock.patch("fetch_prices.fetch_yahoo_daily_closes", side_effect=fake_fetch):
            with mock.patch("fetch_prices.date") as mock_date:
                mock_date.today.return_value = date(2026, 1, 15)
                code, _, _ = self.run_main(["AAPL=AAPL", "--start", "2026-01-01"])

        self.assertEqual(code, 0)
        self.assertEqual(captured["end"], "2026-01-15")

    def test_should_reject_a_malformed_start_date_before_any_fetch(self):
        with mock.patch("fetch_prices.fetch_yahoo_daily_closes") as fetch:
            code, _, err = self.run_main(["AAPL=AAPL", "--start", "01/01/2026"])
        self.assertEqual(code, 1)
        self.assertIn("invalid start date", err)
        fetch.assert_not_called()

    def test_should_reject_when_end_is_before_start(self):
        with mock.patch("fetch_prices.fetch_yahoo_daily_closes") as fetch:
            code, _, err = self.run_main(["AAPL=AAPL", "--start", "2026-02-01", "--end", "2026-01-01"])
        self.assertEqual(code, 1)
        self.assertIn("before start", err)
        fetch.assert_not_called()

    def test_should_propagate_a_yahoo_fetch_error(self):
        with mock.patch("fetch_prices.fetch_yahoo_daily_closes", side_effect=fp.FetchPricesError("delisted")):
            code, _, err = self.run_main(["AAPL=AAPL", "--start", "2026-01-01", "--end", "2026-01-02"])
        self.assertEqual(code, 1)
        self.assertIn("delisted", err)

    def test_should_reject_an_unknown_commodity_and_write_nothing(self):
        with mock.patch("fetch_prices.fetch_yahoo_daily_closes", return_value=("USD", [{"date": "2026-01-02", "close": 1.0}])):
            code, _, err = self.run_main(["NOTDECLARED=NOTDECLARED", "--start", "2026-01-01", "--end", "2026-01-02"])
        self.assertEqual(code, 1)
        self.assertIn("Unknown commodity: NOTDECLARED", err)
        self.assertNotIn("NOTDECLARED", (self.home / "ledger" / "prices.journal").read_text())

    def test_should_require_at_least_one_mapping(self):
        code, _, err = self.run_main(["--start", "2026-01-01"])
        self.assertEqual(code, 1)
        self.assertIn("at least one COMMODITY=TICKER mapping", err)

    def test_should_print_usage_and_exit_when_called_with_no_arguments(self):
        code, _, err = self.run_main([])
        self.assertEqual(code, 1)
        self.assertIn("usage:", err)

    def test_should_reject_an_unrecognized_argument(self):
        code, _, err = self.run_main(["--bogus"])
        self.assertEqual(code, 1)
        self.assertIn("unrecognized argument", err)

    def test_should_require_start_when_a_mapping_is_given(self):
        code, _, err = self.run_main(["AAPL=AAPL"])
        self.assertEqual(code, 1)
        self.assertIn("--start is required", err)

    def test_should_reject_a_malformed_end_date(self):
        with mock.patch("fetch_prices.fetch_yahoo_daily_closes") as fetch:
            code, _, err = self.run_main(["AAPL=AAPL", "--start", "2026-01-01", "--end", "01/02/2026"])
        self.assertEqual(code, 1)
        self.assertIn("invalid end date", err)
        fetch.assert_not_called()


class TestScriptEntryPoint(unittest.TestCase):
    """A real subprocess invocation - exercises `if __name__ == "__main__"`
    itself, which importing the module for the tests above never runs."""

    def test_should_exit_1_and_print_usage_with_no_arguments(self):
        script = Path(__file__).resolve().parent / "fetch_prices.py"
        proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("usage:", proc.stderr)


if __name__ == "__main__":
    unittest.main()
