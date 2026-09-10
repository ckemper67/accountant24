import { z } from "zod";
// Deep import, not the ledger/ barrel: the barrel re-exports the writer modules
// too, and pulling those into the MCP bundle defeats esbuild's tree-shaking of
// the pi library (it then drags in the whole agent runtime + cross-spawn).
import { queryLedger } from "../../ledger/query";
import type { McpToolSpec } from "../registry";

const REPORT_TYPES =
  "bal (balances/spending), reg (posting list), aregister (single account with running balance), " +
  "is (income statement), bs (balance sheet), print (raw transactions), stats (overview)";

// Mirrors src/tools/query.ts (the pi wrapper), minus `file`: the MCP surface is
// driven by a third-party agent, so an LLM-supplied journal path is an attack
// vector, not a convenience. Every monthly journal is already reachable through
// main.journal's include chain. `valuation`/`value_commodity` are also omitted --
// buildQueryArgs on this branch does not implement them.
const inputSchema = {
  report: z.enum(["bal", "reg", "aregister", "is", "bs", "print", "stats"]).describe(`Report type: ${REPORT_TYPES}`),
  account_pattern: z.string().optional().describe("Account name regex, e.g. 'Expenses:Food'"),
  description_pattern: z.string().optional().describe("Filter by description regex"),
  payee_pattern: z.string().optional().describe("Filter by payee regex (text before | in description)"),
  amount_filter: z.string().optional().describe("Amount filter, e.g. '>100', '<50', '>=1000'"),
  tag: z.string().optional().describe("Filter by tag, e.g. 'groceries' or 'source=manual'"),
  status: z.enum(["cleared", "pending", "unmarked"]).optional().describe("Transaction status filter"),
  begin_date: z.string().optional().describe("Start date inclusive, YYYY-MM-DD"),
  end_date: z.string().optional().describe("End date exclusive, YYYY-MM-DD"),
  period: z
    .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
    .optional()
    .describe("Period grouping for multi-period reports"),
  depth: z.number().optional().describe("Account depth limit (2 = Assets:Bank, not Assets:Bank:Checking)"),
  invert: z.boolean().optional().describe("Flip signs -- show expenses as positive (--invert)"),
  output_format: z
    .enum(["txt", "csv", "json", "tsv"])
    .optional()
    .describe("Output format. csv/json/tsv for machine-readable data"),
};

export const querySpec: McpToolSpec<typeof inputSchema> = {
  name: "query",
  config: {
    title: "Query the ledger",
    description:
      "Run an hledger report against the journal (balance, register, income statement, balance " +
      "sheet, and more) with structured filters. " +
      `Report types: ${REPORT_TYPES}. ` +
      "A large result is spilled to a scratch file: you get a head preview plus the file path -- " +
      "read that file rather than re-running the query.",
    inputSchema,
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    try {
      const result = await queryLedger(args);
      return { content: [{ type: "text", text: result.output }] };
    } catch (err) {
      // hledger's own diagnostics (bad regex, malformed date, unknown account)
      // are the model's feedback loop -- surface them as content, not a
      // protocol error the model cannot read.
      const text = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text }] };
    }
  },
};
