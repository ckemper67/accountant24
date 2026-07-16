import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { spawnText } from "../../../spawn";

vi.mock("../../../spawn");

const BASE = mkdtempSync(join(tmpdir(), "accountant24-prices-"));
const LEDGER = join(BASE, "ledger");
vi.mock("../../../config.js", () => ({
  ACCOUNTANT24_HOME: BASE,
  LEDGER_DIR: LEDGER,
  MEMORY_PATH: join(BASE, "memory.md"),
  FILES_DIR: join(BASE, "files"),
  setBaseDir: () => {},
}));

const { writePrices, formatPriceDirective } = await import("../prices.js");

const MAIN_WITH_INCLUDE =
  "; Accountant24\n\ninclude commodities.journal\ninclude prices.journal\ninclude accounts.journal\n";
const MAIN_WITHOUT_INCLUDE = "; Accountant24\n\ninclude commodities.journal\ninclude accounts.journal\n";

function ok() {
  vi.mocked(spawnText).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
}

// By default the ledger already declares the commodities the tests price
// (VTSAX/USD). fetch_prices only ever prices commodities that already exist in
// the ledger; tests that exercise the missing-commodity guard override this.
const DEFAULT_COMMODITIES = "; Commodity declarations\ncommodity USD\ncommodity VTSAX\n";

function seed(opts?: { commodities?: string; prices?: string | null; main?: string }) {
  mkdirSync(LEDGER, { recursive: true });
  writeFileSync(join(LEDGER, "main.journal"), opts?.main ?? MAIN_WITH_INCLUDE);
  writeFileSync(join(LEDGER, "commodities.journal"), opts?.commodities ?? DEFAULT_COMMODITIES);
  const pricesPath = join(LEDGER, "prices.journal");
  if (opts?.prices == null) {
    if (existsSync(pricesPath)) rmSync(pricesPath);
  } else {
    writeFileSync(pricesPath, opts.prices);
  }
}

const pricesFile = () => readFileSync(join(LEDGER, "prices.journal"), "utf-8");
const commoditiesFile = () => readFileSync(join(LEDGER, "commodities.journal"), "utf-8");
const mainFile = () => readFileSync(join(LEDGER, "main.journal"), "utf-8");

beforeEach(() => {
  vi.clearAllMocks();
  ok();
  seed();
});

describe("formatPriceDirective()", () => {
  test.each([
    [150, "P 2026-01-15 VTSAX 150.00 USD"],
    [150.25, "P 2026-01-15 VTSAX 150.25 USD"],
    [150.2537, "P 2026-01-15 VTSAX 150.2537 USD"],
    [1234.5, "P 2026-01-15 VTSAX 1234.50 USD"],
    [0.1, "P 2026-01-15 VTSAX 0.10 USD"],
  ])("should render close=%p with 2-4 decimals", (close, expected) => {
    expect(formatPriceDirective("2026-01-15", "VTSAX", close, "USD")).toBe(expected);
  });
});

describe("writePrices()", () => {
  test("should append P directives for each point and report the count", async () => {
    const result = await writePrices([
      {
        commodity: "VTSAX",
        currency: "USD",
        points: [
          { date: "2026-01-02", close: 100.5 },
          { date: "2026-01-03", close: 101.25 },
        ],
      },
    ]);

    expect(result.pricesAdded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.ledgerIsValid).toBe(true);
    expect(pricesFile()).toContain("P 2026-01-02 VTSAX 100.50 USD");
    expect(pricesFile()).toContain("P 2026-01-03 VTSAX 101.25 USD");
  });

  test("should skip a (date, commodity) that already exists", async () => {
    seed({ prices: "P 2026-01-02 VTSAX 100.00 USD\n" });

    const result = await writePrices([
      {
        commodity: "VTSAX",
        currency: "USD",
        points: [
          { date: "2026-01-02", close: 999 },
          { date: "2026-01-03", close: 101.25 },
        ],
      },
    ]);

    expect(result.pricesAdded).toBe(1);
    expect(result.skipped).toBe(1);
    // The pre-existing rate is untouched (not overwritten with 999).
    expect(pricesFile()).toContain("P 2026-01-02 VTSAX 100.00 USD");
    expect(pricesFile()).not.toContain("999");
    expect(pricesFile()).toContain("P 2026-01-03 VTSAX 101.25 USD");
  });

  test("should reject a commodity that is not declared in the ledger", async () => {
    seed({ commodities: "commodity USD\n", prices: "" });

    await expect(
      writePrices([{ commodity: "VTHRX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]),
    ).rejects.toThrow("Unknown commodity: VTHRX");
    // Nothing is written: no phantom commodity, no price line.
    expect(commoditiesFile()).not.toContain("VTHRX");
    expect(pricesFile()).not.toContain("VTHRX");
  });

  test("should auto-declare the quote currency when missing but never the commodity", async () => {
    seed({ commodities: "commodity VTSAX\n" });
    await writePrices([{ commodity: "VTSAX", currency: "EUR", points: [{ date: "2026-01-02", close: 100 }] }]);

    expect(commoditiesFile()).toMatch(/^commodity EUR$/m);
  });

  test("should not redeclare an already-declared commodity", async () => {
    seed({ commodities: "commodity USD\ncommodity VTSAX\n" });
    await writePrices([{ commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]);

    const declarations = commoditiesFile().match(/^commodity VTSAX$/gm) ?? [];
    expect(declarations).toHaveLength(1);
  });

  test("should treat a quoted commodity as the same as its unquoted declaration for dedup", async () => {
    seed({ commodities: "commodity USD\ncommodity FDRXX\n", prices: "P 2026-01-02 FDRXX 1.00 USD\n" });

    const result = await writePrices([
      { commodity: '"FDRXX"', currency: "USD", points: [{ date: "2026-01-02", close: 999 }] },
    ]);

    expect(result.pricesAdded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(pricesFile()).not.toContain("999");
  });

  test("should render the P directive using the declared quoting form", async () => {
    seed({ commodities: 'commodity USD\ncommodity "VANG_TARGET_2030"\n', prices: "" });

    // Caller passes the bare name; output must match the quoted declaration.
    await writePrices([
      { commodity: "VANG_TARGET_2030", currency: "USD", points: [{ date: "2026-01-02", close: 45.49 }] },
    ]);

    expect(pricesFile()).toContain('P 2026-01-02 "VANG_TARGET_2030" 45.49 USD');
  });

  test("should render the quote currency in its declared form", async () => {
    seed({ commodities: 'commodity VTSAX\ncommodity "GBP"\n', prices: "" });

    await writePrices([{ commodity: "VTSAX", currency: "GBP", points: [{ date: "2026-01-02", close: 100 }] }]);

    expect(pricesFile()).toContain('P 2026-01-02 VTSAX 100.00 "GBP"');
  });

  test("should recognize an amount-style commodity declaration (`commodity 1.000 VTSAX`)", async () => {
    seed({ commodities: "commodity 1.000 USD\ncommodity 1,000.00 VTSAX\n", prices: "" });

    const result = await writePrices([
      { commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] },
    ]);

    expect(result.pricesAdded).toBe(1);
    expect(pricesFile()).toContain("P 2026-01-02 VTSAX 100.00 USD");
  });

  test("should write directives for every commodity in a multi-commodity batch", async () => {
    seed({ commodities: "commodity USD\ncommodity VTSAX\ncommodity AAPL\n", prices: "" });

    const result = await writePrices([
      { commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100.5 }] },
      { commodity: "AAPL", currency: "USD", points: [{ date: "2026-01-02", close: 150.25 }] },
    ]);

    expect(result.pricesAdded).toBe(2);
    expect(pricesFile()).toContain("P 2026-01-02 VTSAX 100.50 USD");
    expect(pricesFile()).toContain("P 2026-01-02 AAPL 150.25 USD");
  });

  test("should dedupe per commodity, not across commodities, on the same date", async () => {
    // Two different commodities on the same date must both be written; the
    // shared-date dedup key must include the commodity.
    seed({
      commodities: "commodity USD\ncommodity VTSAX\ncommodity AAPL\n",
      prices: "P 2026-01-02 VTSAX 100.00 USD\n",
    });

    const result = await writePrices([
      { commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 999 }] },
      { commodity: "AAPL", currency: "USD", points: [{ date: "2026-01-02", close: 150.25 }] },
    ]);

    expect(result.pricesAdded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(pricesFile()).not.toContain("999");
    expect(pricesFile()).toContain("P 2026-01-02 AAPL 150.25 USD");
  });

  test("should report zero added and skipped for an empty points array", async () => {
    const result = await writePrices([{ commodity: "VTSAX", currency: "USD", points: [] }]);

    expect(result.pricesAdded).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("should add the prices.journal include when main.journal lacks it", async () => {
    seed({ main: MAIN_WITHOUT_INCLUDE });
    await writePrices([{ commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]);

    expect(mainFile()).toContain("include prices.journal");
  });

  test("should not duplicate an existing prices.journal include", async () => {
    await writePrices([{ commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]);

    const includes = mainFile().match(/include prices\.journal/g) ?? [];
    expect(includes).toHaveLength(1);
  });

  test("should throw with hledger stderr when the ledger fails validation", async () => {
    vi.mocked(spawnText).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "commodity VTSAX is not declared",
    });

    await expect(
      writePrices([{ commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]),
    ).rejects.toThrow("commodity VTSAX is not declared");
  });

  test("should produce a diff of the prices.journal change", async () => {
    const result = await writePrices([
      { commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100.5 }] },
    ]);
    expect(result.diff).toContain("100.50");
  });

  test("should run hledger check --strict against main.journal", async () => {
    await writePrices([{ commodity: "VTSAX", currency: "USD", points: [{ date: "2026-01-02", close: 100 }] }]);

    const args = vi.mocked(spawnText).mock.calls.at(-1)?.[0] as string[];
    expect(args).toContain("check");
    expect(args).toContain("--strict");
    expect(args.some((a) => a.endsWith("main.journal"))).toBe(true);
  });
});
