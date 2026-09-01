import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CrashReportInput,
  diag,
  formatCrashReport,
  type RawProcessMetric,
  Ring,
  reduceAppMetrics,
  summarizeForwards,
} from "../diag";

// diag.ts is renderer-blank / crash instrumentation. The pure pieces
// (Ring, reduceAppMetrics, summarizeForwards, formatCrashReport) carry the
// report's completeness contract; the Diag collector owns the running counters
// and the durable diag.log. Nothing here touches Electron.

beforeEach(() => {
  diag.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ring", () => {
  it("should keep only the last N items in FIFO order when pushed past capacity", () => {
    const r = new Ring<number>(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });

  it("should hold everything when under capacity", () => {
    const r = new Ring<string>(10);
    r.push("a");
    r.push("b");
    expect(r.toArray()).toEqual(["a", "b"]);
  });

  it("should be empty after clear()", () => {
    const r = new Ring<number>(3);
    r.push(1);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.toArray()).toEqual([]);
  });
});

describe("reduceAppMetrics()", () => {
  it("should map type, pid and working-set fields from a full metric", () => {
    const raw: RawProcessMetric[] = [
      {
        type: "Tab",
        pid: 42,
        memory: { workingSetSize: 1234, peakWorkingSetSize: 4321 },
        cpu: { percentCPUUsage: 12.34 },
      },
    ];
    expect(reduceAppMetrics(raw)).toEqual([
      { type: "Tab", pid: 42, name: "", wsKB: 1234, peakWsKB: 4321, cpuPct: 12.3 },
    ]);
  });

  it("should fall back name -> serviceName -> empty string", () => {
    const raw: RawProcessMetric[] = [
      { type: "Utility", pid: 1, name: "agent-host" },
      { type: "Utility", pid: 2, serviceName: "network.mojom.NetworkService" },
      { type: "GPU", pid: 3 },
    ];
    expect(reduceAppMetrics(raw).map((r) => r.name)).toEqual(["agent-host", "network.mojom.NetworkService", ""]);
  });

  it("should treat missing cpu and memory as zero", () => {
    expect(reduceAppMetrics([{ type: "Browser", pid: 7 }])).toEqual([
      { type: "Browser", pid: 7, name: "", wsKB: 0, peakWsKB: 0, cpuPct: 0 },
    ]);
  });

  it("should round working set to whole KiB and cpu to one decimal", () => {
    const [row] = reduceAppMetrics([
      { type: "Tab", pid: 1, memory: { workingSetSize: 10.7 }, cpu: { percentCPUUsage: 0.049 } },
    ]);
    expect(row.wsKB).toBe(11);
    expect(row.cpuPct).toBe(0);
  });
});

describe("summarizeForwards()", () => {
  it("should return zeros and an empty list for no records", () => {
    expect(summarizeForwards([])).toEqual({ count: 0, totalBytes: 0, maxBytes: 0, largest: [] });
  });

  it("should sum bytes, report the max, and list the five biggest largest-first", () => {
    const records = [10, 500, 30, 900, 20, 700, 40].map((bytes, idx) => ({
      t: `2026-09-01T00:00:0${idx}.000Z`,
      session: `s${idx}`,
      bytes,
    }));
    const s = summarizeForwards(records);
    expect(s.count).toBe(7);
    expect(s.totalBytes).toBe(10 + 500 + 30 + 900 + 20 + 700 + 40);
    expect(s.maxBytes).toBe(900);
    expect(s.largest.map((r) => r.bytes)).toEqual([900, 700, 500, 40, 30]);
  });
});

/** A fully populated report input; override fields per test. */
function makeInput(overrides: Partial<CrashReportInput> = {}): CrashReportInput {
  return {
    t: "2026-09-01T12:00:00.000Z",
    trigger: "render-process-gone",
    reason: "oom",
    exitCode: 5,
    detail: { foo: "bar" },
    appVersion: "9.9.9",
    electronVersion: "42.5.0",
    chromeVersion: "130.0.0.0",
    uptimeMs: 123_456,
    msSinceLastLoad: 60_000,
    rendererUrl: "app://index/",
    mainMemory: {
      rss: 200 * 1024 * 1024,
      heapTotal: 90 * 1024 * 1024,
      heapUsed: 70 * 1024 * 1024,
      external: 3 * 1024 * 1024,
      arrayBuffers: 1 * 1024 * 1024,
    },
    metrics: [
      {
        t: "2026-09-01T11:59:50.000Z",
        rows: [{ type: "Tab", pid: 10, name: "", wsKB: 300_000, peakWsKB: 320_000, cpuPct: 8 }],
      },
      {
        t: "2026-09-01T11:59:55.000Z",
        rows: [{ type: "Tab", pid: 10, name: "", wsKB: 3_800_000, peakWsKB: 3_900_000, cpuPct: 40 }],
      },
    ],
    rendererHeap: [{ t: "2026-09-01T11:59:55.000Z", usedMB: 1800, totalMB: 2000, limitMB: 4096 }],
    rendererErrors: [
      {
        t: "2026-09-01T11:59:59.000Z",
        kind: "react-boundary",
        message: "Cannot read properties of undefined",
        stack: "Error: boom\n  at Foo\n  at Bar",
        componentStack: "\n  in Chat\n  in App",
      },
    ],
    navTimeline: [{ t: "2026-09-01T11:59:00.000Z", event: "did-finish-load", url: "app://index/" }],
    forwards: [
      { t: "2026-09-01T11:59:58.000Z", session: "/ws/sessions/a.jsonl", bytes: 42 },
      { t: "2026-09-01T11:59:59.000Z", session: "/ws/sessions/a.jsonl", bytes: 5_000_000 },
    ],
    runningSessions: ["/ws/sessions/a.jsonl"],
    cumulativeBytesBySession: { "/ws/sessions/a.jsonl": 5_000_042 },
    maxLineBytes: 5_000_000,
    failedSendCount: 3,
    gpuFeatureStatus: { gpu_compositing: "enabled" },
    gpuCrashCount: 1,
    crashDumpsDir: "/tmp/Crashpad",
    ...overrides,
  };
}

describe("formatCrashReport()", () => {
  it("should include the trigger, reason, exit code and detail in the header", () => {
    const out = formatCrashReport(makeInput());
    expect(out).toContain("trigger         render-process-gone");
    expect(out).toContain("reason          oom");
    expect(out).toContain("exitCode        5");
    expect(out).toContain('detail          {"foo":"bar"}');
  });

  it("should render every section heading", () => {
    const out = formatCrashReport(makeInput());
    for (const heading of [
      "--- agent forwarding",
      "--- main process memory",
      "--- per-process memory history",
      "--- renderer JS heap history",
      "--- uncaught renderer errors",
      "--- navigation timeline",
      "--- GPU ---",
    ]) {
      expect(out).toContain(heading);
    }
  });

  it("should surface the largest forwarded line and the running session", () => {
    const out = formatCrashReport(makeInput());
    expect(out).toContain("5000000 bytes  /ws/sessions/a.jsonl");
    expect(out).toContain("running sessions        /ws/sessions/a.jsonl");
    expect(out).toContain("failed sends since ok   3");
  });

  it("should print the working-set trend for a Tab process across all samples", () => {
    const out = formatCrashReport(makeInput());
    // 300_000 KiB ~= 293 MiB, 3_800_000 KiB ~= 3711 MiB
    expect(out).toMatch(/trend Tab pid 10: 11:59:50=293MiB 11:59:55=3711MiB/);
  });

  it("should include the renderer error message, stack and component stack", () => {
    const out = formatCrashReport(makeInput());
    expect(out).toContain("[react-boundary] Cannot read properties of undefined");
    expect(out).toContain("at Foo");
    expect(out).toContain("in Chat");
  });

  it("should show placeholders when every buffer is empty", () => {
    const out = formatCrashReport(
      makeInput({
        metrics: [],
        rendererHeap: [],
        rendererErrors: [],
        navTimeline: [],
        forwards: [],
        cumulativeBytesBySession: {},
      }),
    );
    expect(out).toContain("(no samples)");
    expect(out).toContain("(no samples reported by the renderer)");
    expect(out).toContain("--- uncaught renderer errors ---\n(none)");
    expect(out).toContain("--- navigation timeline ---\n(none)");
    expect(out).toContain("cumulative this run     (none)");
  });

  it("should omit the reason and exitCode lines when they are not provided", () => {
    const out = formatCrashReport(makeInput({ reason: undefined, exitCode: undefined }));
    expect(out).not.toContain("reason          ");
    expect(out).not.toContain("exitCode        ");
  });

  it("should be deterministic for the same input", () => {
    const input = makeInput();
    expect(formatCrashReport(input)).toBe(formatCrashReport(input));
  });
});

describe("diag.recordForward()", () => {
  it("should accumulate bytes per session and track the global max line size", () => {
    diag.recordForward("s1", 100);
    diag.recordForward("s1", 250);
    diag.recordForward("s2", 900);
    const report = captureReport("render-process-gone");
    expect(report).toContain("350 bytes"); // s1 cumulative: 100 + 250
    expect(report).toContain("s1");
    expect(report).toContain("max single line         900 bytes");
  });

  it("should warn immediately when a single forwarded line is unusually large", () => {
    diag.recordForward("s1", 300 * 1024);
    expect(
      (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("large agent line: 307200 bytes for s1"),
      ),
    ).toBe(true);
  });

  it("should clear one session's running total on resetRunBytes()", () => {
    diag.recordForward("s1", 400);
    diag.resetRunBytes("s1");
    const report = captureReport("render-process-gone");
    expect(report).toContain("cumulative this run     (none)");
  });
});

describe("diag.noteGpuCrash()", () => {
  it("should count toward the GPU crash total shown in the report", () => {
    diag.noteGpuCrash();
    diag.noteGpuCrash();
    expect(captureReport("child-process-gone")).toContain("gpu child-process-gone this session: 2");
  });
});

describe("diag.setRunningSessionsProvider()", () => {
  it("should use the provider's sessions when report() is not given an explicit list", () => {
    diag.setRunningSessionsProvider(() => ["/ws/sessions/live.jsonl"]);
    expect(captureReport("render-process-gone")).toContain("running sessions        /ws/sessions/live.jsonl");
  });

  it("should fall back to no running sessions when the provider throws", () => {
    diag.setRunningSessionsProvider(() => {
      throw new Error("router not ready");
    });
    expect(captureReport("render-process-gone")).toContain("running sessions        (none)");
  });
});

describe("diag send-failure counter", () => {
  it("should count consecutive failed sends and reset on the next success", () => {
    diag.noteFailedSend(new Error("gone"));
    diag.noteFailedSend(new Error("gone"));
    expect(captureReport("render-process-gone")).toContain("failed sends since ok   2");
    diag.noteSuccessfulSend();
    expect(captureReport("render-process-gone")).toContain("failed sends since ok   0");
  });

  it("should stringify a non-Error failure reason", () => {
    diag.noteFailedSend("frame disposed");
    expect(
      (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("frame disposed"),
      ),
    ).toBe(true);
  });
});

describe("diag.recordRendererReport()", () => {
  it("should route a heap sample into the JS-heap history", () => {
    diag.recordRendererReport({ kind: "heap", usedMB: 1500, totalMB: 1800, limitMB: 4096 });
    const report = captureReport("render-process-gone");
    expect(report).toContain("used 1500.0MiB / total 1800.0MiB / limit 4096.0MiB");
  });

  it("should default missing heap fields to zero", () => {
    diag.recordRendererReport({ kind: "heap" });
    const report = captureReport("render-process-gone");
    expect(report).toContain("used 0.0MiB / total 0.0MiB / limit 0.0MiB");
  });

  it("should route an error report into the uncaught-errors list", () => {
    diag.recordRendererReport({ kind: "unhandledrejection", message: "promise blew up" });
    expect(captureReport("render-process-gone")).toContain("[unhandledrejection] promise blew up");
  });

  it("should coerce an unknown kind to a plain error record", () => {
    diag.recordRendererReport({ kind: "weird", message: "mystery" });
    expect(captureReport("render-process-gone")).toContain("[error] mystery");
  });

  it("should substitute a placeholder when no message is given", () => {
    diag.recordRendererReport({ kind: "error" });
    expect(captureReport("render-process-gone")).toContain("[error] (no message)");
  });

  it("should also print the stack and component stack immediately when present", () => {
    diag.recordRendererReport({
      kind: "react-boundary",
      message: "boom",
      stack: "Error: boom\n  at Widget",
      componentStack: "\n  in Widget",
    });
    const calls = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((c) => c.includes("at Widget"))).toBe(true);
    expect(calls.some((c) => c.includes("component stack:"))).toBe(true);
  });
});

describe("diag.setStatics()", () => {
  it("should tolerate rotating the log before a userDataDir has ever been set", () => {
    expect(() => diag.setStatics({ appVersion: "1.0.0" })).not.toThrow();
    expect(diag.readDiagLog()).toBe("");
  });
});

describe("diag.armMetricsSampler()", () => {
  it("should take one sample immediately and one per interval, and stop when told", () => {
    vi.useFakeTimers();
    let calls = 0;
    const getMetrics = (): RawProcessMetric[] => {
      calls += 1;
      return [{ type: "Tab", pid: 1, memory: { workingSetSize: calls * 1000 } }];
    };
    const stop = diag.armMetricsSampler(getMetrics, 1000);
    expect(diag.metrics.size).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(diag.metrics.size).toBe(4);
    stop();
    vi.advanceTimersByTime(5000);
    expect(diag.metrics.size).toBe(4);
  });

  it("should keep sampling when getMetrics throws", () => {
    vi.useFakeTimers();
    const getMetrics = (): RawProcessMetric[] => {
      throw new Error("metrics unavailable");
    };
    diag.armMetricsSampler(getMetrics, 1000);
    vi.advanceTimersByTime(2000);
    // No sample recorded, but the interval is still alive (no throw escaped).
    expect(diag.metrics.size).toBe(0);
  });
});

describe("diag durable log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diag-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("should append each report to <userData>/diag.log and read it back", () => {
    diag.setStatics({ userDataDir: dir, crashDumpsDir: "/x", appVersion: "1.2.3" });
    diag.report("render-process-gone", { reason: "oom" });
    diag.report("child-process-gone", { reason: "crashed", detail: { type: "GPU" } });

    const onDisk = readFileSync(join(dir, "diag.log"), "utf8");
    expect(onDisk).toContain("reason          oom");
    expect(onDisk).toContain("trigger         child-process-gone");
    expect(diag.readDiagLog()).toBe(onDisk);
  });

  it("should truncate an oversized pre-existing diag.log on setStatics()", () => {
    const logPath = join(dir, "diag.log");
    writeFileSync(logPath, "x".repeat(2 * 1024 * 1024 + 10));
    diag.setStatics({ userDataDir: dir });
    expect(statSync(logPath).size).toBe(0);
  });

  it("should return an empty string from readDiagLog() when no log exists yet", () => {
    diag.setStatics({ userDataDir: dir });
    expect(diag.readDiagLog()).toBe("");
  });

  it("should return an empty string from readDiagLog() with no userDataDir configured", () => {
    expect(diag.readDiagLog()).toBe("");
  });

  it("should log rather than throw when the diag.log write fails", () => {
    // A userDataDir path through an existing file can never be mkdir'd into.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    diag.setStatics({ userDataDir: join(blocker, "sub") });
    diag.report("render-process-gone", { reason: "oom" });
    expect(
      (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("could not write diag.log"),
      ),
    ).toBe(true);
  });
});

/**
 * Trigger a report and return the text handed to console.error. The report is
 * always emitted there; the durable log path is covered separately.
 */
function captureReport(trigger: string): string {
  const spy = console.error as unknown as ReturnType<typeof vi.fn>;
  spy.mockClear();
  diag.report(trigger);
  const call = spy.mock.calls.find((args: unknown[]) => String(args[0]).includes("[diag] renderer/crash report"));
  if (!call) throw new Error("no crash report was printed");
  return String(call[0]);
}
