import { z } from "zod";
// Deep imports, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import { listAccounts } from "../../ledger/accounts";
import { listPayees } from "../../ledger/payees";
import { listTags } from "../../ledger/tags";
import type { McpToolSpec } from "../registry";

const inputSchema = {
  kind: z
    .enum(["accounts", "payees", "tags"])
    .describe("Which list to return: declared accounts, known payees, or tags in use."),
};

export const lookupSpec: McpToolSpec<typeof inputSchema> = {
  name: "lookup",
  config: {
    title: "List accounts, payees, or tags",
    description:
      "Return the ledger's declared accounts, known payees, or tags currently in use, as hledger " +
      "reports them. Call it at the start of a session, and again before creating a new account, " +
      "payee, or commodity, to check what already exists and match existing names.",
    inputSchema,
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const kind = args.kind as "accounts" | "payees" | "tags";
    const list = kind === "accounts" ? await listAccounts() : kind === "payees" ? await listPayees() : await listTags();
    const text = list.length > 0 ? list.join("\n") : `(no ${kind})`;
    return { content: [{ type: "text", text }] };
  },
};
