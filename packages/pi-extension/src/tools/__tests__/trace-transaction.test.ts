import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TraceResult } from "../../ledger";

vi.mock("../../ledger", () => ({
  traceTransactions: vi.fn(),
}));

const { traceTransactions } = await import("../../ledger");
const { traceTransactionTool } = await import("../trace-transaction.js");

const mockTrace = vi.mocked(traceTransactions);

const run = (query: string[]) =>
  traceTransactionTool.execute("test", { query }, undefined, undefined, undefined as any) as Promise<any>;

function text(result: any): string {
  return result.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
}

beforeEach(() => {
  mockTrace.mockReset();
});

describe("traceTransactionTool", () => {
  test("should pass the query through to traceTransactions", async () => {
    mockTrace.mockResolvedValue({ query: ["payee:EDEKA"], found: 0, histories: [] });
    await run(["payee:EDEKA"]);
    expect(mockTrace).toHaveBeenCalledWith(["payee:EDEKA"], undefined);
  });

  test("should report when no transactions match", async () => {
    mockTrace.mockResolvedValue({ query: ["payee:Nope"], found: 0, histories: [] });
    const out = text(await run(["payee:Nope"]));
    expect(out).toContain("No transactions matched");
    expect(out).toContain("payee:Nope");
  });

  test("should summarize each traced transaction with its original commit", async () => {
    const result: TraceResult = {
      query: ["payee:Whole Foods"],
      found: 1,
      histories: [
        {
          file: "/ws/ledger/2026/03.journal",
          startLine: 1,
          endLine: 3,
          currentText: "2026-03-15 * Whole Foods | Groceries\n    Expenses:Food:Groceries 45.00 USD",
          revisions: [
            {
              commit: "aaaa1111bbbb",
              date: "2026-03-16T10:00:00+00:00",
              message: "Recategorize",
              diff: "diff...",
              text: "new",
            },
            {
              commit: "bbbb2222cccc",
              date: "2026-03-15T09:00:00+00:00",
              message: "Add Whole Foods purchase",
              diff: "diff...",
              text: "orig",
            },
          ],
        },
      ],
    };
    mockTrace.mockResolvedValue(result);

    const out = text(await run(["payee:Whole Foods"]));
    expect(out).toContain("Traced 1 transaction(s)");
    expect(out).toContain("2026-03-15 * Whole Foods | Groceries");
    expect(out).toContain("2 revision(s)");
    // Oldest commit (the original) is surfaced, abbreviated to 8 chars.
    expect(out).toContain("bbbb2222");
    expect(out).toContain("Add Whole Foods purchase");
  });

  test("should flag a transaction with no committed history", async () => {
    mockTrace.mockResolvedValue({
      query: ["payee:Fresh"],
      found: 1,
      histories: [
        {
          file: "/ws/ledger/2026/03.journal",
          startLine: 1,
          endLine: 3,
          currentText: "2026-03-15 * Fresh | X",
          revisions: [],
        },
      ],
    });
    const out = text(await run(["payee:Fresh"]));
    expect(out).toContain("no committed history");
  });

  test("should summarize a transaction with empty current text without crashing", async () => {
    mockTrace.mockResolvedValue({
      query: ["payee:X"],
      found: 1,
      histories: [
        {
          file: "/ws/ledger/2026/03.journal",
          startLine: 1,
          endLine: 1,
          currentText: "",
          revisions: [{ commit: "abcdef12", date: "2026-03-15T00:00:00+00:00", message: "add", diff: "d", text: "t" }],
        },
      ],
    });
    const out = text(await run(["payee:X"]));
    expect(out).toContain("1 revision(s)");
  });

  test("should return the TraceResult as details", async () => {
    const result: TraceResult = { query: ["payee:EDEKA"], found: 0, histories: [] };
    mockTrace.mockResolvedValue(result);
    const out = await run(["payee:EDEKA"]);
    expect(out.details).toBe(result);
  });
});
