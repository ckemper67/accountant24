import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type TraceResult, traceTransactions } from "../ledger";

const Params = Type.Object({
  query: Type.Array(Type.String(), {
    minItems: 1,
    description:
      'hledger query terms selecting the transaction(s) to trace, each an array element (ANDed), e.g. ["payee:EDEKA", "date:2026-06"]. Put a whole term (even with spaces) in one element; do not add quotes.',
  }),
});

const LABEL = "Trace Transaction History";

export const traceTransactionTool: ToolDefinition<typeof Params, TraceResult> = {
  name: "trace_transaction",
  label: LABEL,
  description:
    "Run an hledger query and trace each matching transaction's change history through the workspace git repo: every commit that touched it, its diff, and the transaction's original text. Read-only.",
  promptSnippet: "Trace a transaction's git history to see how it changed and what it originally was",
  promptGuidelines: [
    "trace_transaction answers 'what did this transaction originally look like' or 'how has it changed'. It selects transactions with a standard hledger query (payee:, desc:, acct:, date:), then walks the git history of each one's lines.",
    "The oldest revision in each returned chain is the transaction as first written; the newest is its current committed state. Every revision carries the commit, date, message, diff, and the transaction's text at that point — so an erroneous edit can be recovered from the oldest revision.",
    "hledger query terms are case-insensitive regex substring matches, so payee:DB also matches 'GOLDBACH'. Anchor to be precise (e.g. payee:^EDEKA$) and add terms like date: to narrow to a single transaction.",
    "The trace follows a transaction within one monthly journal file. If a transaction's date was later changed so it moved to a different file, the history stops at that move. Uncommitted edits show as a transaction with no revisions.",
  ],
  parameters: Params,

  async execute(_id, params, signal) {
    const result = await traceTransactions(params.query, signal);

    const lines: string[] = [];
    if (result.found === 0) {
      lines.push(`No transactions matched (query: ${result.query.join(" ")}).`);
    } else {
      lines.push(`Traced ${result.found} transaction(s) (query: ${result.query.join(" ")}).`);
      for (const h of result.histories) {
        const header = firstLine(h.currentText);
        const n = h.revisions.length;
        if (n === 0) {
          lines.push(`- ${header} - no committed history found (uncommitted?).`);
        } else {
          const oldest = h.revisions[n - 1];
          lines.push(
            `- ${header}: ${n} revision(s); first written in ${oldest.commit.slice(0, 8)} (${oldest.date}) "${oldest.message}".`,
          );
        }
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: result,
    };
  },
};

/** The first line of a transaction's text — its date/payee header — for one-line summaries. */
function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}
