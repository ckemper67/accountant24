import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { type McpToolSpec, registerAll, TOOL_SPECS } from "../registry";

/** Minimal stand-in for the parts of McpServer that registerAll touches. */
function fakeServer() {
  return { registerTool: vi.fn() } as unknown as McpServer & { registerTool: ReturnType<typeof vi.fn> };
}

function spec(name: string, overrides: Partial<McpToolSpec["config"]> = {}): McpToolSpec {
  return {
    name,
    config: { description: `desc for ${name}`, ...overrides },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("registerAll()", () => {
  it("should register nothing when given an empty spec list", () => {
    const server = fakeServer();
    registerAll(server, []);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it("should register each spec once, in order, with its name/config/handler", () => {
    const server = fakeServer();
    const specs = [spec("query", { annotations: { readOnlyHint: true } }), spec("add_transactions")];

    registerAll(server, specs);

    expect(server.registerTool).toHaveBeenCalledTimes(2);
    expect(server.registerTool.mock.calls[0]).toEqual([specs[0].name, specs[0].config, specs[0].handler]);
    expect(server.registerTool.mock.calls[1]).toEqual([specs[1].name, specs[1].config, specs[1].handler]);
  });

  it("should default to the module's TOOL_SPECS when no list is passed", () => {
    const server = fakeServer();
    registerAll(server);
    expect(server.registerTool).toHaveBeenCalledTimes(TOOL_SPECS.length);
  });
});

describe("TOOL_SPECS", () => {
  it("should be an array (tools are added by later build-order steps)", () => {
    expect(Array.isArray(TOOL_SPECS)).toBe(true);
  });
});
