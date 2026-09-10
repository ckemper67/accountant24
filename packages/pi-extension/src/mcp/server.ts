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
import { registerAll } from "./registry";

async function main(): Promise<void> {
  // TODO(build-order step 3): run the workspace scaffold (ensureWorkspace +
  // `hledger --version` check) here, before any tool can be called.

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
