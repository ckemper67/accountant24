import { describe, expect, test } from "vitest";
import { parseCsv, parseCsvWithMeta } from "../csv";

describe("parseCsv()", () => {
  describe("header auto-detection", () => {
    test("should detect date, amount, description columns automatically", () => {
      const csv = ["Date,Amount,Description", "2025-01-15,-45.00,Grocery Store"].join("\n");
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("2025-01-15");
      expect(rows[0].amount).toBe("-45.00");
      expect(rows[0].description).toBe("Grocery Store");
    });

    test("should detect German header names (Datum, Betrag)", () => {
      const csv = ["Datum,Betrag,Verwendungszweck", "15.01.2025,-45,00,Supermarkt"].join("\n");
      // Datum -> date, Betrag -> amount, Verwendungszweck -> description
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("15.01.2025");
    });

    test("should detect payee column", () => {
      const csv = ["Date,Amount,Payee,Description", "2025-01-15,-45.00,Whole Foods,Groceries"].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].payee).toBe("Whole Foods");
      expect(rows[0].description).toBe("Groceries");
    });

    test("should detect currency column", () => {
      const csv = ["Date,Amount,Currency", "2025-01-15,-45.00,EUR"].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].currency).toBe("EUR");
    });

    test("should return empty payee and currency when not present", () => {
      const csv = ["Date,Amount", "2025-01-15,-45.00"].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].payee).toBe("");
      expect(rows[0].currency).toBe("");
    });
  });

  describe("metadata preamble before the header", () => {
    const withPreamble = [
      "Account Statement",
      "Account: 1234567890",
      "Period: 2025-01-01 to 2025-01-31",
      "Date,Amount,Payee",
      "2025-01-15,-45.00,Whole Foods",
      "2025-01-16,2000.00,ACME Corp",
    ].join("\n");

    test("should skip metadata rows and detect the real header automatically", () => {
      const rows = parseCsv(withPreamble);
      expect(rows).toHaveLength(2);
      expect(rows[0].date).toBe("2025-01-15");
      expect(rows[0].payee).toBe("Whole Foods");
    });

    test("should not treat preamble lines as data rows", () => {
      const rows = parseCsv(withPreamble);
      expect(rows.some((r) => r.date.includes("Account"))).toBe(false);
    });

    test("should honor an explicit skip_rows override", () => {
      const rows = parseCsv(withPreamble, undefined, 3);
      expect(rows).toHaveLength(2);
      expect(rows[0].date).toBe("2025-01-15");
    });
  });

  describe("parseCsvWithMeta() detection metadata", () => {
    test("should report the skipped preamble, header row index, and detected columns", () => {
      const csv = ["Bank Export", "Generated 2025-02-01", "Date,Amount,Payee", "2025-01-15,-45.00,Whole Foods"].join(
        "\n",
      );
      const meta = parseCsvWithMeta(csv);
      expect(meta.headerRowIndex).toBe(2);
      expect(meta.preamble).toEqual(["Bank Export", "Generated 2025-02-01"]);
      expect(meta.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(meta.rows[0].payee).toBe("Whole Foods");
    });

    test("should report zero preamble for a plain single-header CSV", () => {
      const csv = ["Date,Amount", "2025-01-15,-45.00"].join("\n");
      const meta = parseCsvWithMeta(csv);
      expect(meta.headerRowIndex).toBe(0);
      expect(meta.preamble).toEqual([]);
    });
  });

  describe("explicit column_map", () => {
    test("should use column_map to resolve non-standard header names", () => {
      const csv = ["Buchungsdatum,Umsatz,Beguenstigter,Verwendungszweck", "2025-01-15,-45.00,REWE,Groceries"].join(
        "\n",
      );
      const rows = parseCsv(csv, {
        date: "Buchungsdatum",
        amount: "Umsatz",
        payee: "Beguenstigter",
        description: "Verwendungszweck",
      });
      expect(rows[0].date).toBe("2025-01-15");
      expect(rows[0].amount).toBe("-45.00");
      expect(rows[0].payee).toBe("REWE");
      expect(rows[0].description).toBe("Groceries");
    });

    test("should throw when column_map references a header that does not exist", () => {
      const csv = ["Date,Amount", "2025-01-15,-45.00"].join("\n");
      expect(() => parseCsv(csv, { date: "NonExistentColumn" })).toThrow(/NonExistentColumn/);
    });
  });

  describe("debit/credit column collapse", () => {
    test("should collapse separate debit and credit columns", () => {
      const csv = [
        "Date,Debit,Credit,Description",
        "2025-01-15,45.00,,Grocery Store",
        "2025-01-16,,100.00,Paycheck",
      ].join("\n");
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(2);
      // Debit = outflow -> negated
      expect(rows[0].amount).toBe("-45.00");
      // Credit = inflow -> positive
      expect(rows[1].amount).toBe("100.00");
    });

    test("should prefix minus to debit amount that is not already negative", () => {
      const csv = ["Date,Debit,Credit", "2025-01-15,99.50,"].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].amount).toBe("-99.50");
    });

    test("should not double-negate debit amounts that are already negative", () => {
      const csv = ["Date,Debit,Credit", "2025-01-15,-99.50,"].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].amount).toBe("-99.50");
    });
  });

  describe("blank lines and whitespace", () => {
    test("should skip rows with no date (e.g. footer summary rows)", () => {
      const csv = ["Date,Amount,Description", "2025-01-15,-45.00,Grocery Store", ",,Total: 45"].join("\n");
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
    });

    test("should handle blank lines in the CSV", () => {
      const csv = ["Date,Amount", "", "2025-01-15,-45.00", ""].join("\n");
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
    });

    test("should handle CRLF line endings", () => {
      const csv = "Date,Amount\r\n2025-01-15,-45.00\r\n";
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("2025-01-15");
    });
  });

  describe("quoted fields", () => {
    test("should handle quoted fields with commas", () => {
      const csv = ["Date,Amount,Description", '2025-01-15,-45.00,"Grocery Store, Berlin"'].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].description).toBe("Grocery Store, Berlin");
    });

    test("should handle doubled quotes within quoted field", () => {
      const csv = ["Date,Amount,Description", '2025-01-15,-45.00,"She said ""hello"""'].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0].description).toBe('She said "hello"');
    });
  });

  describe("empty input", () => {
    test("should return empty array for empty string", () => {
      expect(parseCsv("")).toHaveLength(0);
    });

    test("should return empty array for header-only CSV", () => {
      expect(parseCsv("Date,Amount")).toHaveLength(0);
    });
  });

  describe("error cases", () => {
    test("should throw when no date column found and no column_map", () => {
      const csv = ["Foo,Bar", "a,b"].join("\n");
      expect(() => parseCsv(csv)).toThrow(/date column/i);
    });

    test("should throw when no amount column found and no column_map", () => {
      const csv = ["Date,Foo", "2025-01-15,bar"].join("\n");
      expect(() => parseCsv(csv)).toThrow(/amount/i);
    });
  });
});
