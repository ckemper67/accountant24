// Renderer-blank / crash instrumentation. Observability only: this module
// never changes app behavior, it only records and prints.
//
// The goal is to resolve, in a SINGLE reproduction, why the window sometimes
// goes blank while the agent streams. The fork in the road is the
// `render-process-gone` reason plus two memory trends:
//
//   reason "oom"     + climbing renderer RSS / JS heap -> unbounded payload
//   reason "crashed" + flat memory                     -> a renderer-side bug
//   no event at all  + a React error in the log        -> a component threw
//   child-process-gone type "GPU"                       -> GPU process died
//
// So on every terminal event we dump one self-contained report carrying: the
// reason code, ~6 min of per-process memory history (main + renderer + agent
// host + GPU), the renderer JS heap history, the recent uncaught renderer
// errors, the navigation timeline, and the exact byte sizes of the agent
// event lines forwarded to the renderer just before it died. The report goes
// to stderr AND is appended to <userData>/diag.log so a lost terminal buffer
// or an app restart never costs us the repro.

import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

/** Bounded FIFO; newest at the end. */
export class Ring<T> {
  private readonly items: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.items.push(item);
    const overflow = this.items.length - this.cap;
    if (overflow > 0) this.items.splice(0, overflow);
  }
  toArray(): T[] {
    return [...this.items];
  }
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items.length = 0;
  }
}

/** One process row, reduced from an Electron ProcessMetric. Memory is in KiB
 *  (Electron's unit); we keep it that way and label it. */
export interface ProcMetricRow {
  type: string;
  pid: number;
  name: string;
  wsKB: number;
  peakWsKB: number;
  cpuPct: number;
}

export interface MetricsSample {
  t: string;
  rows: ProcMetricRow[];
}

/** Reported by the renderer over IPC every 10s while the tab is visible. */
export interface RendererHeapSample {
  t: string;
  usedMB: number;
  totalMB: number;
  limitMB: number;
}

/** An uncaught renderer error, unhandled rejection, or React error-boundary
 *  catch, reported over IPC. */
export interface RendererErrorRecord {
  t: string;
  kind: "error" | "unhandledrejection" | "react-boundary";
  message: string;
  stack?: string;
  componentStack?: string;
  url?: string;
}

export interface NavRecord {
  t: string;
  event: string;
  url: string;
}

/** One agent event line forwarded to the renderer: how big it was. */
export interface ForwardRecord {
  t: string;
  session: string;
  bytes: number;
}

/** Shape accepted by reduceAppMetrics — a structural subset of
 *  Electron.ProcessMetric, so the reducer stays unit-testable without Electron. */
export interface RawProcessMetric {
  type: string;
  pid: number;
  name?: string;
  serviceName?: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number; peakWorkingSetSize?: number };
}

/** Reduce Electron's app.getAppMetrics() output to the fields we log. Pure. */
export function reduceAppMetrics(raw: RawProcessMetric[]): ProcMetricRow[] {
  return raw.map((m) => ({
    type: m.type,
    pid: m.pid,
    name: m.name ?? m.serviceName ?? "",
    wsKB: Math.round(m.memory?.workingSetSize ?? 0),
    peakWsKB: Math.round(m.memory?.peakWorkingSetSize ?? 0),
    cpuPct: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
  }));
}

export interface ForwardSummary {
  count: number;
  totalBytes: number;
  maxBytes: number;
  largest: ForwardRecord[];
}

/** Summarize forwarded-line sizes: total, max, and the five biggest. Pure. */
export function summarizeForwards(records: ForwardRecord[]): ForwardSummary {
  let totalBytes = 0;
  let maxBytes = 0;
  for (const r of records) {
    totalBytes += r.bytes;
    if (r.bytes > maxBytes) maxBytes = r.bytes;
  }
  const largest = [...records].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  return { count: records.length, totalBytes, maxBytes, largest };
}

export interface CrashReportInput {
  t: string;
  trigger: string;
  reason?: string;
  exitCode?: number;
  detail?: Record<string, unknown>;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  uptimeMs: number;
  msSinceLastLoad?: number;
  rendererUrl?: string;
  mainMemory: NodeJS.MemoryUsage;
  metrics: MetricsSample[];
  rendererHeap: RendererHeapSample[];
  rendererErrors: RendererErrorRecord[];
  navTimeline: NavRecord[];
  forwards: ForwardRecord[];
  runningSessions: string[];
  cumulativeBytesBySession: Record<string, number>;
  maxLineBytes: number;
  failedSendCount: number;
  gpuFeatureStatus?: Record<string, string>;
  gpuCrashCount: number;
  crashDumpsDir: string;
}

const KIB = 1024;
const MIB = 1024 * 1024;
/** bytes -> "N.N MiB". */
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
/** KiB (Electron's working-set unit) -> "N.N MiB". */
const mibFromKib = (kibs: number) => `${(kibs / KIB).toFixed(1)} MiB`;

/** Which ProcessMetric.type values get their full history printed (the two that
 *  actually move during a blank); the rest print latest-only. */
const TREND_TYPES = new Set(["Tab", "Utility"]);

/** Assemble the one-shot crash report. Pure: same input -> same string. */
export function formatCrashReport(i: CrashReportInput): string {
  const L: string[] = [];
  L.push("================ [diag] renderer/crash report ================");
  L.push(`when            ${i.t}`);
  L.push(`trigger         ${i.trigger}`);
  if (i.reason !== undefined) L.push(`reason          ${i.reason}`);
  if (i.exitCode !== undefined) L.push(`exitCode        ${i.exitCode}`);
  if (i.detail && Object.keys(i.detail).length > 0) L.push(`detail          ${JSON.stringify(i.detail)}`);
  L.push(`app / electron  ${i.appVersion} / electron ${i.electronVersion} / chrome ${i.chromeVersion}`);
  L.push(`uptime          ${(i.uptimeMs / 1000).toFixed(1)}s`);
  if (i.msSinceLastLoad !== undefined) L.push(`since last load ${(i.msSinceLastLoad / 1000).toFixed(1)}s`);
  if (i.rendererUrl) L.push(`renderer url    ${i.rendererUrl}`);
  L.push(`crash dumps     ${i.crashDumpsDir}`);

  L.push("");
  L.push("--- agent forwarding (bytes sent to the renderer as agent-event) ---");
  L.push(`running sessions        ${i.runningSessions.length > 0 ? i.runningSessions.join(", ") : "(none)"}`);
  L.push(`max single line         ${i.maxLineBytes} bytes (${mib(i.maxLineBytes)})`);
  L.push(`failed sends since ok   ${i.failedSendCount}`);
  const cum = Object.entries(i.cumulativeBytesBySession);
  if (cum.length > 0) {
    L.push("cumulative this run:");
    for (const [s, n] of cum) L.push(`  ${n} bytes (${mib(n)})  ${s}`);
  } else {
    L.push("cumulative this run     (none)");
  }
  const fwd = summarizeForwards(i.forwards);
  L.push(`recent forwards         ${fwd.count} lines, ${fwd.totalBytes} bytes total, max ${fwd.maxBytes}`);
  for (const r of fwd.largest) L.push(`  ${r.t}  ${r.bytes} bytes  ${r.session}`);

  L.push("");
  L.push("--- main process memory (process.memoryUsage) ---");
  L.push(
    `rss ${mib(i.mainMemory.rss)}  heapUsed ${mib(i.mainMemory.heapUsed)}  ` +
      `heapTotal ${mib(i.mainMemory.heapTotal)}  external ${mib(i.mainMemory.external)}  ` +
      `arrayBuffers ${mib(i.mainMemory.arrayBuffers)}`,
  );

  L.push("");
  L.push("--- per-process memory history (app.getAppMetrics, working set) ---");
  if (i.metrics.length === 0) {
    L.push("(no samples)");
  } else {
    const latest = i.metrics[i.metrics.length - 1];
    L.push(`latest sample ${latest.t}:`);
    for (const row of latest.rows) {
      L.push(
        `  ${row.type.padEnd(8)} pid ${String(row.pid).padEnd(7)} ws ${mibFromKib(row.wsKB).padStart(10)}  ` +
          `peak ${mibFromKib(row.peakWsKB).padStart(10)}  cpu ${row.cpuPct}%  ${row.name}`,
      );
    }
    // Full working-set trend for the process types that move during a blank.
    const trendPids = new Set<number>();
    for (const s of i.metrics) for (const r of s.rows) if (TREND_TYPES.has(r.type)) trendPids.add(r.pid);
    for (const pid of trendPids) {
      const series = i.metrics
        .map((s) => {
          const row = s.rows.find((r) => r.pid === pid);
          return row ? `${s.t.slice(11, 19)}=${(row.wsKB / KIB).toFixed(0)}MiB` : null; // wsKB is KiB
        })
        .filter((x): x is string => x !== null);
      const type = i.metrics.flatMap((s) => s.rows).find((r) => r.pid === pid)?.type ?? "?";
      L.push(`  trend ${type} pid ${pid}: ${series.join(" ")}`);
    }
  }

  L.push("");
  L.push("--- renderer JS heap history (performance.memory) ---");
  if (i.rendererHeap.length === 0) {
    L.push("(no samples reported by the renderer)");
  } else {
    for (const s of i.rendererHeap) {
      L.push(
        `  ${s.t}  used ${s.usedMB.toFixed(1)}MiB / total ${s.totalMB.toFixed(1)}MiB / limit ${s.limitMB.toFixed(1)}MiB`,
      );
    }
  }

  L.push("");
  L.push("--- uncaught renderer errors ---");
  if (i.rendererErrors.length === 0) {
    L.push("(none)");
  } else {
    for (const e of i.rendererErrors) {
      L.push(`  ${e.t}  [${e.kind}] ${e.message}`);
      if (e.stack) for (const line of e.stack.split("\n").slice(0, 8)) L.push(`      ${line}`);
      if (e.componentStack) for (const line of e.componentStack.split("\n").slice(0, 8)) L.push(`      ${line}`);
    }
  }

  L.push("");
  L.push("--- navigation timeline ---");
  if (i.navTimeline.length === 0) {
    L.push("(none)");
  } else {
    for (const n of i.navTimeline) L.push(`  ${n.t}  ${n.event.padEnd(20)} ${n.url}`);
  }

  L.push("");
  L.push("--- GPU ---");
  L.push(`gpu child-process-gone this session: ${i.gpuCrashCount}`);
  if (i.gpuFeatureStatus) L.push(`feature status: ${JSON.stringify(i.gpuFeatureStatus)}`);

  L.push("=============================================================");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Stateful collector. One instance for the app; fed by window.ts / router.ts /
// the renderer over IPC.
// ---------------------------------------------------------------------------

const METRICS_CAP = 72; // 72 x 5s ~= 6 min
const HEAP_CAP = 40;
const RENDERER_ERR_CAP = 30;
const NAV_CAP = 40;
const FORWARD_CAP = 300;
const DIAG_LOG_MAX_BYTES = 2 * MIB;
const LARGE_LINE_WARN_BYTES = 256 * KIB;

export interface DiagStatics {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  crashDumpsDir: string;
  userDataDir: string;
  gpuFeatureStatus?: Record<string, string>;
}

class Diag {
  private statics: DiagStatics = {
    appVersion: "?",
    electronVersion: process.versions.electron ?? "?",
    chromeVersion: process.versions.chrome ?? "?",
    crashDumpsDir: "?",
    userDataDir: "",
  };
  private readonly startedAt = Date.now();
  private lastLoadAt: number | null = null;

  readonly metrics = new Ring<MetricsSample>(METRICS_CAP);
  readonly rendererHeap = new Ring<RendererHeapSample>(HEAP_CAP);
  readonly rendererErrors = new Ring<RendererErrorRecord>(RENDERER_ERR_CAP);
  readonly nav = new Ring<NavRecord>(NAV_CAP);
  readonly forwards = new Ring<ForwardRecord>(FORWARD_CAP);

  maxLineBytes = 0;
  failedSendCount = 0;
  gpuCrashCount = 0;
  private cumulativeBytes = new Map<string, number>();
  private sampler: ReturnType<typeof setInterval> | null = null;
  private lastFailLogAt = 0;
  private runningSessionsProvider: () => string[] = () => [];

  setStatics(s: Partial<DiagStatics>): void {
    this.statics = { ...this.statics, ...s };
    this.rotateLog();
  }

  /** The agent router registers this so a crash report can say what was
   *  streaming to the renderer when it died. Kept as an injected getter to
   *  avoid window.ts depending on the router. */
  setRunningSessionsProvider(fn: () => string[]): void {
    this.runningSessionsProvider = fn;
  }

  /** Start periodic app.getAppMetrics() sampling. Returns a stop fn. */
  armMetricsSampler(getMetrics: () => RawProcessMetric[], intervalMs = 5000): () => void {
    this.stopMetricsSampler();
    const tick = () => {
      try {
        this.metrics.push({ t: new Date().toISOString(), rows: reduceAppMetrics(getMetrics()) });
      } catch (err) {
        console.error("[diag] metrics sample failed:", err);
      }
    };
    tick();
    this.sampler = setInterval(tick, intervalMs);
    this.sampler.unref?.();
    return () => this.stopMetricsSampler();
  }

  stopMetricsSampler(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  recordNav(event: string, url: string): void {
    const rec = { t: new Date().toISOString(), event, url };
    this.nav.push(rec);
    if (event === "did-finish-load") this.lastLoadAt = Date.now();
    console.error(`[diag] nav ${event} ${url}`);
  }

  /** A report pushed by the renderer over the diag_renderer_report channel. */
  recordRendererReport(payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    const t = new Date().toISOString();
    if (p.kind === "heap") {
      this.rendererHeap.push({
        t,
        usedMB: Number(p.usedMB) || 0,
        totalMB: Number(p.totalMB) || 0,
        limitMB: Number(p.limitMB) || 0,
      });
      return;
    }
    const kind = p.kind === "unhandledrejection" || p.kind === "react-boundary" ? p.kind : "error";
    const rec: RendererErrorRecord = {
      t,
      kind: kind as RendererErrorRecord["kind"],
      message: String(p.message ?? "(no message)"),
      stack: typeof p.stack === "string" ? p.stack : undefined,
      componentStack: typeof p.componentStack === "string" ? p.componentStack : undefined,
      url: typeof p.url === "string" ? p.url : undefined,
    };
    this.rendererErrors.push(rec);
    console.error(`[diag] renderer ${rec.kind}: ${rec.message}`);
    if (rec.stack) console.error(rec.stack);
    if (rec.componentStack) console.error(`component stack:${rec.componentStack}`);
  }

  /** Record one agent event line forwarded to the renderer. */
  recordForward(session: string, bytes: number): void {
    this.forwards.push({ t: new Date().toISOString(), session, bytes });
    if (bytes > this.maxLineBytes) this.maxLineBytes = bytes;
    this.cumulativeBytes.set(session, (this.cumulativeBytes.get(session) ?? 0) + bytes);
    if (bytes > LARGE_LINE_WARN_BYTES) {
      console.error(`[diag] large agent line: ${bytes} bytes for ${session}`);
    }
  }

  resetRunBytes(session: string): void {
    this.cumulativeBytes.delete(session);
  }

  noteSuccessfulSend(): void {
    this.failedSendCount = 0;
  }

  /** A webContents.send that threw (frame gone). Throttled so it can't flood. */
  noteFailedSend(err: unknown): void {
    this.failedSendCount += 1;
    const now = Date.now();
    if (now - this.lastFailLogAt > 2000) {
      this.lastFailLogAt = now;
      console.error(
        `[diag] agent send failed, renderer frame gone (x${this.failedSendCount} since last ok): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  noteGpuCrash(): void {
    this.gpuCrashCount += 1;
  }

  /** Build and emit the one-shot report for a terminal event. */
  report(
    trigger: string,
    opts: {
      reason?: string;
      exitCode?: number;
      detail?: Record<string, unknown>;
      rendererUrl?: string;
      runningSessions?: string[];
    } = {},
  ): void {
    let running: string[];
    try {
      running = opts.runningSessions ?? this.runningSessionsProvider();
    } catch {
      running = [];
    }
    const now = Date.now();
    const input: CrashReportInput = {
      t: new Date().toISOString(),
      trigger,
      reason: opts.reason,
      exitCode: opts.exitCode,
      detail: opts.detail,
      appVersion: this.statics.appVersion,
      electronVersion: this.statics.electronVersion,
      chromeVersion: this.statics.chromeVersion,
      uptimeMs: now - this.startedAt,
      msSinceLastLoad: this.lastLoadAt ? now - this.lastLoadAt : undefined,
      rendererUrl: opts.rendererUrl,
      mainMemory: process.memoryUsage(),
      metrics: this.metrics.toArray(),
      rendererHeap: this.rendererHeap.toArray(),
      rendererErrors: this.rendererErrors.toArray(),
      navTimeline: this.nav.toArray(),
      forwards: this.forwards.toArray(),
      runningSessions: running,
      cumulativeBytesBySession: Object.fromEntries(this.cumulativeBytes),
      maxLineBytes: this.maxLineBytes,
      failedSendCount: this.failedSendCount,
      gpuFeatureStatus: this.statics.gpuFeatureStatus,
      gpuCrashCount: this.gpuCrashCount,
      crashDumpsDir: this.statics.crashDumpsDir,
    };
    const text = formatCrashReport(input);
    console.error(text);
    this.appendLog(text);
  }

  private logPath(): string | null {
    return this.statics.userDataDir ? join(this.statics.userDataDir, "diag.log") : null;
  }

  private rotateLog(): void {
    const p = this.logPath();
    if (!p) return;
    try {
      if (statSync(p).size > DIAG_LOG_MAX_BYTES) truncateSync(p, 0);
    } catch {
      // no file yet -- fine
    }
  }

  private appendLog(text: string): void {
    const p = this.logPath();
    if (!p) return;
    try {
      mkdirSync(this.statics.userDataDir, { recursive: true });
      appendFileSync(p, `\n${text}\n`);
    } catch (err) {
      console.error("[diag] could not write diag.log:", err);
    }
  }

  /** For tests / manual inspection. */
  readDiagLog(): string {
    const p = this.logPath();
    if (!p) return "";
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }

  /** For tests. */
  reset(): void {
    this.stopMetricsSampler();
    this.metrics.clear();
    this.rendererHeap.clear();
    this.rendererErrors.clear();
    this.nav.clear();
    this.forwards.clear();
    this.maxLineBytes = 0;
    this.failedSendCount = 0;
    this.gpuCrashCount = 0;
    this.cumulativeBytes.clear();
    this.lastFailLogAt = 0;
    this.lastLoadAt = null;
    this.runningSessionsProvider = () => [];
    this.statics = {
      appVersion: "?",
      electronVersion: process.versions.electron ?? "?",
      chromeVersion: process.versions.chrome ?? "?",
      crashDumpsDir: "?",
      userDataDir: "",
    };
  }
}

export const diag = new Diag();
export { LARGE_LINE_WARN_BYTES };
