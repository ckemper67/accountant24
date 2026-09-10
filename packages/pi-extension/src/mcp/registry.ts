import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { READ_ONLY_SPECS, WRITER_SPECS } from "./tools";

/**
 * One MCP tool the accountant server exposes. `config` is forwarded verbatim to
 * `McpServer.registerTool`, so `description` (which carries the guidance that
 * used to live in pi `promptGuidelines`) and `annotations.readOnlyHint` reach
 * the model's native tool list. Read tools set `readOnlyHint: true` so a
 * `trust: untrusted` server only gates the writers.
 */
export interface McpToolSpec<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  config: {
    title?: string;
    description: string;
    inputSchema?: Shape;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      title?: string;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * The tools, in registration order: read-only (`query`, `lookup`, `validate`)
 * first, then the writers (`add_transactions`, `add_balance_assertions`,
 * `add_prices`, `bulk_edit`).
 */
export const TOOL_SPECS: McpToolSpec[] = [...READ_ONLY_SPECS, ...WRITER_SPECS];

/** Register every spec on the server, in order. */
export function registerAll(server: McpServer, specs: readonly McpToolSpec[] = TOOL_SPECS): void {
  for (const spec of specs) {
    // The SDK's registerTool generics are keyed to a concrete Zod shape; our
    // registry holds a heterogeneous list, so the config is widened here.
    server.registerTool(spec.name, spec.config as never, spec.handler as never);
  }
}
