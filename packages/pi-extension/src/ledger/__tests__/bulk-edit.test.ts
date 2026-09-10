import { describe, expect, test } from "vitest";
import { bulkEditTransactions } from "../bulk-edit";

// The bulk_edit_transactions tool pre-checks `from` with its own schema-named
// message, so these ledger-layer guards are unreachable through the tool. They
// are still part of bulkEditTransactions' public contract — cover them directly.
describe("bulkEditTransactions() validation", () => {
  test("should require from_account when field is account", async () => {
    await expect(
      bulkEditTransactions(["payee:X"], { field: "account", new_value: "expenses:food:groceries" }),
    ).rejects.toThrow('from_account is required when field is "account"');
  });

  test("should require from_payee when field is payee", async () => {
    await expect(bulkEditTransactions(["payee:X"], { field: "payee", new_value: "EDEKA" })).rejects.toThrow(
      'from_payee is required when field is "payee"',
    );
  });

  test("should require tag_name when field is tag_set", async () => {
    await expect(bulkEditTransactions(["payee:X"], { field: "tag_set", new_value: "yes" })).rejects.toThrow(
      'tag_name is required when field is "tag_set"',
    );
  });

  test("should require tag_name when field is tag_remove", async () => {
    await expect(bulkEditTransactions(["payee:X"], { field: "tag_remove", new_value: "" })).rejects.toThrow(
      'tag_name is required when field is "tag_remove"',
    );
  });

  test("should reject a tag_name with leading or trailing whitespace", async () => {
    await expect(
      bulkEditTransactions(["payee:X"], { field: "tag_set", new_value: "yes", tag_name: " review" }),
    ).rejects.toThrow("tag_name must not have leading or trailing whitespace");
  });

  test("should reject a tag_name containing a comma, colon, or whitespace", async () => {
    await expect(
      bulkEditTransactions(["payee:X"], { field: "tag_set", new_value: "yes", tag_name: "a b" }),
    ).rejects.toThrow("tag_name must not contain ',', ':', or whitespace");
  });

  test("should reject a tag_set value containing a comma", async () => {
    await expect(
      bulkEditTransactions(["payee:X"], { field: "tag_set", new_value: "a,b", tag_name: "review" }),
    ).rejects.toThrow("new_value (tag) must not contain ',' or a newline");
  });
});
