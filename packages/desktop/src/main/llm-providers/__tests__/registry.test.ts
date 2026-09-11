import { beforeEach, describe, expect, it, vi } from "vitest";

// registry.ts wraps one I/O boundary — the pi SDK's ModelRuntime — which is
// faked; refreshModels()'s own result-shaping logic runs for real.

const h = vi.hoisted(() => ({
  modelRuntime: {
    refresh: vi.fn<(opts: unknown) => Promise<{ aborted: boolean; errors: Map<string, Error> }>>(async () => ({
      aborted: false,
      errors: new Map(),
    })),
  },
  runtimeCreate: vi.fn(async (_opts: unknown) => h.modelRuntime),
  // Whether models-store.json already exists on disk — true by default so
  // most specs exercise the common (already-refreshed-once) path.
  existsSync: vi.fn(() => true),
}));

vi.mock("../../env", () => ({ workspaceDir: () => "/ws" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: h.runtimeCreate },
}));
vi.mock("node:fs", () => ({ existsSync: h.existsSync }));

beforeEach(() => {
  h.modelRuntime.refresh.mockImplementation(async () => ({ aborted: false, errors: new Map() }));
  h.runtimeCreate.mockImplementation(async () => h.modelRuntime);
  h.existsSync.mockReturnValue(true);
  vi.resetModules();
});

describe("createProviderRuntime()", () => {
  it("should point the runtime at models-store.json once a refresh has already written one", async () => {
    const { createProviderRuntime } = await import("../registry");
    await createProviderRuntime();

    expect(h.runtimeCreate).toHaveBeenCalledWith({
      authPath: "/ws/auth.json",
      modelsPath: "/ws/models.json",
      modelsStorePath: "/ws/models-store.json",
    });
  });

  it("should keep the models store in memory until a refresh has actually written one", async () => {
    // No models-store.json yet: a file-backed store would otherwise drop an
    // empty one into the user's ledger directory on every single call.
    h.existsSync.mockReturnValue(false);
    const { createProviderRuntime } = await import("../registry");
    await createProviderRuntime();

    const options = h.runtimeCreate.mock.calls[0][0] as { modelsStorePath?: string };
    expect("modelsStorePath" in options).toBe(false);
  });
});

describe("refreshModels()", () => {
  it("should force a network refresh across every provider", async () => {
    const { refreshModels } = await import("../registry");
    await refreshModels();

    expect(h.modelRuntime.refresh).toHaveBeenCalledWith({ allowNetwork: true, force: true });
  });

  it("should always point at models-store.json, even before any refresh has ever written it", async () => {
    // Unlike createProviderRuntime(), this is the call that creates the file
    // in the first place, so it can never gate on existsSync.
    h.existsSync.mockReturnValue(false);
    const { refreshModels } = await import("../registry");
    await refreshModels();

    expect(h.runtimeCreate).toHaveBeenCalledWith({
      authPath: "/ws/auth.json",
      modelsPath: "/ws/models.json",
      modelsStorePath: "/ws/models-store.json",
    });
  });

  it("should report ok when every provider refreshes cleanly", async () => {
    const { refreshModels } = await import("../registry");
    await expect(refreshModels()).resolves.toEqual({ ok: true });
  });

  it("should report the interruption when the refresh is aborted", async () => {
    h.modelRuntime.refresh.mockResolvedValue({ aborted: true, errors: new Map() });
    const { refreshModels } = await import("../registry");

    await expect(refreshModels()).resolves.toEqual({
      ok: false,
      message: "The model refresh was interrupted. Try again.",
    });
  });

  it("should report one failed provider in the singular", async () => {
    h.modelRuntime.refresh.mockResolvedValue({
      aborted: false,
      errors: new Map([["openai", new Error("timed out")]]),
    });
    const { refreshModels } = await import("../registry");

    await expect(refreshModels()).resolves.toEqual({
      ok: false,
      message: "Couldn't refresh 1 provider. Check your connection and try again.",
    });
  });

  it("should report multiple failed providers in the plural, without listing their names", async () => {
    h.modelRuntime.refresh.mockResolvedValue({
      aborted: false,
      errors: new Map([
        ["openai", new Error("timed out")],
        ["anthropic", new Error("offline")],
      ]),
    });
    const { refreshModels } = await import("../registry");

    await expect(refreshModels()).resolves.toEqual({
      ok: false,
      message: "Couldn't refresh 2 providers. Check your connection and try again.",
    });
  });
});
