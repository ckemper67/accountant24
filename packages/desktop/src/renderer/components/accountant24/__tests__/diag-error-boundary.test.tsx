// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ErrorInfo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagErrorBoundary } from "../diag-error-boundary";

// The boundary forwards a caught render error (plus its component stack) to
// main over window.api and paints a visible fallback. window.api is the faked
// boundary; React's own error handling runs for real.

const invoke = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  (window as unknown as { api: { invoke: typeof invoke; on: () => void } }).api = { invoke, on: () => {} };
});

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

function Boom(): null {
  throw new Error("kaboom");
}

describe("DiagErrorBoundary", () => {
  it("should render its children when nothing throws", () => {
    render(
      <DiagErrorBoundary>
        <div>healthy child</div>
      </DiagErrorBoundary>,
    );
    expect(screen.queryByText("healthy child")).not.toBeNull();
  });

  it("should show the fallback and forward the error to main when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <DiagErrorBoundary>
        <Boom />
      </DiagErrorBoundary>,
    );

    expect(screen.queryByText("Something went wrong.")).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      "diag_renderer_report",
      expect.objectContaining({ kind: "react-boundary", message: "kaboom" }),
    );
    const [, payload] = invoke.mock.calls[0] as [string, { componentStack?: string; stack?: string }];
    expect(payload.componentStack).toContain("Boom");
    expect(payload.stack).toContain("Error: kaboom");

    consoleError.mockRestore();
  });

  it("should omit componentStack when React does not supply one", () => {
    const boundary = new DiagErrorBoundary({ children: null });
    boundary.componentDidCatch(new Error("kaboom"), {} as ErrorInfo);
    expect(invoke).toHaveBeenCalledWith(
      "diag_renderer_report",
      expect.objectContaining({ kind: "react-boundary", message: "kaboom", componentStack: undefined }),
    );
  });
});
