// LiteLLM proxy — an OpenAI-compatible endpoint the user runs to front their own
// models -- most often locally served ones (e.g. Qwen), though it can also front cloud
// provider credentials. Unlike Ollama, its base URL is user-supplied and it
// exposes rich per-model metadata via /v1/model/info — which we map into
// models.json so pi uses each model's real context window / max tokens instead of
// generic defaults. This first cut supports open (unauthenticated) proxies only:
// like Ollama's dummy "ollama" key, the provider gets a placeholder apiKey so pi
// still marks it configured. Authenticated proxies (a Keychain/env "key source")
// are a follow-up.
//
// LiteLLMModel (the models.json model shape) is defined once in the renderer's RPC
// contract and imported here so the two can't drift.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ipcMain } from "electron";
import type { LiteLLMModel } from "../../renderer/rpc/types";
import { trackProviderConnected } from "../analytics";
import { createProviderRuntime, paths } from "./registry";

/** LiteLLM /v1/model/info entry shape (only the fields we consume). */
interface LiteLLMInfoEntry {
  model_name?: string;
  model_info?: {
    max_tokens?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    context_window?: number;
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
  };
}

/** Map a LiteLLM /v1/model/info entry to a models.json model definition. Only
 *  fields we can determine are set, so pi falls back to its own defaults for the
 *  rest (contextWindow 128000 / maxTokens 16384). */
export function mapLiteLLMModel(entry: LiteLLMInfoEntry): LiteLLMModel | null {
  const id = entry.model_name?.trim();
  if (!id) return null;
  const info = entry.model_info ?? {};
  const model: LiteLLMModel = {
    id,
    name: id,
    input: info.supports_vision ? ["text", "image"] : ["text"],
    reasoning: Boolean(info.supports_reasoning),
  };
  const contextWindow = info.max_input_tokens ?? info.context_window;
  if (typeof contextWindow === "number") model.contextWindow = contextWindow;
  const maxTokens = info.max_output_tokens ?? info.max_tokens;
  if (typeof maxTokens === "number") model.maxTokens = maxTokens;
  // Only report cost when both the input and output prices are known — deriving
  // one side from a missing value (defaulting it to 0) would make the model look
  // partly free and quietly corrupt cost tracking. Cache prices legitimately
  // default to 0 (many models don't price caching separately).
  const inCost = info.input_cost_per_token;
  const outCost = info.output_cost_per_token;
  if (typeof inCost === "number" && typeof outCost === "number") {
    model.cost = {
      input: inCost * 1_000_000,
      output: outCost * 1_000_000,
      cacheRead: (info.cache_read_input_token_cost ?? 0) * 1_000_000,
      cacheWrite: (info.cache_creation_input_token_cost ?? 0) * 1_000_000,
    };
  }
  return model;
}

/** Trim, strip trailing slashes, and require an http(s) scheme. Returns "" for a
 *  blank or non-http(s) URL so callers reject it instead of probing (and shipping
 *  a request to) an unexpected scheme/host. */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

/** Query a LiteLLM proxy for its models. Prefers /v1/model/info (rich metadata);
 *  falls back to /v1/models (ids only, pi defaults) when it is unavailable. */
async function detectLiteLLM(baseUrl: string) {
  const base = normalizeBaseUrl(baseUrl);
  const empty = { type: "litellm" as const, running: false, models: [] as LiteLLMModel[] };
  if (!base) return empty;

  // Rich metadata endpoint first.
  try {
    const res = await fetch(`${base}/v1/model/info`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const entries = ((await res.json()) as { data?: LiteLLMInfoEntry[] }).data ?? [];
      const models = dedupById(entries.map(mapLiteLLMModel).filter((m): m is LiteLLMModel => m !== null));
      if (models.length > 0) return { type: "litellm" as const, running: true, models };
      // Endpoint answered but nothing was usable (e.g. a different LiteLLM schema
      // with no model_name). Leave a breadcrumb before the silent ids-only retry.
      if (entries.length > 0) {
        console.warn(`LiteLLM /v1/model/info returned ${entries.length} entries but none had a usable model name`);
      }
    }
  } catch {
    // fall through to the ids-only endpoint
  }

  // Fallback: OpenAI-standard model list (ids only).
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = dedupById(
      (data.data ?? [])
        .map((m) => (m.id ? mapLiteLLMModel({ model_name: m.id }) : null))
        .filter((m): m is LiteLLMModel => m !== null),
    );
    return { type: "litellm" as const, running: models.length > 0, models };
  } catch {
    return empty;
  }
}

function dedupById(models: LiteLLMModel[]): LiteLLMModel[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/** Write the LiteLLM provider into models.json. Replaces the model set with the
 *  freshly-discovered one (reconnecting refreshes it), preserving other providers
 *  and any hand-authored provider fields (name/api/apiKey are seeded only once, so
 *  a user who edits models.json directly keeps their changes on reconnect). */
function writeLiteLLMModels(baseUrl: string, models: LiteLLMModel[]) {
  if (models.length === 0) return { type: "error", message: "no models to add" };
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return { type: "error", message: "missing base URL" };
  const { modelsPath } = paths();

  type ProviderEntry = { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: LiteLLMModel[] };
  type ModelsJson = { providers?: Record<string, ProviderEntry> };

  let config: ModelsJson = {};
  if (existsSync(modelsPath)) {
    try {
      config = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
    } catch {
      return { type: "error", message: "models.json is not valid JSON; refusing to overwrite" };
    }
  }
  config.providers ??= {};
  const litellm: ProviderEntry = config.providers.litellm ?? {};
  litellm.name ??= "LiteLLM";
  litellm.baseUrl = `${base}/v1`;
  litellm.api ??= "openai-completions";
  // pi treats a provider as "configured" (so its models become usable) only when
  // it has a resolvable credential. An open proxy has no key, so — like Ollama's
  // dummy "ollama" key — seed a placeholder the proxy ignores; otherwise the
  // provider registers but stays unusable and the UI can't tell it connected. Only
  // seeded when absent, so a hand-authored key (the follow-up's seam) survives.
  litellm.apiKey ??= "litellm";
  litellm.models = dedupById(models);
  config.providers.litellm = litellm;

  writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  trackProviderConnected("litellm", "litellm");
  return { type: "done", provider: "litellm", count: litellm.models.length };
}

/** Connect a LiteLLM proxy by discovering and registering all its models. */
async function addAllLiteLLM(baseUrl: string) {
  if (!normalizeBaseUrl(baseUrl)) return { type: "error", message: "A valid http(s) base URL is required." };
  const info = await detectLiteLLM(baseUrl);
  if (!info.running) {
    return { type: "error", message: "Could not reach a LiteLLM proxy at that URL." };
  }
  if (info.models.length === 0) return { type: "error", message: "The LiteLLM proxy returned no models." };
  return writeLiteLLMModels(baseUrl, info.models);
}

/** Remove the LiteLLM provider the app added to models.json. */
async function removeLiteLLM() {
  const { modelsPath } = paths();
  if (!existsSync(modelsPath)) return { type: "done", provider: "litellm" };

  type ModelsJson = { providers?: Record<string, unknown> };
  let config: ModelsJson;
  try {
    config = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
  } catch {
    return { type: "error", message: "models.json is not valid JSON; refusing to overwrite" };
  }
  if (config.providers?.litellm) {
    delete config.providers.litellm;
    writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  // Drop any stored LiteLLM credential too (normally none — it lives in
  // models.json), best-effort: the provider is already gone either way.
  const runtime = await createProviderRuntime();
  await runtime.logout("litellm").catch(() => undefined);
  return { type: "done", provider: "litellm" };
}

/** Register the LiteLLM IPC handlers. */
export function registerLiteLLMIpc(): void {
  ipcMain.handle("auth_detect_litellm", (_e, { baseUrl }: { baseUrl: string }) => detectLiteLLM(baseUrl));
  ipcMain.handle("auth_add_all_litellm", (_e, { baseUrl }: { baseUrl: string }) => addAllLiteLLM(baseUrl));
  ipcMain.handle("auth_remove_litellm", () => removeLiteLLM());
}
