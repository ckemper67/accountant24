import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BulkEditParams, BulkEditResult } from "../../../ledger/bulk-edit";

// The bulk-edit engine (query discovery, surgical text edits, whole-ledger
// validate-and-revert) is covered exhaustively in ledger/__tests__ and
// tools/__tests__/bulk-edit-transactions.test.ts. This suite tests only the MCP
// wrapper's own job: the `from` guard, the action -> field/from_* mapping,
// dry_run passthrough, result formatting, and error-name translation. The
// engine is stubbed so those are observable in isolation.
const bulkEditTransactions = vi.fn();
vi.mock("../../../ledger/bulk-edit", () => ({
  bulkEditTransactions: (...args: unknown[]) => bulkEditTransactions(...args),
}));

const { bulkEditSpec } = await import("../bulk-edit.js");

function textOf(r: CallToolResult): string {
  return r.content.map((c) => ("text" in c ? (c.text as string) : "")).join("");
}

function result(over: Partial<BulkEditResult>): BulkEditResult {
  return {
    field: "payee",
    query: ["payee:EDEKA"],
    transactions: 3,
    postings: 0,
    diffs: [],
    warnings: [],
    ledgerIsValid: true,
    dryRun: false,
    ...over,
  };
}

beforeEach(() => {
  bulkEditTransactions.mockReset();
  bulkEditTransactions.mockResolvedValue(result({}));
});

describe("bulkEditSpec", () => {
  test("should not be marked read-only", () => {
    expect(bulkEditSpec.config.annotations?.readOnlyHint).toBeFalsy();
  });
});

describe("bulkEditSpec.handler() -- guards", () => {
  test("should require `from` for change_account and never call the engine", async () => {
    const r = await bulkEditSpec.handler({ query: ["payee:X"], action: "change_account", to: "expenses:food" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("from is required for change_account");
    expect(bulkEditTransactions).not.toHaveBeenCalled();
  });

  test("should require `from` for change_payee", async () => {
    const r = await bulkEditSpec.handler({ query: ["payee:X"], action: "change_payee", to: "EDEKA" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("from is required for change_payee");
  });

  test("should not require `from` for set_status", async () => {
    bulkEditTransactions.mockResolvedValue(result({ field: "status", transactions: 2 }));
    const r = await bulkEditSpec.handler({ query: ["payee:X"], action: "set_status", to: "cleared" });
    expect(r.isError).toBeFalsy();
  });
});

describe("bulkEditSpec.handler() -- action mapping", () => {
  test("should map change_account to field=account with from_account set", async () => {
    await bulkEditSpec.handler({
      query: ["acct:expenses:uncat"],
      action: "change_account",
      from: "expenses:uncategorized",
      to: "expenses:food:groceries",
      dry_run: true,
    });
    const [query, spec, dryRun] = bulkEditTransactions.mock.calls[0] as [string[], BulkEditParams, boolean];
    expect(query).toEqual(["acct:expenses:uncat"]);
    expect(spec).toEqual({
      field: "account",
      new_value: "expenses:food:groceries",
      from_account: "expenses:uncategorized",
      from_payee: undefined,
    });
    expect(dryRun).toBe(true);
  });

  test("should map change_payee to field=payee with from_payee set", async () => {
    await bulkEditSpec.handler({
      query: ["payee:edeka"],
      action: "change_payee",
      from: "EDEKA sagt danke",
      to: "EDEKA",
    });
    const [, spec, dryRun] = bulkEditTransactions.mock.calls[0] as [string[], BulkEditParams, boolean];
    expect(spec).toEqual({
      field: "payee",
      new_value: "EDEKA",
      from_account: undefined,
      from_payee: "EDEKA sagt danke",
    });
    expect(dryRun).toBe(false);
  });

  test("should map set_status to field=status with neither from_* set", async () => {
    bulkEditTransactions.mockResolvedValue(result({ field: "status" }));
    await bulkEditSpec.handler({ query: ["date:2026"], action: "set_status", to: "pending" });
    const [, spec] = bulkEditTransactions.mock.calls[0] as [string[], BulkEditParams, boolean];
    expect(spec).toEqual({ field: "status", new_value: "pending", from_account: undefined, from_payee: undefined });
  });
});

describe("bulkEditSpec.handler() -- result formatting", () => {
  test("should describe an applied account move with posting and transaction counts", async () => {
    bulkEditTransactions.mockResolvedValue(
      result({ field: "account", postings: 5, transactions: 4, query: ["acct:x"] }),
    );
    const r = await bulkEditSpec.handler({
      query: ["acct:x"],
      action: "change_account",
      from: "a",
      to: "expenses:food",
    });
    expect(textOf(r)).toBe("Modified: 5 posting(s) across 4 transaction(s) -> expenses:food (query: acct:x).");
  });

  test("should describe an applied payee rename", async () => {
    bulkEditTransactions.mockResolvedValue(result({ field: "payee", transactions: 2, query: ["payee:e"] }));
    const r = await bulkEditSpec.handler({ query: ["payee:e"], action: "change_payee", from: "old", to: "EDEKA" });
    expect(textOf(r)).toBe('Modified: 2 payee(s) renamed to "EDEKA" (query: payee:e).');
  });

  test("should describe an applied status change", async () => {
    bulkEditTransactions.mockResolvedValue(result({ field: "status", transactions: 7, query: ["date:2026"] }));
    const r = await bulkEditSpec.handler({ query: ["date:2026"], action: "set_status", to: "cleared" });
    expect(textOf(r)).toBe("Modified: 7 transaction(s) marked cleared (query: date:2026).");
  });

  test("should report a dry run as 'Would modify' with the validity line and warnings", async () => {
    bulkEditTransactions.mockResolvedValue(
      result({
        field: "payee",
        transactions: 1,
        query: ["payee:e"],
        dryRun: true,
        ledgerIsValid: false,
        validationError: "undeclared account expenses:food",
        warnings: ["1 transaction had a different payee and was skipped"],
      }),
    );
    const r = await bulkEditSpec.handler({
      query: ["payee:e"],
      action: "change_payee",
      from: "old",
      to: "EDEKA",
      dry_run: true,
    });
    const body = textOf(r);
    expect(body).toContain('Would modify: 1 payee(s) renamed to "EDEKA"');
    expect(body).toContain("Ledger would be INVALID:\nundeclared account expenses:food");
    expect(body).toContain("Warning: 1 transaction had a different payee and was skipped");
  });

  test("should say the ledger would remain valid on a clean dry run", async () => {
    bulkEditTransactions.mockResolvedValue(result({ dryRun: true, ledgerIsValid: true }));
    const r = await bulkEditSpec.handler({ query: ["payee:e"], action: "change_payee", from: "old", to: "EDEKA" });
    expect(textOf(r)).toContain("Ledger would remain valid.");
  });
});

describe("bulkEditSpec.handler() -- errors", () => {
  test("should translate ledger-layer field names into the tool's schema names", async () => {
    bulkEditTransactions.mockRejectedValue(new Error('from_account "x" not found; new_value must be declared'));
    const r = await bulkEditSpec.handler({ query: ["acct:x"], action: "change_account", from: "x", to: "y" });
    expect(r.isError).toBe(true);
    const body = textOf(r);
    expect(body).toContain('from "x" not found');
    expect(body).toContain("to must be declared");
    expect(body).not.toContain("from_account");
    expect(body).not.toContain("new_value");
  });

  test("should surface a batch-reverted error as error content", async () => {
    bulkEditTransactions.mockRejectedValue(new Error("Modification reverted -- the ledger would have errors"));
    const r = await bulkEditSpec.handler({ query: ["payee:e"], action: "set_status", to: "cleared" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Modification reverted");
  });

  test("should pass a non-Error rejection through unchanged and stringify it", async () => {
    bulkEditTransactions.mockRejectedValue("engine crashed");
    const r = await bulkEditSpec.handler({ query: ["payee:e"], action: "set_status", to: "cleared" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("engine crashed");
  });
});

describe("bulkEditSpec.handler() -- unknown action", () => {
  test("should forward an unmapped action verbatim so the engine names it", async () => {
    // Only reachable when the schema is bypassed; the `?? action` fallthrough
    // lets the ledger layer raise its own "Unsupported field" error.
    bulkEditTransactions.mockResolvedValue(result({ field: "status" }));
    await bulkEditSpec.handler({ query: ["date:2026"], action: "frobnicate", from: "x", to: "y" });
    const [, spec] = bulkEditTransactions.mock.calls[0] as [string[], BulkEditParams, boolean];
    expect(spec.field).toBe("frobnicate");
    expect(spec).toMatchObject({ new_value: "y", from_account: undefined, from_payee: undefined });
  });
});
