import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ACCOUNTANT24_WORKSPACE } from "../../config";
import type { AddTransactionsResult } from "../../ledger/transactions";
import { commitAll } from "../../workspace/git";

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
 * Commit the workspace after a successful mutation, so a later bad write is
 * recoverable with `git checkout`. Best-effort: `commitAll` logs and swallows a
 * missing git or an empty commit -- never let bookkeeping fail the tool call.
 * Only the success paths call this; a write that left the ledger invalid is
 * deliberately left uncommitted.
 */
export function commitWorkspace(message: string): Promise<void> {
  return commitAll(ACCOUNTANT24_WORKSPACE, message);
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
