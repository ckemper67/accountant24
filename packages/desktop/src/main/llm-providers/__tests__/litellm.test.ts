import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// litellm.ts wraps three I/O boundaries — Electron IPC, node:fs (models.json),
// and fetch (the LiteLLM proxy). All are faked; the mapping/validation/merge
// logic runs for real, driven through the registered IPC handlers.
type Handler = (event: unknown, payload?: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  modelRuntime: {
    logout: vi.fn(async () => {}),
  },
  trackProviderConnected: vi.fn(),
  fs: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
}));
vi.mock("../../env", () => ({ workspaceDir: () => "/ws" }));
vi.mock("../../analytics", () => ({ trackProviderConnected: h.trackProviderConnected }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: async () => h.modelRuntime },
}));
vi.mock("node:fs", () => ({
  existsSync: h.fs.existsSync,
  readFileSync: h.fs.readFileSync,
  writeFileSync: h.fs.writeFileSync,
}));

/** Import litellm.ts fresh and register its handlers. */
async function setup() {
  const { registerLiteLLMIpc } = await import("../litellm");
  registerLiteLLMIpc();
}

const invoke = (channel: string, payload?: unknown) => {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(null, payload);
};

/** Minimal fetch Response stub. */
const jsonResponse = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

/** The JSON object written by the nth writeFileSync call. */
const writtenJson = (n = 0): Record<string, unknown> => JSON.parse(h.fs.writeFileSync.mock.calls[n][1] as string);

beforeEach(() => {
  h.handlers.clear();
  // clearMocks only clears call history — restore the default implementations
  // so per-test mockReturnValue overrides can't leak into the next test.
  h.fs.existsSync.mockImplementation(() => false);
  h.fs.readFileSync.mockImplementation(() => "");
  h.modelRuntime.logout.mockImplementation(async () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network unavailable");
    }),
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapLiteLLMModel", () => {
  it("should map full metadata: context, max tokens, vision, reasoning, and per-1M cost", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    expect(
      mapLiteLLMModel({
        model_name: "qwen3.6-35b-a3b",
        model_info: {
          max_input_tokens: 128000,
          max_output_tokens: 16384,
          supports_vision: true,
          supports_reasoning: false,
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.00001,
          cache_read_input_token_cost: 0.00000125,
        },
      }),
    ).toEqual({
      id: "qwen3.6-35b-a3b",
      name: "qwen3.6-35b-a3b",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    });
  });

  it("should default input to text-only and omit unknown fields", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    expect(mapLiteLLMModel({ model_name: "m", model_info: {} })).toEqual({
      id: "m",
      name: "m",
      input: ["text"],
      reasoning: false,
    });
  });

  it("should fall back to context_window and max_tokens aliases", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    const m = mapLiteLLMModel({ model_name: "m", model_info: { context_window: 8192, max_tokens: 2048 } });
    expect(m?.contextWindow).toBe(8192);
    expect(m?.maxTokens).toBe(2048);
  });

  it("should mark reasoning models and keep image out unless vision is supported", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    const m = mapLiteLLMModel({ model_name: "gemma-4-26b-a4b-it", model_info: { supports_reasoning: true } });
    expect(m?.reasoning).toBe(true);
    expect(m?.input).toEqual(["text"]);
  });

  it("should return null when the entry has no model name", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    expect(mapLiteLLMModel({})).toBeNull();
  });

  it("should omit cost when only the input price is known (never imply free output)", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    const m = mapLiteLLMModel({ model_name: "m", model_info: { input_cost_per_token: 0.0000025 } });
    expect(m).not.toHaveProperty("cost");
  });

  it("should omit cost when only the output price is known (never imply free input)", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    const m = mapLiteLLMModel({ model_name: "m", model_info: { output_cost_per_token: 0.00001 } });
    expect(m).not.toHaveProperty("cost");
  });

  it("should default cache prices to 0 when only input and output prices are given", async () => {
    const { mapLiteLLMModel } = await import("../litellm");
    const m = mapLiteLLMModel({
      model_name: "m",
      model_info: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
    });
    expect(m?.cost).toEqual({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("auth_detect_litellm", () => {
  const infoEntry = {
    model_name: "qwen3.6-35b-a3b",
    model_info: { max_input_tokens: 120000, max_output_tokens: 4096, supports_vision: true },
  };

  it("should map models from /v1/model/info without sending an Authorization header", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { headers?: Record<string, string> }) => {
      if (String(url).endsWith("/v1/model/info")) return jsonResponse({ data: [infoEntry] });
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    await setup();

    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: true,
      models: [
        {
          id: "qwen3.6-35b-a3b",
          name: "qwen3.6-35b-a3b",
          input: ["text", "image"],
          reasoning: false,
          contextWindow: 120000,
          maxTokens: 4096,
        },
      ],
    });
    // Open proxies only: no key is resolved, so no auth header is attached.
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("should fall back to /v1/models when /model/info answers but no entry has a usable model name", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/v1/model/info"))
        return jsonResponse({ data: [{ model_info: { context_window: 8 } }] });
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "usable" }] });
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    await setup();

    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: true,
      models: [{ id: "usable", name: "usable", input: ["text"], reasoning: false }],
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://localhost:4000/v1/model/info",
      "http://localhost:4000/v1/models",
    ]);
  });

  it("should report not running for a non-http(s) base URL without fetching", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await setup();
    await expect(invoke("auth_detect_litellm", { baseUrl: "ftp://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: false,
      models: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should fall back to /v1/models (ids only) when /model/info is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/model/info")) return jsonResponse({}, false);
        if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "gemma-4-26b-a4b-it" }] });
        return jsonResponse({}, false);
      }),
    );
    await setup();

    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: true,
      models: [{ id: "gemma-4-26b-a4b-it", name: "gemma-4-26b-a4b-it", input: ["text"], reasoning: false }],
    });
  });

  it("should report not running when the proxy is unreachable", async () => {
    await setup();
    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: false,
      models: [],
    });
  });

  it("should report not running for a blank base URL without fetching", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await setup();
    await expect(invoke("auth_detect_litellm", { baseUrl: "  " })).resolves.toEqual({
      type: "litellm",
      running: false,
      models: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should fall back to /v1/models without warning when /model/info answers with no entries at all", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/v1/model/info")) return jsonResponse({});
      if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{ id: "usable" }] });
      return jsonResponse({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setup();

    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: true,
      models: [{ id: "usable", name: "usable", input: ["text"], reasoning: false }],
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should report not running when /v1/models answers with an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/model/info")) return jsonResponse({}, false);
        if (String(url).endsWith("/v1/models")) return jsonResponse({}, false);
        return jsonResponse({}, false);
      }),
    );
    await setup();
    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: false,
      models: [],
    });
  });

  it("should skip /v1/models entries with no id and dedupe repeated ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/v1/model/info")) return jsonResponse({}, false);
        if (String(url).endsWith("/v1/models")) return jsonResponse({ data: [{}, { id: "m" }, { id: "m" }] });
        return jsonResponse({}, false);
      }),
    );
    await setup();
    await expect(invoke("auth_detect_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "litellm",
      running: true,
      models: [{ id: "m", name: "m", input: ["text"], reasoning: false }],
    });
  });
});

describe("auth_add_all_litellm", () => {
  const stubInfo = (entries: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/v1/model/info") ? jsonResponse({ data: entries }) : jsonResponse({}, false),
      ),
    );

  it("should error on a blank base URL", async () => {
    await setup();
    await expect(invoke("auth_add_all_litellm", { baseUrl: "" })).resolves.toEqual({
      type: "error",
      message: "A valid http(s) base URL is required.",
    });
  });

  it("should error on a non-http(s) base URL", async () => {
    await setup();
    await expect(invoke("auth_add_all_litellm", { baseUrl: "ftp://localhost:4000" })).resolves.toEqual({
      type: "error",
      message: "A valid http(s) base URL is required.",
    });
  });

  it("should error when the proxy is unreachable", async () => {
    await setup();
    await expect(invoke("auth_add_all_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "error",
      message: "Could not reach a LiteLLM proxy at that URL.",
    });
  });

  it("should write the provider with a normalized baseUrl, placeholder key, and mapped models", async () => {
    stubInfo([{ model_name: "qwen3.6-35b-a3b", model_info: { max_input_tokens: 128000 } }]);
    await setup();

    await expect(invoke("auth_add_all_litellm", { baseUrl: "http://localhost:4000/" })).resolves.toEqual({
      type: "done",
      provider: "litellm",
      count: 1,
    });

    expect(writtenJson()).toEqual({
      providers: {
        litellm: {
          name: "LiteLLM",
          baseUrl: "http://localhost:4000/v1",
          api: "openai-completions",
          apiKey: "litellm",
          models: [
            {
              id: "qwen3.6-35b-a3b",
              name: "qwen3.6-35b-a3b",
              input: ["text"],
              reasoning: false,
              contextWindow: 128000,
            },
          ],
        },
      },
    });
    expect(h.trackProviderConnected).toHaveBeenCalledWith("litellm", "litellm");
  });

  it("should write a placeholder apiKey so an open proxy still counts as configured", async () => {
    stubInfo([{ model_name: "m", model_info: {} }]);
    await setup();
    await invoke("auth_add_all_litellm", { baseUrl: "http://localhost:4000" });
    const config = writtenJson() as { providers: { litellm: Record<string, unknown> } };
    // pi marks a provider usable only when it has a resolvable credential, so a
    // keyless proxy needs a non-empty placeholder (mirrors Ollama's dummy key).
    expect(config.providers.litellm.apiKey).toBe("litellm");
    expect(h.trackProviderConnected).toHaveBeenCalledWith("litellm", "litellm");
  });

  it("should preserve other providers and a hand-authored apiKey while replacing the model set on reconnect", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue(
      JSON.stringify({
        providers: {
          keep: { name: "K" },
          litellm: {
            baseUrl: "http://old/v1",
            apiKey: "$LITELLM_API_KEY",
            models: [{ id: "stale", name: "stale", input: ["text"], reasoning: false }],
          },
        },
      }),
    );
    stubInfo([{ model_name: "fresh", model_info: {} }]);
    await setup();
    await invoke("auth_add_all_litellm", { baseUrl: "http://localhost:4000" });

    const config = writtenJson() as {
      providers: Record<string, { models?: { id: string }[]; baseUrl?: string; apiKey?: string }>;
    };
    expect(config.providers.keep).toEqual({ name: "K" });
    expect(config.providers.litellm.baseUrl).toBe("http://localhost:4000/v1");
    // A key the user set by hand is seeded only when absent, so it survives reconnect.
    expect(config.providers.litellm.apiKey).toBe("$LITELLM_API_KEY");
    expect(config.providers.litellm.models?.map((m) => m.id)).toEqual(["fresh"]);
    expect(h.trackProviderConnected).toHaveBeenCalledWith("litellm", "litellm");
  });

  it("should refuse to overwrite models.json when it is not valid JSON", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue("{oops");
    stubInfo([{ model_name: "m", model_info: {} }]);
    await setup();
    await expect(invoke("auth_add_all_litellm", { baseUrl: "http://localhost:4000" })).resolves.toEqual({
      type: "error",
      message: "models.json is not valid JSON; refusing to overwrite",
    });
    expect(h.fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("auth_remove_litellm", () => {
  it("should succeed without touching anything when models.json does not exist", async () => {
    await setup();
    expect(await invoke("auth_remove_litellm")).toEqual({ type: "done", provider: "litellm" });
    expect(h.fs.writeFileSync).not.toHaveBeenCalled();
    expect(h.modelRuntime.logout).not.toHaveBeenCalled();
  });

  it("should refuse when models.json is not valid JSON", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue("{oops");
    await setup();
    expect(await invoke("auth_remove_litellm")).toEqual({
      type: "error",
      message: "models.json is not valid JSON; refusing to overwrite",
    });
    expect(h.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("should remove only the litellm provider and keep others", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue(
      JSON.stringify({ providers: { litellm: { name: "LiteLLM" }, keep: { name: "K" } } }),
    );
    await setup();

    expect(await invoke("auth_remove_litellm")).toEqual({ type: "done", provider: "litellm" });
    expect(writtenJson()).toEqual({ providers: { keep: { name: "K" } } });
    expect(h.modelRuntime.logout).toHaveBeenCalledWith("litellm");
  });

  it("should not rewrite models.json but still drop any stored credential when it has no litellm provider", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue(JSON.stringify({ providers: { keep: {} } }));
    await setup();
    await invoke("auth_remove_litellm");
    expect(h.fs.writeFileSync).not.toHaveBeenCalled();
    // The logout runs unconditionally (mirrors Ollama): a credential can exist in
    // auth.json even when models.json carries no litellm provider.
    expect(h.modelRuntime.logout).toHaveBeenCalledWith("litellm");
  });

  it("should still report success when dropping the stored credential fails", async () => {
    h.fs.existsSync.mockReturnValue(true);
    h.fs.readFileSync.mockReturnValue(JSON.stringify({ providers: { litellm: { name: "LiteLLM" } } }));
    h.modelRuntime.logout.mockRejectedValue(new Error("no such credential"));
    await setup();

    expect(await invoke("auth_remove_litellm")).toEqual({ type: "done", provider: "litellm" });
  });
});
