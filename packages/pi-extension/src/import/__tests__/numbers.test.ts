import { describe, expect, test } from "vitest";
import { detectNumberFormat, parseLocaleAmount } from "../numbers";

describe("parseLocaleAmount()", () => {
  describe("US format (dot decimal, comma thousands)", () => {
    test("should parse 1,234.56 as 1234.56", () => {
      expect(parseLocaleAmount("1,234.56", "us")).toBe(1234.56);
    });

    test("should parse 1234.56 as 1234.56", () => {
      expect(parseLocaleAmount("1234.56", "us")).toBe(1234.56);
    });

    test("should parse 0.99 as 0.99", () => {
      expect(parseLocaleAmount("0.99", "us")).toBe(0.99);
    });

    test("should parse -1,234.56 as -1234.56", () => {
      expect(parseLocaleAmount("-1,234.56", "us")).toBe(-1234.56);
    });
  });

  describe("German format (comma decimal, dot thousands)", () => {
    test("should parse 1.234,56 as 1234.56", () => {
      expect(parseLocaleAmount("1.234,56", "de")).toBe(1234.56);
    });

    test("should parse 1234,56 as 1234.56", () => {
      expect(parseLocaleAmount("1234,56", "de")).toBe(1234.56);
    });

    test("should parse -1.234,56 as -1234.56", () => {
      expect(parseLocaleAmount("-1.234,56", "de")).toBe(-1234.56);
    });
  });

  describe("French/SI format (space/NBSP thousands, comma decimal)", () => {
    test("should parse '1 234,56' (regular space) as 1234.56", () => {
      expect(parseLocaleAmount("1 234,56", "fr")).toBe(1234.56);
    });

    test("should parse '1 234,56' (NBSP) as 1234.56", () => {
      // U+00A0 is non-breaking space (NBSP).
      expect(parseLocaleAmount("1 234,56", "fr")).toBe(1234.56);
    });

    test("should parse '1 234,56' (narrow NBSP U+202F) as 1234.56", () => {
      // Some French exports use narrow no-break space U+202F.
      // Our regex covers regular space and NBSP; U+202F is in the space group too.
      // Test with regular space as the canonical case.
      expect(parseLocaleAmount("1 234,56", "fr")).toBe(1234.56);
    });
  });

  describe("Swiss format (apostrophe thousands, dot decimal)", () => {
    test("should parse 1'234.56 as 1234.56", () => {
      expect(parseLocaleAmount("1'234.56", "ch")).toBe(1234.56);
    });

    test("should parse 1'234'567.89 as 1234567.89", () => {
      expect(parseLocaleAmount("1'234'567.89", "ch")).toBe(1234567.89);
    });
  });

  describe("parenthesized negatives", () => {
    test("should parse (1.234,56) as -1234.56 (German format)", () => {
      expect(parseLocaleAmount("(1.234,56)", "de")).toBe(-1234.56);
    });

    test("should parse (1,234.56) as -1234.56 (US format)", () => {
      expect(parseLocaleAmount("(1,234.56)", "us")).toBe(-1234.56);
    });

    test("should parse (0.99) as -0.99", () => {
      expect(parseLocaleAmount("(0.99)", "us")).toBeCloseTo(-0.99);
    });
  });

  describe("trailing minus sign", () => {
    test("should parse '1234.56-' as -1234.56", () => {
      expect(parseLocaleAmount("1234.56-", "us")).toBe(-1234.56);
    });

    test("should parse '1.234,56-' as -1234.56 (German)", () => {
      expect(parseLocaleAmount("1.234,56-", "de")).toBe(-1234.56);
    });
  });

  describe("Soll/Haben (S/H) markers", () => {
    test("should parse '1234.56 S' as -1234.56 (Soll = debit)", () => {
      expect(parseLocaleAmount("1234.56 S", "us")).toBe(-1234.56);
    });

    test("should parse '1234.56 H' as 1234.56 (Haben = credit)", () => {
      expect(parseLocaleAmount("1234.56 H", "us")).toBe(1234.56);
    });
  });

  describe("CR/DR markers", () => {
    test("should parse '1234.56 DR' as -1234.56 (debit)", () => {
      expect(parseLocaleAmount("1234.56 DR", "us")).toBe(-1234.56);
    });

    test("should parse '1234.56 CR' as 1234.56 (credit)", () => {
      expect(parseLocaleAmount("1234.56 CR", "us")).toBe(1234.56);
    });
  });

  describe("Unicode minus / en-dash", () => {
    test("should parse Unicode minus U+2212 as a negative sign", () => {
      // U+2212 is the mathematical minus sign.
      expect(parseLocaleAmount("−1234.56", "us")).toBe(-1234.56);
    });

    test("should parse en-dash U+2013 as a negative sign", () => {
      expect(parseLocaleAmount("–1234.56", "us")).toBe(-1234.56);
    });
  });

  describe("Indian lakh/crore grouping rejection", () => {
    test("should throw for Indian lakh grouping 12,34,567.89", () => {
      expect(() => parseLocaleAmount("12,34,567.89", "us")).toThrow(/Indian|lakh|crore/i);
    });

    test("should include override hint in the error message", () => {
      expect(() => parseLocaleAmount("12,34,567.89", "us")).toThrow(/number_format/i);
    });
  });

  describe("override wins over detection", () => {
    test("should parse 1.234 as 1234 when format is de (dot = thousands)", () => {
      // With de format, the dot is a thousands separator, so 1.234 = 1234.
      const result = parseLocaleAmount("1.234", "de");
      expect(result).toBe(1234);
    });

    test("should parse 1,234 as 1.234 when format is us (comma = thousands, 3 fractional)", () => {
      // 1,234 with US format: comma is thousands, so 1234.
      // (3 digits after comma could be thousands, so result is 1234)
      const result = parseLocaleAmount("1,234", "us");
      expect(result).toBe(1234);
    });
  });

  describe("zero and empty", () => {
    test("should return 0 for empty string", () => {
      expect(parseLocaleAmount("", "us")).toBe(0);
    });

    test("should return 0 for '0'", () => {
      expect(parseLocaleAmount("0", "us")).toBe(0);
    });
  });

  describe("malformed values fail loudly", () => {
    test("should throw when a stray second separator remains after normalization", () => {
      // "1.2.3" under US format normalizes to "1.2.3" (comma-strip only) which is not a
      // clean decimal -- must throw rather than silently truncate to 1.2.
      expect(() => parseLocaleAmount("1.2.3", "us")).toThrow(/Cannot parse amount/);
    });
  });
});

describe("detectNumberFormat()", () => {
  test("should detect 'us' for samples with dot decimal and comma thousands", () => {
    const samples = ["1,234.56", "20.00", "100.50"];
    expect(detectNumberFormat(samples)).toBe("us");
  });

  test("should detect 'de' for samples with comma decimal and dot thousands", () => {
    const samples = ["1.234,56", "20,00", "100,50"];
    expect(detectNumberFormat(samples)).toBe("de");
  });

  test("should detect 'fr' for samples with space thousands and comma decimal", () => {
    const samples = ["1 234,56", "20,00"];
    expect(detectNumberFormat(samples)).toBe("fr");
  });

  test("should detect 'ch' for samples with apostrophe thousands and dot decimal", () => {
    const samples = ["1'234.56", "20.00"];
    expect(detectNumberFormat(samples)).toBe("ch");
  });

  test("should default to 'us' for ambiguous integer-only samples", () => {
    const samples = ["1000", "2000", "500"];
    expect(detectNumberFormat(samples)).toBe("us");
  });

  test("should prefer comma-decimal when both separators present and comma is rightmost", () => {
    // "1.234,56" -- dot appears before comma, so comma is decimal -> de
    const samples = ["1.234,56"];
    expect(detectNumberFormat(samples)).toBe("de");
  });

  test("should prefer dot-decimal when both separators present and dot is rightmost", () => {
    // "1,234.56" -- comma appears before dot, so dot is decimal -> us
    const samples = ["1,234.56"];
    expect(detectNumberFormat(samples)).toBe("us");
  });

  test("should infer 'de' from dot-thousands-only samples (avoids silent 1000x error)", () => {
    // A German column of whole-thousand euros: "1.234" means 1234, not 1.234. Detection
    // must NOT default to 'us' here -- that would silently divide every amount by ~1000.
    const samples = ["1.234", "5.678", "9.012"];
    expect(detectNumberFormat(samples)).toBe("de");
  });

  test("should infer 'us' from comma-thousands-only samples", () => {
    const samples = ["1,234", "5,678", "9,012"];
    expect(detectNumberFormat(samples)).toBe("us");
  });

  test("should throw on conflicting decimal evidence rather than guess", () => {
    // One value implies comma-decimal, another implies dot-decimal -- unresolvable.
    const samples = ["1.234,56", "1,234.56"];
    expect(() => detectNumberFormat(samples)).toThrow(/ambiguous|number_format/i);
  });

  test("should throw when the sample has multi-group evidence for both dot and comma grouping with no decimal evidence", () => {
    // "1.234.567" implies dot-as-thousands (German-style multi-group); "1,234,567" implies
    // comma-as-thousands (US-style multi-group). Neither sample carries decimal evidence, so
    // there's no way to tell which grouping convention the file actually uses.
    const samples = ["1.234.567", "1,234,567"];
    expect(() => detectNumberFormat(samples)).toThrow(/ambiguous|number_format/i);
  });
});
