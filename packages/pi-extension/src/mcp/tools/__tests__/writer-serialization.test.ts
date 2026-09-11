import { describe, expect, test, vi } from "vitest";

// Every writer tool runs its whole cycle inside the one shared `writerMutex`, so
// two of them can never interleave on the journal files. Both engines are
// stubbed with a gate so the ordering is observable: if the second tool's engine
// call starts before the first resolves, the mutex is not doing its job.
const events: string[] = [];
let releaseFirst!: () => void;

// Stub the workspace git commit so no real repo is touched.
vi.mock("../../../workspace/git", () => ({ commitAll: vi.fn().mockResolvedValue(undefined), initRepo: vi.fn() }));

vi.mock("../../../ledger/transactions", () => ({
  addTransactions: vi.fn(async () => {
    events.push("tx:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("tx:end");
    return {
      transactions: [{ transactionText: "t", fullFilePath: "/x/2026/03.journal" }],
      ledgerIsValid: true,
      diffs: [],
    };
  }),
}));

vi.mock("../../../ledger/bulk-edit", () => ({
  bulkEditTransactions: vi.fn(async () => {
    events.push("bulk:start");
    events.push("bulk:end");
    return {
      field: "status",
      query: ["date:2026"],
      transactions: 1,
      postings: 0,
      diffs: [],
      warnings: [],
      ledgerIsValid: true,
      dryRun: false,
    };
  }),
}));

const { addTransactionsSpec } = await import("../add-transactions.js");
const { bulkEditSpec } = await import("../bulk-edit.js");

describe("writer serialization", () => {
  test("should hold the shared lock so a second writer waits for the first to finish", async () => {
    const first = addTransactionsSpec.handler({
      transactions: [
        {
          date: "2026-03-15",
          payee: "P",
          postings: [
            { account: "A", amount: -1, currency: "USD" },
            { account: "B", amount: 1, currency: "USD" },
          ],
        },
      ],
    });
    const second = bulkEditSpec.handler({ query: ["date:2026"], action: "set_status", to: "cleared" });

    // Let the first tool enter its engine and block there.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["tx:start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["tx:start", "tx:end", "bulk:start", "bulk:end"]);
  });
});
