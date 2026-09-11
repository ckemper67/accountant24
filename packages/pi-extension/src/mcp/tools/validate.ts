// Deep import, not the ledger/ barrel -- see the note in mcp/tools/query.ts.
import { validateLedger } from "../../ledger/validate";
import type { McpToolSpec } from "../registry";

export const validateSpec: McpToolSpec = {
  name: "validate",
  config: {
    title: "Validate the ledger",
    description:
      "Run `hledger check --strict` over the whole ledger and report any errors. The writer tools " +
      "run this themselves after every change; call it directly to check the current state.",
    annotations: { readOnlyHint: true },
  },
  async handler() {
    try {
      await validateLedger();
      return { content: [{ type: "text", text: "The ledger is valid." }] };
    } catch (err) {
      // validateLedger throws with hledger's diagnostics as the message. Surface
      // them as tool content, not a protocol error, so the model can act on them.
      const text = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text }] };
    }
  },
};
