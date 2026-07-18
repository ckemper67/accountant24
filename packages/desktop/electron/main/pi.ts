// Auth, models, and sessions — run IN-PROCESS via the pi SDK (no helper binary).
//
// This is the Node port of packages/pi-helper-cli/src/auth.ts: stock pi has no
// headless auth command, its RPC mode can't list/delete sessions, and credentials
// must live in auth.json before the agent starts. We wrap AuthStorage +
// ModelRegistry + SessionManager directly in the Electron main process and expose
// them over IPC. They read/write auth.json + models.json in the workspace — the
// same files the agent child reads (PI_CODING_AGENT_DIR points there).

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { type BrowserWindow, ipcMain, shell } from "electron";
import type { LiteLLMModel } from "../../src/rpc/types";
import { killSessionAgent } from "./agent";
import { trackProviderConnected } from "./analytics";
import { sessionsDir, workspaceDir } from "./env";
import { resolveSessionPath } from "./sessionPaths";

type LoginCallbacks = Parameters<AuthStorage["login"]>[1];

const OLLAMA_BASE_URL = "http://localhost:11434";

function paths() {
  const home = workspaceDir();
  return { home, authPath: join(home, "auth.json"), modelsPath: join(home, "models.json") };
}

function createRegistry() {
  const { authPath, modelsPath } = paths();
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  return { authStorage, modelRegistry };
}

function uniqueProviders(modelRegistry: ModelRegistry): string[] {
  const seen = new Set<string>();
  for (const model of modelRegistry.getAll()) seen.add(model.provider);
  return [...seen].sort();
}

// ---- one-shot queries (return the record the renderer expects) -------------

/** A human label for how a configured provider is authenticated. The stored
 *  credential type (oauth vs api_key) is authoritative; otherwise fall back to
 *  where the key was resolved from (env / models.json / session). */
function connectionLabel(authStorage: AuthStorage, provider: string, source: string | undefined): string | undefined {
  switch (authStorage.get(provider)?.type) {
    case "oauth":
      return "Subscription";
    case "api_key":
      return "API Key";
  }
  switch (source) {
    case "environment":
      return "Environment variable";
    case "models_json_key":
    case "models_json_command":
      return "Custom (models.json)";
    case "runtime":
      return "Session key";
    default:
      return undefined;
  }
}

function authStatus() {
  const { authStorage, modelRegistry } = createRegistry();
  const oauthIds = new Set(authStorage.getOAuthProviders().map((p) => p.id));
  const providers = uniqueProviders(modelRegistry).map((provider) => {
    const status = modelRegistry.getProviderAuthStatus(provider);
    const rawName = modelRegistry.getProviderDisplayName(provider);
    // Ollama models we register carry no provider display name, so pi falls back
    // to the bare id "ollama"; show it properly capitalized.
    const displayName = provider === "ollama" && rawName.toLowerCase() === "ollama" ? "Ollama" : rawName;
    return {
      provider,
      displayName,
      configured: status.configured,
      source: status.source,
      oauth: oauthIds.has(provider),
      // Only credentials stored in auth.json can be logged out; env vars and
      // models.json-defined providers are managed outside the app.
      removable: status.source === "stored",
      ...(status.configured ? { connection: connectionLabel(authStorage, provider, status.source) } : {}),
    };
  });
  return {
    type: "status",
    providers,
    availableModels: modelRegistry.getAvailable().length,
    anyConfigured: providers.some((p) => p.configured),
  };
}

function authProviders() {
  const { authStorage, modelRegistry } = createRegistry();
  const oauth = authStorage.getOAuthProviders().map((p) => ({
    id: p.id,
    name: p.name,
    usesCallbackServer: Boolean(p.usesCallbackServer),
  }));
  const oauthIds = new Set(oauth.map((p) => p.id));
  const all = uniqueProviders(modelRegistry).map((provider) => ({
    provider,
    displayName: modelRegistry.getProviderDisplayName(provider),
    oauth: oauthIds.has(provider),
    configured: modelRegistry.getProviderAuthStatus(provider).configured,
  }));
  return { type: "providers", oauth, all };
}

function authModels() {
  const { modelRegistry } = createRegistry();
  const models = modelRegistry.getAvailable().map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
  }));
  return { type: "models", models };
}

function authSetKey(provider: string, key: string) {
  if (!provider) return { type: "error", message: "missing provider" };
  const trimmed = key.trim();
  if (!trimmed) return { type: "error", message: "empty API key" };
  const { authStorage } = createRegistry();
  authStorage.set(provider, { type: "api_key", key: trimmed });
  trackProviderConnected(provider, "api_key");
  return { type: "done", provider };
}

function authLogout(provider: string) {
  if (!provider) return { type: "error", message: "missing provider" };
  const { authStorage } = createRegistry();
  authStorage.logout(provider);
  return { type: "done", provider };
}

async function detectOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    return { type: "ollama", running: true, models };
  } catch {
    return { type: "ollama", running: false, models: [] };
  }
}

/** Register the given Ollama model ids in models.json (creating the provider
 *  entry if needed), in a single read-modify-write. */
function writeOllamaModels(ids: string[]) {
  if (ids.length === 0) return { type: "error", message: "no models to add" };
  const { modelsPath } = paths();

  type OllamaModelEntry = { id: string; name: string };
  type ProviderEntry = { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: OllamaModelEntry[] };
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
  const ollama: ProviderEntry = config.providers.ollama ?? {};
  ollama.name ??= "Ollama";
  ollama.baseUrl ??= `${OLLAMA_BASE_URL}/v1`;
  ollama.api ??= "openai-completions";
  ollama.apiKey ??= "ollama";
  ollama.models ??= [];
  for (const id of ids) {
    if (!ollama.models.some((m) => m.id === id)) ollama.models.push({ id, name: id });
  }
  config.providers.ollama = ollama;

  writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  trackProviderConnected("ollama", "ollama");
  return { type: "done", provider: "ollama", count: ids.length };
}

// Ollama defaults every model to a 4096-token context (num_ctx), regardless of
// what the model supports — and its OpenAI-compatible endpoint (which pi uses)
// ignores a per-request num_ctx. With the accountant24 system prompt alone near
// 4k tokens, replies come back empty (the context is full). The fix: bake a
// larger num_ctx into each model in place via /api/create, which the OpenAI
// endpoint *does* honor. This only adds a tiny config layer — it does not
// re-download weights.
const OLLAMA_TARGET_NUM_CTX = 32768;

/** The model's trained max context, if discoverable (`<arch>.context_length`). */
async function ollamaModelMaxContext(model: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { model_info?: Record<string, unknown> };
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number") return value;
    }
  } catch {
    // best effort
  }
  return undefined;
}

/** Re-create each model in place with a larger num_ctx (capped at its trained
 *  max). Best-effort and idempotent; failures (e.g. cloud models) are ignored. */
async function bakeOllamaContext(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map(async (model) => {
      const max = await ollamaModelMaxContext(model);
      const numCtx = Math.min(OLLAMA_TARGET_NUM_CTX, max ?? OLLAMA_TARGET_NUM_CTX);
      if (numCtx <= 4096) return; // nothing to gain over Ollama's default
      try {
        await fetch(`${OLLAMA_BASE_URL}/api/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, from: model, parameters: { num_ctx: numCtx } }),
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        // best effort — a model that can't be re-created just keeps its default
      }
    }),
  );
}

async function addOllama(modelId: string) {
  if (!modelId) return { type: "error", message: "missing model" };
  const result = writeOllamaModels([modelId]);
  if (result.type === "done") await bakeOllamaContext([modelId]);
  return result;
}

/** Connect Ollama by registering every locally-installed model at once. */
async function addAllOllama() {
  const info = await detectOllama();
  if (!info.running) return { type: "error", message: "Ollama isn’t running." };
  if (info.models.length === 0) {
    return { type: "error", message: "Ollama is running but has no models. Pull one with `ollama pull`." };
  }
  const result = writeOllamaModels(info.models);
  if (result.type === "done") await bakeOllamaContext(info.models);
  return result;
}

/** Remove the whole Ollama provider the app added to models.json. Only Ollama is
 *  removable this way — other models.json providers are hand-authored and left
 *  alone. */
function removeOllama() {
  const { modelsPath } = paths();
  if (!existsSync(modelsPath)) return { type: "done", provider: "ollama" };

  type ModelsJson = { providers?: Record<string, unknown> };
  let config: ModelsJson;
  try {
    config = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsJson;
  } catch {
    return { type: "error", message: "models.json is not valid JSON; refusing to overwrite" };
  }
  if (config.providers?.ollama) {
    delete config.providers.ollama;
    writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  // Drop any stored Ollama credential too (normally none — it lives in models.json).
  createRegistry().authStorage.logout("ollama");
  return { type: "done", provider: "ollama" };
}

// ── LiteLLM proxy provider ──────────────────────────────────────────
//
// A LiteLLM proxy is an OpenAI-compatible endpoint the user runs to front their own
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
function removeLiteLLM() {
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
  createRegistry().authStorage.logout("litellm");
  return { type: "done", provider: "litellm" };
}

async function sessionsList() {
  const infos = await SessionManager.list(workspaceDir(), sessionsDir());
  const sessions = infos.map((s) => ({
    path: s.path,
    id: s.id,
    name: s.name ?? "",
    firstMessage: s.firstMessage ?? "",
    messageCount: s.messageCount,
    modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
  }));
  return { type: "sessions", sessions };
}

function sessionsDelete(path: string) {
  if (!path) return { type: "error", message: "session path is required" };
  const target = resolveSessionPath(path);
  if (!target) {
    return { type: "error", message: "refusing to delete a path outside the sessions directory" };
  }
  // A live child would keep running (and eventually re-persist the file) —
  // deleting a running session intentionally aborts it.
  killSessionAgent(target);
  rmSync(target, { force: true });
  return { type: "done", path };
}

// ---- interactive OAuth login (streamed over "auth-event") ------------------

/** State for one sign-in attempt. Scoped per attempt (not module-wide) so a
 *  superseded attempt settling late can't clobber the active one's abort
 *  controller or pending prompts. */
interface LoginAttempt {
  abort: AbortController;
  pending: Map<string, (value: string) => void>;
  counter: number;
}

let activeLogin: LoginAttempt | null = null;

function authLogin(getWin: () => BrowserWindow | null, provider: string): void {
  activeLogin?.abort.abort();
  const attempt: LoginAttempt = { abort: new AbortController(), pending: new Map(), counter: 0 };
  activeLogin = attempt;

  // Events from a superseded attempt are dropped, so a stale login (e.g. the
  // rejection of the one we just aborted) can't talk over the active one.
  const send = (record: Record<string, unknown>) => {
    if (activeLogin !== attempt) return;
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send("auth-event", record);
  };
  const ask = (request: Record<string, unknown>): Promise<string> => {
    const id = `q${++attempt.counter}`;
    return new Promise<string>((res) => {
      attempt.pending.set(id, res);
      send({ ...request, id });
    });
  };

  const callbacks: LoginCallbacks = {
    onAuth: (info) => {
      send({ type: "auth", url: info.url, instructions: info.instructions });
      void shell.openExternal(info.url).catch(() => undefined);
    },
    onDeviceCode: (info) => send({ type: "device_code", ...info }),
    onProgress: (message) => send({ type: "progress", message }),
    onPrompt: (prompt) =>
      ask({ type: "prompt", message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.allowEmpty }),
    onManualCodeInput: () => ask({ type: "manual_code" }),
    onSelect: async (prompt) => {
      const value = await ask({ type: "select", message: prompt.message, options: prompt.options });
      return value === "" ? undefined : value;
    },
    signal: attempt.abort.signal,
  };

  const { authStorage } = createRegistry();
  authStorage
    .login(provider, callbacks)
    .then(() => {
      trackProviderConnected(provider, "oauth");
      send({ type: "done", provider });
    })
    .catch((error) => send({ type: "error", message: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      // Only clear if we're still the active attempt — a newer login owns the
      // slot now and must keep its own abort controller + pending prompts.
      if (activeLogin === attempt) activeLogin = null;
    });
}

function authLoginRespond(id: string, value: string | null): void {
  const attempt = activeLogin;
  const res = attempt?.pending.get(id);
  if (attempt && res) {
    attempt.pending.delete(id);
    res(value ?? "");
  }
}

function authLoginCancel(): void {
  activeLogin?.abort.abort();
}

/** Register auth/sessions IPC handlers. */
export function registerPiIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle("auth_status", () => authStatus());
  ipcMain.handle("auth_providers", () => authProviders());
  ipcMain.handle("auth_models", () => authModels());
  ipcMain.handle("auth_set_key", (_e, { provider, key }: { provider: string; key: string }) =>
    authSetKey(provider, key),
  );
  ipcMain.handle("auth_logout", (_e, { provider }: { provider: string }) => authLogout(provider));
  ipcMain.handle("auth_detect_ollama", () => detectOllama());
  ipcMain.handle("auth_add_ollama", (_e, { model }: { model: string }) => addOllama(model));
  ipcMain.handle("auth_add_all_ollama", () => addAllOllama());
  ipcMain.handle("auth_remove_ollama", () => removeOllama());
  ipcMain.handle("auth_detect_litellm", (_e, { baseUrl }: { baseUrl: string }) => detectLiteLLM(baseUrl));
  ipcMain.handle("auth_add_all_litellm", (_e, { baseUrl }: { baseUrl: string }) => addAllLiteLLM(baseUrl));
  ipcMain.handle("auth_remove_litellm", () => removeLiteLLM());
  ipcMain.handle("auth_login", (_e, { provider }: { provider: string }) => authLogin(getWin, provider));
  ipcMain.handle("auth_login_respond", (_e, { id, value }: { id: string; value: string | null }) =>
    authLoginRespond(id, value),
  );
  ipcMain.handle("auth_login_cancel", () => authLoginCancel());
  ipcMain.handle("sessions_list", () => sessionsList());
  ipcMain.handle("sessions_delete", (_e, { path }: { path: string }) => sessionsDelete(path));
}
