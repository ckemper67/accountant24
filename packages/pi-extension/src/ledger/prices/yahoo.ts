// The one and only place in the extension that makes an outbound network call.
//
// It fetches daily closing prices from Yahoo Finance's public chart endpoint.
// Security posture (see the plan): a single hardcoded host, the ticker is
// charset-validated before it ever enters the URL path, redirects are treated
// as errors (so a redirect can't send the request to another host), and there
// is a hard request timeout. Nothing here selects a data source or host at
// runtime.

/** The only host/endpoint this extension ever contacts. */
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Hard cap on how long a single request may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Allowed Yahoo ticker characters: letters, digits, and the punctuation Yahoo
 * itself uses (`.` exchange suffixes / BRK.B, `-` BRK-B, `^` indices like
 * ^GSPC, `=` forex like EURUSD=X). Anything else (slashes, spaces, `@`, `..`)
 * is rejected so the symbol cannot manipulate the URL path or host.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,20}$/;

export interface PricePoint {
  /** Trading date in YYYY-MM-DD (in the exchange's local timezone). */
  date: string;
  /** Closing price. */
  close: number;
}

export interface YahooPrices {
  /** Quote currency reported by Yahoo, e.g. "USD". */
  currency: string;
  points: PricePoint[];
}

export class InvalidSymbolError extends Error {
  constructor(symbol: string) {
    super(`Invalid ticker symbol: ${JSON.stringify(symbol)}`);
    this.name = "InvalidSymbolError";
  }
}

export class YahooFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooFetchError";
  }
}

/** 00:00 UTC of the given YYYY-MM-DD date, in whole UNIX seconds. */
function dayStartUnix(date: string): number {
  return Math.floor(Date.UTC(...ymd(date)) / 1000);
}

function ymd(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}. Expected YYYY-MM-DD.`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

/**
 * Fetch daily closing prices for `symbol` between `start` and `end` (both
 * inclusive, YYYY-MM-DD). Days without a close (market holidays) are skipped.
 */
export async function fetchYahooDailyCloses(
  symbol: string,
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<YahooPrices> {
  if (!SYMBOL_PATTERN.test(symbol)) throw new InvalidSymbolError(symbol);

  const period1 = dayStartUnix(start);
  // period2 is exclusive-ish; advance one day so `end` itself is included.
  const period2 = dayStartUnix(end) + 86_400;

  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}` + `?period1=${period1}&period2=${period2}&interval=1d`;

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "error",
      signal: composite,
      headers: { "User-Agent": "accountant24" },
    });
  } catch (e) {
    if (timeout.aborted) throw new YahooFetchError(`Request to Yahoo timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new YahooFetchError(`Failed to reach Yahoo: ${(e as Error).message}`);
  }

  const body = await res.json().catch(() => null);

  // Yahoo reports unknown symbols / bad ranges in a structured error envelope,
  // often alongside a non-2xx status.
  const apiError = body?.chart?.error;
  if (apiError) throw new YahooFetchError(`Yahoo error for ${symbol}: ${apiError.description ?? apiError.code}`);
  if (!res.ok) throw new YahooFetchError(`Yahoo returned HTTP ${res.status} for ${symbol}`);

  const result = body?.chart?.result?.[0];
  if (!result) throw new YahooFetchError(`No price data returned for ${symbol}`);

  const currency: string = result.meta?.currency ?? "USD";
  const gmtoffset: number = result.meta?.gmtoffset ?? 0;
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

  const points: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue; // holiday / missing datapoint
    // Shift by the exchange's offset so the calendar date is the trading day
    // in the exchange's timezone, then read the date in UTC.
    const date = new Date((timestamps[i] + gmtoffset) * 1000).toISOString().slice(0, 10);
    points.push({ date, close });
  }

  return { currency, points };
}
