// Entry point for the standalone Accountant MCP server.
//
// Nous Hermes launches this as a local stdio subprocess -- an `mcp_servers`
// entry in ~/.hermes/config.yaml. It reuses packages/pi-extension/src/ledger
// and memory/ in place (the same modules the pi extension wraps as pi tools)
// and exposes them over the Model Context Protocol so Hermes' own model drives
// them. No Electron, no pi runtime.
//
// `scripts/bundle-extension.ts` bundles this to
// packages/pi-extension/dist/accountant24-mcp.js.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HledgerNotFoundError, runHledger } from "../ledger/hledger";
import { registerAll } from "./registry";

// hledger's `reg`/`aregister` reports size their columns to
// `process.stdout.columns`. Over a stdio JSON-RPC pipe that is undefined, so
// the report falls back to a narrow 80 cols and truncates account names. This
// consumer is a program reading text, not a terminal -- give it a wide value.
function widenReportOutput(): void {
  const out = process.stdout as NodeJS.WriteStream & { columns?: number };
  if (!out.columns) {
    try {
      out.columns = 240;
    } catch {
      // A real tty exposes `columns` as a read-only getter; nothing to do.
    }
  }
}

async function main(): Promise<void> {
  // Fail fast with a clear message if hledger is missing -- otherwise the first
  // query surfaces an opaque "command not found" mid-conversation.
  // TODO(build-order step 3): also run the workspace scaffold (ensureWorkspace)
  // and a pinned-minimum hledger version check here.
  try {
    await runHledger(["--version"]);
  } catch (err) {
    if (err instanceof HledgerNotFoundError) {
      process.stderr.write(`[accountant24-mcp] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  widenReportOutput();

  const server = new McpServer({ name: "accountant24", version: "0.1.0" });

  registerAll(server);

  // stdout is the JSON-RPC channel; everything else must go to stderr.
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[accountant24-mcp] fatal: ${detail}\n`);
  process.exit(1);
});
