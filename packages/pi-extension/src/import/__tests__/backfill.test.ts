import { describe, expect, test } from "vitest";
import { backfillTransaction } from "../backfill";

describe("backfillTransaction()", () => {
  test("should insert both tags right after the header when neither exists", () => {
    const content = [
      "2025-01-15 * Internal Transfer",
      "    ; original_payee_name: External Withdrawal ACME BANK",
      "    ; related_file: files/2025/01/statement.OFX",
      "    assets:bank:checking                                              -50.00 USD",
      "    liabilities:credit-card:acme                                        50.00 USD",
      "",
    ].join("\n");

    const result = backfillTransaction(
      content,
      { file: "/x", startLine: 1 },
      "csv:abc123",
      "External Withdrawal ACME BANK",
    );

    expect(result.changed).toBe(true);
    const lines = result.newContent.split("\n");
    expect(lines[1]).toBe("    ; import_id: csv:abc123");
    expect(lines[2]).toBe("    ; original_description: External Withdrawal ACME BANK");
    // Existing tags and postings are preserved, unmoved relative to each other.
    expect(lines[3]).toBe("    ; original_payee_name: External Withdrawal ACME BANK");
    expect(lines[4]).toBe("    ; related_file: files/2025/01/statement.OFX");
    expect(lines[5]).toContain("assets:bank:checking");
  });

  test("should replace an existing import_id tag's value in place, not insert a duplicate", () => {
    const content = [
      "2025-01-20 * External Withdrawal WIDGETCO | External Withdrawal WIDGETCO",
      "    ; import_id: ofx:FITID-001",
      "    ; original_description: AUTOPAY - PAYMENT",
      "    assets:bank:checking                                              -75.00 USD",
      "    liabilities:credit-card:widgetco                                    75.00 USD",
      "",
    ].join("\n");

    const result = backfillTransaction(
      content,
      { file: "/x", startLine: 1 },
      "csv:def456",
      "External Withdrawal WIDGETCO",
    );

    const lines = result.newContent.split("\n");
    expect(lines[1]).toBe("    ; import_id: csv:def456");
    expect(lines[2]).toBe("    ; original_description: External Withdrawal WIDGETCO");
    expect(lines.filter((l) => l.includes("; import_id:"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("; original_description:"))).toHaveLength(1);
  });

  test("should report changed=false when both tags already hold the target values", () => {
    const content = [
      "2025-01-20 * External Withdrawal WIDGETCO | External Withdrawal WIDGETCO",
      "    ; import_id: csv:def456",
      "    ; original_description: External Withdrawal WIDGETCO",
      "    assets:bank:checking                                              -75.00 USD",
      "    liabilities:credit-card:widgetco                                    75.00 USD",
      "",
    ].join("\n");

    const result = backfillTransaction(
      content,
      { file: "/x", startLine: 1 },
      "csv:def456",
      "External Withdrawal WIDGETCO",
    );

    expect(result.changed).toBe(false);
    expect(result.newContent).toBe(content);
  });

  test("should preserve other transactions in the file untouched", () => {
    const content = [
      "2025-01-01 * Earlier Transaction",
      "    ; original_description: Something Else",
      "    assets:bank:checking                                              -10.00 USD",
      "    expenses:uncategorized                                            10.00 USD",
      "",
      "2025-01-15 * Internal Transfer",
      "    ; original_payee_name: External Withdrawal ACME BANK",
      "    assets:bank:checking                                              -50.00 USD",
      "    liabilities:credit-card:acme                                        50.00 USD",
      "",
    ].join("\n");

    const result = backfillTransaction(
      content,
      { file: "/x", startLine: 6 },
      "csv:abc123",
      "External Withdrawal ACME BANK",
    );

    const lines = result.newContent.split("\n");
    // Earlier transaction untouched.
    expect(lines[0]).toBe("2025-01-01 * Earlier Transaction");
    expect(lines[1]).toBe("    ; original_description: Something Else");
    // Target transaction backfilled.
    expect(lines[6]).toBe("    ; import_id: csv:abc123");
    expect(lines[7]).toBe("    ; original_description: External Withdrawal ACME BANK");
  });

  test("should use CRLF line endings when the source file uses them", () => {
    const content = [
      "2025-01-15 * Internal Transfer",
      "    ; original_payee_name: X",
      "    assets:bank:checking  -50.00 USD",
      "",
    ].join("\r\n");

    const result = backfillTransaction(
      content,
      { file: "/x", startLine: 1 },
      "csv:abc123",
      "External Withdrawal ACME BANK",
    );

    expect(result.newContent).toContain("\r\n");
    expect(result.newContent).not.toMatch(/[^\r]\n/);
  });
});
