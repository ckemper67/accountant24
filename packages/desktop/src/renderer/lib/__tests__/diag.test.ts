// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererDiag, reportToMain } from "../diag";

// renderer/lib/diag.ts forwards uncaught errors, unhandled rejections and
// periodic JS-heap samples to main over the diag_renderer_report channel. The
// window.api bridge and performance.memory are the faked boundaries; the
// listener + sampler wiring runs for real.

const MIB = 1024 * 1024;
const invoke = vi.fn().mockResolvedValue(undefined);

const setVisibility = (value: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { value, configurable: true });

beforeAll(() => {
  vi.useFakeTimers();
  installRendererDiag();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // The jsdom env re-creates these per test, so (re)establish them every time —
  // the persistent heap-sampling interval reads them on each tick.
  (window as unknown as { api: { invoke: typeof invoke; on: () => void } }).api = { invoke, on: () => {} };
  (performance as unknown as { memory: Record<string, number> }).memory = {
    usedJSHeapSize: 1500 * MIB,
    totalJSHeapSize: 1800 * MIB,
    jsHeapSizeLimit: 4096 * MIB,
  };
  setVisibility("visible");
});

afterEach(() => {
  invoke.mockClear();
});

describe("reportToMain()", () => {
  it("should send the report verbatim on the diag_renderer_report channel", () => {
    reportToMain({ kind: "error", message: "x" });
    expect(invoke).toHaveBeenCalledWith("diag_renderer_report", { kind: "error", message: "x" });
  });

  it("should swallow a bridge failure rather than throw", () => {
    invoke.mockImplementationOnce(() => {
      throw new Error("bridge gone");
    });
    expect(() => reportToMain({ kind: "heap", usedMB: 1, totalMB: 1, limitMB: 1 })).not.toThrow();
  });
});

describe("installRendererDiag() global listeners", () => {
  it("should forward an uncaught error with its stack and source location", () => {
    const err = new Error("boom");
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "app://index/b.js", lineno: 4, colno: 9, error: err }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "diag_renderer_report",
      expect.objectContaining({ kind: "error", message: "boom", url: "app://index/b.js:4:9", stack: err.stack }),
    );
  });

  it("should forward an unhandled rejection whose reason is an Error", () => {
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("rejected") }));
    expect(invoke).toHaveBeenCalledWith(
      "diag_renderer_report",
      expect.objectContaining({ kind: "unhandledrejection", message: "rejected" }),
    );
  });

  it("should stringify a non-Error rejection reason and omit the stack", () => {
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "plain reason" }));
    expect(invoke).toHaveBeenCalledWith("diag_renderer_report", {
      kind: "unhandledrejection",
      message: "plain reason",
      stack: undefined,
    });
  });

  it("should fall back to a placeholder message and no stack when the event carries neither", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "", filename: "app://x.js", lineno: 1, colno: 1 }));
    expect(invoke).toHaveBeenCalledWith(
      "diag_renderer_report",
      expect.objectContaining({ kind: "error", message: "uncaught error", stack: undefined }),
    );
  });

  it("should register each listener once even if called again", () => {
    installRendererDiag();
    window.dispatchEvent(new ErrorEvent("error", { message: "once", error: new Error("once") }));
    const errorReports = invoke.mock.calls.filter(
      ([, payload]) => (payload as { message?: string }).message === "once",
    );
    expect(errorReports).toHaveLength(1);
  });
});

describe("installRendererDiag() heap sampler", () => {
  it("should report a heap sample on each interval while the tab is visible", () => {
    vi.advanceTimersByTime(10_000);
    expect(invoke).toHaveBeenCalledWith("diag_renderer_report", {
      kind: "heap",
      usedMB: 1500,
      totalMB: 1800,
      limitMB: 4096,
    });
  });

  it("should skip heap sampling while the tab is hidden", () => {
    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);
    const heapCalls = invoke.mock.calls.filter(([, p]) => (p as { kind?: string }).kind === "heap");
    expect(heapCalls).toHaveLength(0);
  });

  it("should skip heap sampling when performance.memory is unavailable", () => {
    (performance as unknown as { memory?: unknown }).memory = undefined;
    vi.advanceTimersByTime(10_000);
    const heapCalls = invoke.mock.calls.filter(([, p]) => (p as { kind?: string }).kind === "heap");
    expect(heapCalls).toHaveLength(0);
  });
});
