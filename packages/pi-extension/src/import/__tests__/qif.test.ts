import { describe, expect, test } from "vitest";
import { looksLikeQif, parseQif } from "../qif";

const SAMPLE_QIF = `!Type:Bank
D01/15/2025
T-45.00
PWhole Foods
MGroceries
^
D01/16/2025
T2000.00
PACME Corp
MJanuary salary
^
`;

const SIMPLE_CSV = "Date,Amount,Payee,Description\n2025-01-15,-45.00,Whole Foods,Groceries\n";

describe("looksLikeQif()", () => {
  test("should return true for text starting with a !Type: header", () => {
    expect(looksLikeQif(SAMPLE_QIF)).toBe(true);
  });

  test("should return true when the !Type: header has leading whitespace", () => {
    expect(looksLikeQif("  !Type:CCard\nD01/01/2025\nT-1.00\n^\n")).toBe(true);
  });

  test("should return false for CSV text", () => {
    expect(looksLikeQif(SIMPLE_CSV)).toBe(false);
  });

  test("should return false for empty text", () => {
    expect(looksLikeQif("")).toBe(false);
  });
});

describe("parseQif()", () => {
  test("should extract one row per record", () => {
    const rows = parseQif(SAMPLE_QIF);
    expect(rows).toHaveLength(2);
  });

  test("should read D as the raw date string", () => {
    const rows = parseQif(SAMPLE_QIF);
    expect(rows[0].date).toBe("01/15/2025");
    expect(rows[1].date).toBe("01/16/2025");
  });

  test("should normalize a Quicken apostrophe-year date to a slash separator", () => {
    const qif = "!Type:Bank\nD1/15'25\nT-45.00\nPWhole Foods\n^\n";
    const rows = parseQif(qif);
    expect(rows[0].date).toBe("1/15/25");
  });

  test("should read T verbatim as the amount string", () => {
    const rows = parseQif(SAMPLE_QIF);
    expect(rows[0].amount).toBe("-45.00");
    expect(rows[1].amount).toBe("2000.00");
  });

  test("should read P as payee and M as description", () => {
    const rows = parseQif(SAMPLE_QIF);
    expect(rows[0].payee).toBe("Whole Foods");
    expect(rows[0].description).toBe("Groceries");
  });

  test("should default payee and description to empty strings when P/M are absent", () => {
    const qif = "!Type:Bank\nD01/15/2025\nT-45.00\n^\n";
    const rows = parseQif(qif);
    expect(rows[0].payee).toBe("");
    expect(rows[0].description).toBe("");
  });

  test("should set currency to an empty string on every row (QIF has no currency field)", () => {
    const rows = parseQif(SAMPLE_QIF);
    expect(rows[0].currency).toBe("");
    expect(rows[1].currency).toBe("");
  });

  test("should fall back to U when T is absent", () => {
    const qif = "!Type:Bank\nD01/15/2025\nU-45.00\nPWhole Foods\n^\n";
    const rows = parseQif(qif);
    expect(rows[0].amount).toBe("-45.00");
  });

  test("should prefer T over U when both are present", () => {
    const qif = "!Type:Bank\nD01/15/2025\nU-99.99\nT-45.00\nPWhole Foods\n^\n";
    const rows = parseQif(qif);
    expect(rows[0].amount).toBe("-45.00");
  });

  test("should ignore unrecognized field codes (L, N, C, A) without erroring", () => {
    const qif = "!Type:Bank\nD01/15/2025\nT-45.00\nPWhole Foods\nLGroceries:Food\nN1234\nCX\nA123 Main St\n^\n";
    const rows = parseQif(qif);
    expect(rows).toHaveLength(1);
    expect(rows[0].payee).toBe("Whole Foods");
  });

  test("should parse a record with no trailing ^ terminator (file cut off)", () => {
    const qif = "!Type:Bank\nD01/15/2025\nT-45.00\nPWhole Foods";
    const rows = parseQif(qif);
    expect(rows).toHaveLength(1);
    expect(rows[0].payee).toBe("Whole Foods");
  });

  test("should throw a descriptive error when a record is missing D", () => {
    const qif = "!Type:Bank\nT-45.00\nPWhole Foods\n^\n";
    expect(() => parseQif(qif)).toThrow(/Malformed QIF record/);
  });

  test("should throw a descriptive error when a record is missing T/U", () => {
    const qif = "!Type:Bank\nD01/15/2025\nPWhole Foods\n^\n";
    expect(() => parseQif(qif)).toThrow(/Malformed QIF record/);
  });

  test("should return no rows for text with only a header and no records", () => {
    const rows = parseQif("!Type:Bank\n");
    expect(rows).toHaveLength(0);
  });

  test("should tolerate blank lines between records", () => {
    const qif = "!Type:Bank\n\nD01/15/2025\nT-45.00\nPWhole Foods\n\n^\n\nD01/16/2025\nT2000.00\nPACME Corp\n^\n";
    const rows = parseQif(qif);
    expect(rows).toHaveLength(2);
  });
});
