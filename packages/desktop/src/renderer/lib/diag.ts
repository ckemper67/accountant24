// Renderer-side crash instrumentation. Forwards uncaught errors, unhandled
// promise rejections, and periodic JS-heap samples to main, where diag.ts
// folds them into the one-shot "why did the window go blank" report.
//
// Observability only: nothing here changes app behavior. It exists so a single
// reproduction of the blank-screen bug carries enough evidence to tell apart
// "a React component threw" (an error record appears, no render-process-gone),
// "the JS heap ran away" (climbing heap samples), and "the render process died
// natively" (no renderer records at all, just the main-side event).

const HEAP_SAMPLE_MS = 10_000;
const MIB = 1024 * 1024;

export type RendererDiagReport =
  | {
      kind: "error" | "unhandledrejection" | "react-boundary";
      message: string;
      stack?: string;
      componentStack?: string;
      url?: string;
    }
  | { kind: "heap"; usedMB: number; totalMB: number; limitMB: number };

/** Fire-and-forget send to main. The bridge may already be gone (frame being
 *  torn down) -- swallow that, there is nothing useful to do from here. */
export function reportToMain(report: RendererDiagReport): void {
  try {
    void window.api.invoke("diag_renderer_report", report);
  } catch {
    // bridge unavailable
  }
}

interface ChromeMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

let installed = false;

/** Install the global error listeners and start heap sampling. Idempotent. */
export function installRendererDiag(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (ev) => {
    reportToMain({
      kind: "error",
      message: ev.message || String(ev.error?.message ?? "uncaught error"),
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
      url: `${ev.filename}:${ev.lineno}:${ev.colno}`,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    reportToMain({
      kind: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  const sampleHeap = () => {
    if (document.visibilityState !== "visible") return;
    const mem = (performance as Performance & { memory?: ChromeMemory }).memory;
    if (!mem) return;
    reportToMain({
      kind: "heap",
      usedMB: mem.usedJSHeapSize / MIB,
      totalMB: mem.totalJSHeapSize / MIB,
      limitMB: mem.jsHeapSizeLimit / MIB,
    });
  };
  sampleHeap();
  setInterval(sampleHeap, HEAP_SAMPLE_MS);
}
