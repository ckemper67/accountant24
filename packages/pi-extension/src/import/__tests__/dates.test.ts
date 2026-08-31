import { describe, expect, test } from "vitest";
import { detectDateOrder, parseDate } from "../dates";

describe("parseDate()", () => {
  describe("ISO YYYY-MM-DD (unambiguous)", () => {
    test("should return ISO date unchanged", () => {
      expect(parseDate("2025-01-15", "mdy")).toBe("2025-01-15");
    });

    test("should accept ISO date regardless of order setting", () => {
      expect(parseDate("2025-12-31", "dmy")).toBe("2025-12-31");
    });
  });

  describe("US format MM/DD/YYYY", () => {
    test("should parse 01/15/2025 as 2025-01-15 with mdy order", () => {
      expect(parseDate("01/15/2025", "mdy")).toBe("2025-01-15");
    });

    test("should parse 12/31/2024 as 2024-12-31 with mdy order", () => {
      expect(parseDate("12/31/2024", "mdy")).toBe("2024-12-31");
    });
  });

  describe("EU format DD/MM/YYYY", () => {
    test("should parse 15/01/2025 as 2025-01-15 with dmy order", () => {
      expect(parseDate("15/01/2025", "dmy")).toBe("2025-01-15");
    });

    test("should parse 31/12/2024 as 2024-12-31 with dmy order", () => {
      expect(parseDate("31/12/2024", "dmy")).toBe("2024-12-31");
    });
  });

  describe("German dotted DD.MM.YYYY", () => {
    test("should parse 15.01.2025 as 2025-01-15 with dmy order", () => {
      expect(parseDate("15.01.2025", "dmy")).toBe("2025-01-15");
    });

    test("should parse 31.12.2024 as 2024-12-31 with dmy order", () => {
      expect(parseDate("31.12.2024", "dmy")).toBe("2024-12-31");
    });
  });

  describe("2-digit year", () => {
    test("should expand 25 to 2025 (pivot: <= 49 -> 20xx)", () => {
      expect(parseDate("01/15/25", "mdy")).toBe("2025-01-15");
    });

    test("should expand 49 to 2049", () => {
      expect(parseDate("01/15/49", "mdy")).toBe("2049-01-15");
    });

    test("should expand 50 to 1950 (pivot: >= 50 -> 19xx)", () => {
      expect(parseDate("01/15/50", "mdy")).toBe("1950-01-15");
    });

    test("should expand 99 to 1999", () => {
      expect(parseDate("01/15/99", "mdy")).toBe("1999-01-15");
    });
  });

  describe("textual month day-first (15. Jan 2025)", () => {
    test("should parse '15. Jan 2025' as 2025-01-15", () => {
      expect(parseDate("15. Jan 2025", "dmy")).toBe("2025-01-15");
    });

    test("should parse '31. Dec 2024' as 2024-12-31", () => {
      expect(parseDate("31. Dec 2024", "dmy")).toBe("2024-12-31");
    });

    test("should parse full month name '15. January 2025' as 2025-01-15", () => {
      expect(parseDate("15. January 2025", "dmy")).toBe("2025-01-15");
    });
  });

  describe("textual month month-first (Jan 15, 2025)", () => {
    test("should parse 'Jan 15, 2025' as 2025-01-15", () => {
      expect(parseDate("Jan 15, 2025", "mdy")).toBe("2025-01-15");
    });

    test("should parse 'December 31, 2024' as 2024-12-31", () => {
      expect(parseDate("December 31, 2024", "mdy")).toBe("2024-12-31");
    });
  });

  describe("German textual months", () => {
    test("should parse '15. Mai 2025' as 2025-05-15", () => {
      expect(parseDate("15. Mai 2025", "dmy")).toBe("2025-05-15");
    });

    test("should parse '31. Dez 2024' as 2024-12-31", () => {
      expect(parseDate("31. Dez 2024", "dmy")).toBe("2024-12-31");
    });

    test("should parse '15. Maerz 2025' with umlaut (u+00e4) as 2025-03-15", () => {
      // "15. M\u00e4rz 2025"
      expect(parseDate("15. M\u00e4rz 2025", "dmy")).toBe("2025-03-15");
    });

    test("should parse full German month 'Dezember' month-first", () => {
      expect(parseDate("Dezember 31, 2024", "mdy")).toBe("2024-12-31");
    });
  });

  describe("range validation", () => {
    test("should throw when a mis-ordered date yields month > 12", () => {
      // "15/13/2025" under mdy order -> month=15, out of range.
      expect(() => parseDate("15/13/2025", "mdy")).toThrow(/out of range/);
    });

    test("should throw when day is out of range", () => {
      expect(() => parseDate("13/40/2025", "mdy")).toThrow(/out of range/);
    });
  });

  describe("error cases", () => {
    test("should throw for empty string", () => {
      expect(() => parseDate("", "mdy")).toThrow("Empty date string");
    });

    test("should throw for unknown month name", () => {
      expect(() => parseDate("15. Xyz 2025", "dmy")).toThrow(/Unknown month name/);
    });

    test("should throw for completely unparseable string", () => {
      expect(() => parseDate("not-a-date", "mdy")).toThrow();
    });
  });
});

describe("detectDateOrder()", () => {
  test("should detect dmy when first component > 12 (e.g. 15/01/2025)", () => {
    const samples = ["15/01/2025", "03/04/2025", "28/02/2025"];
    expect(detectDateOrder(samples)).toBe("dmy");
  });

  test("should detect mdy when second component > 12 (e.g. 01/15/2025)", () => {
    const samples = ["01/15/2025", "03/04/2025", "02/28/2025"];
    expect(detectDateOrder(samples)).toBe("mdy");
  });

  test("should resolve 03/04/2025 via sibling row with out-of-range component", () => {
    // 03/04/2025 is ambiguous on its own. But 15/01/2025 has first component 15 > 12,
    // forcing day-first order (dmy), which also applies to the ambiguous row.
    const samples = ["03/04/2025", "15/01/2025"];
    expect(detectDateOrder(samples)).toBe("dmy");
  });

  test("should throw when all rows are ambiguous (all components <= 12)", () => {
    const samples = ["03/04/2025", "01/02/2025", "05/06/2024"];
    expect(() => detectDateOrder(samples)).toThrow(/ambiguous|date order|date_format/i);
  });

  test("should throw with a helpful error message that mentions date_format", () => {
    const samples = ["01/01/2025"];
    expect(() => detectDateOrder(samples)).toThrow(/date_format/i);
  });

  test("should handle dotted DD.MM.YYYY format correctly", () => {
    const samples = ["15.01.2025", "03.04.2025"];
    expect(detectDateOrder(samples)).toBe("dmy");
  });

  test("should detect dmy from single unambiguous row", () => {
    const samples = ["31/12/2024"];
    expect(detectDateOrder(samples)).toBe("dmy");
  });
});
