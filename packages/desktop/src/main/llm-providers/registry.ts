// Shared pi SDK access for the provider modules — run IN-PROCESS (no agent
// process needed): stock pi has no headless auth command, and credentials must
// live in auth.json before an agent session starts. ModelRuntime reads/writes
// auth.json + models.json in the workspace — the same files the agent reads
// (their only interface with the agent side).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { workspaceDir } from "../env";

export function paths() {
  const home = workspaceDir();
  return {
    home,
    authPath: join(home, "auth.json"),
    modelsPath: join(home, "models.json"),
    modelsStorePath: join(home, "models-store.json"),
  };
}

/** A fresh runtime per IPC call, so every handler re-reads auth.json and
 *  models.json from disk — that is how the Settings screen picks up credential
 *  changes without an app restart. Offline by default: `allowModelNetwork`
 *  defaults to false, so the create-time refresh resolves availability from the
 *  built-in catalog, models.json, models-store.json (when present) and the
 *  environment, never the network.
 *
 *  models-store.json is only ever pointed at once it exists — i.e. once a
 *  manual "Refresh models" (see refreshModels() below) has written it. A
 *  file-backed store would otherwise drop an empty models-store.json into the
 *  user's ledger directory on every single call, for users who never touch
 *  Refresh at all. Once it exists, every runtime (including the agent host's
 *  own, host/runtime.ts) reads it, since a refresh only ever adds or updates a
 *  catalog, never removes one. */
export function createProviderRuntime(): Promise<ModelRuntime> {
  const { authPath, modelsPath, modelsStorePath } = paths();
  return ModelRuntime.create({
    authPath,
    modelsPath,
    ...(existsSync(modelsStorePath) ? { modelsStorePath } : {}),
  });
}

/** Re-fetch every provider's model catalog over the network, bypassing pi's
 *  four-hour freshness throttle so a click always hits the network. A
 *  provider whose fetch fails keeps its previously stored (or built-in)
 *  catalog — refresh only ever adds or updates a catalog, never removes one,
 *  so a flaky or offline connection falls back to whatever was already
 *  there.
 *
 *  This is the one call that always points at models-store.json, network
 *  outcome or not, so a successful fetch has somewhere to persist to —
 *  createProviderRuntime() above only starts reading it once it exists. */
export async function refreshModels(): Promise<{ ok: true } | { ok: false; message: string }> {
  const { authPath, modelsPath, modelsStorePath } = paths();
  const runtime = await ModelRuntime.create({ authPath, modelsPath, modelsStorePath });
  const result = await runtime.refresh({ allowNetwork: true, force: true });
  if (result.aborted) return { ok: false, message: "The model refresh was interrupted. Try again." };
  if (result.errors.size > 0) {
    const failed = result.errors.size;
    return {
      ok: false,
      message: `Couldn't refresh ${failed} provider${failed === 1 ? "" : "s"}. Check your connection and try again.`,
    };
  }
  return { ok: true };
}
