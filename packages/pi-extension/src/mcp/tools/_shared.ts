import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AddTransactionsResult } from "../../ledger/transactions";

/** A tool result carrying a single plain-text block. */
export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** An error tool result: `isError: true` so the model sees the message as
 *  content it can act on, not an opaque protocol failure. */
export function errorText(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

/**
 * Render the "saved" summary the add_* writers share: one entry inline, or a
 * numbered list. `noun` is the singular label ("Transaction", "Price", ...).
 */
export function formatSaved(noun: string, result: AddTransactionsResult): string {
  const entries = result.transactions;
  if (entries.length === 1) {
    return `${noun} saved to ${entries[0].fullFilePath}:\n\n${entries[0].transactionText}`;
  }
  const parts = entries.map((e, i) => `${i + 1}. ${e.fullFilePath}:\n\n${e.transactionText}`);
  return `${entries.length} ${noun.toLowerCase()}s saved:\n\n${parts.join("\n\n")}`;
}
