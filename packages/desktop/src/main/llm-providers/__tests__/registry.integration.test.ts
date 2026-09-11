// The one claim the "Refresh models" feature stands on: a catalog a refresh
// persists to models-store.json is actually picked up by a LATER, independent
// ModelRuntime creation — the shape every other IPC call and the agent host
// use. The pi SDK is the real thing here (unmocked); only the workspace files
// are faked, over a real temp dir.

import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpWorkspace } from "../../__tests__/tmpWorkspace";

const ws = makeTmpWorkspace();

beforeEach(() => ws.setup());
afterEach(() => ws.cleanup());

/** A models-store.json overlay entry pi's remote-catalog provider will accept:
 *  `lastModified` has to be newer than the built-in catalog's own generation
 *  timestamp, or the overlay is treated as stale and dropped. */
function seedStore(providerId: string, model: { id: string; name: string }) {
  writeFileSync(
    ws.path("models-store.json"),
    JSON.stringify({
      [providerId]: {
        models: [{ provider: providerId, ...model, api: "anthropic-messages" }],
        checkedAt: Date.now(),
        lastModified: Date.now(),
      },
    }),
  );
}

describe("a persisted models-store.json overlay", () => {
  it("should surface in a freshly created runtime pointed at the same file", async () => {
    writeFileSync(ws.path("auth.json"), "{}");
    writeFileSync(ws.path("models.json"), "{}");
    seedStore("anthropic", { id: "probe-model", name: "Probe Model" });

    const { createProviderRuntime } = await import("../registry");
    const runtime = await createProviderRuntime();

    expect(runtime.getModels("anthropic").map((m) => m.id)).toContain("probe-model");
  });

  it("should still surface after a second, independent runtime creation", async () => {
    writeFileSync(ws.path("auth.json"), "{}");
    writeFileSync(ws.path("models.json"), "{}");
    seedStore("anthropic", { id: "probe-model-2", name: "Probe Model 2" });

    const { createProviderRuntime } = await import("../registry");
    await createProviderRuntime();
    const second = await createProviderRuntime();

    expect(second.getModels("anthropic").map((m) => m.id)).toContain("probe-model-2");
  });
});
