import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// window.ts creates the single app window and wires its security policy:
// hardened webPreferences, an external-only window-open handler, an
// off-origin-blocking will-navigate guard, and a CSP for packaged builds —
// plus the window-state policy (first launch centered on the active
// display, saved state restored after). Electron (BrowserWindow + screen +
// app + shell) is the faked boundary; the real ./urls and ./window-state
// helpers make the actual decisions (pure and separately tested), so this
// suite verifies the wiring, not a re-mock of them.

type Fn = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  ctorOpts: undefined as Record<string, unknown> | undefined,
  show: vi.fn(),
  maximize: vi.fn(),
  once: new Map<string, Fn>(),
  winOn: new Map<string, Fn>(),
  on: new Map<string, Fn>(),
  windowOpenHandler: undefined as ((d: { url: string }) => { action: string }) | undefined,
  onHeadersReceived: undefined as ((details: unknown, cb: Fn) => void) | undefined,
  currentUrl: "app://index/",
  loadURL: vi.fn(() => Promise.resolve()),
  loadFile: vi.fn(() => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
  // One display: a 2000×1200 work area below a 25px menu bar.
  workArea: { x: 0, y: 25, width: 2000, height: 1200 },
  userDataDir: "",
}));

class FakeBrowserWindow {
  webContents = {
    setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => {
      h.windowOpenHandler = fn;
    },
    on: (evt: string, fn: Fn) => {
      h.on.set(evt, fn);
    },
    getURL: () => h.currentUrl,
    session: {
      webRequest: {
        onHeadersReceived: (fn: (details: unknown, cb: Fn) => void) => {
          h.onHeadersReceived = fn;
        },
      },
    },
  };
  loadURL = h.loadURL;
  loadFile = h.loadFile;
  show = h.show;
  maximize = h.maximize;
  once = (evt: string, fn: Fn) => {
    h.once.set(evt, fn);
  };
  on = (evt: string, fn: Fn) => {
    h.winOn.set(evt, fn);
  };
  getNormalBounds = () => ({
    x: (h.ctorOpts?.x as number) ?? 0,
    y: (h.ctorOpts?.y as number) ?? 0,
    width: (h.ctorOpts?.width as number) ?? 0,
    height: (h.ctorOpts?.height as number) ?? 0,
  });
  isMaximized = () => false;
  isFullScreen = () => false;
  constructor(opts: Record<string, unknown>) {
    h.ctorOpts = opts;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  shell: { openExternal: h.openExternal },
  app: { getPath: () => h.userDataDir, isPackaged: false },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: h.workArea }),
    getAllDisplays: () => [{ workArea: h.workArea }],
  },
}));

let prevRendererUrl: string | undefined;

async function createWindow() {
  const { createWindow } = await import("../window");
  return createWindow();
}

const stateFile = () => path.join(h.userDataDir, "window-state.json");

beforeEach(() => {
  prevRendererUrl = process.env.ELECTRON_RENDERER_URL;
  h.ctorOpts = undefined;
  h.once.clear();
  h.winOn.clear();
  h.on.clear();
  h.windowOpenHandler = undefined;
  h.onHeadersReceived = undefined;
  h.currentUrl = "app://index/";
  h.show.mockClear();
  h.maximize.mockClear();
  h.loadURL.mockClear();
  h.loadFile.mockClear();
  h.openExternal.mockClear();
  h.userDataDir = mkdtempSync(path.join(tmpdir(), "a24-window-test-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(h.userDataDir, { recursive: true, force: true });
  if (prevRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
  else process.env.ELECTRON_RENDERER_URL = prevRendererUrl;
});

describe("createWindow()", () => {
  describe("window preferences", () => {
    it("should harden webPreferences (context isolation on, node integration off, sandbox off for ESM preload)", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      const web = h.ctorOpts?.webPreferences as Record<string, unknown>;
      expect(web.contextIsolation).toBe(true);
      expect(web.nodeIntegration).toBe(false);
      expect(web.sandbox).toBe(false);
      expect(String(web.preload)).toMatch(/preload[/\\]index\.mjs$/);
    });

    it("should open first launch centered on the active display at the capped default size", async () => {
      // 2000×1200 work area at y=25: 80% → 1600 wide (at the cap) × 960, centered.
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      expect(h.ctorOpts).toMatchObject({
        x: 200,
        y: 145,
        width: 1600,
        height: 960,
        minWidth: 560,
        minHeight: 480,
        show: false,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 14 },
      });
    });
  });

  describe("window state", () => {
    it("should reopen at the saved bounds when they are still on a display", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      writeFileSync(stateFile(), JSON.stringify({ x: 40, y: 50, width: 900, height: 700 }));
      await createWindow();
      expect(h.ctorOpts).toMatchObject({ x: 40, y: 50, width: 900, height: 700 });
    });

    it("should fall back to the centered default when the saved bounds are off-screen", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      writeFileSync(stateFile(), JSON.stringify({ x: 9000, y: 9000, width: 900, height: 700 }));
      await createWindow();
      expect(h.ctorOpts).toMatchObject({ x: 200, y: 145, width: 1600, height: 960 });
    });

    it("should re-maximize on ready-to-show when the window was left maximized", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      writeFileSync(stateFile(), JSON.stringify({ x: 40, y: 50, width: 900, height: 700, maximized: true }));
      await createWindow();
      expect(h.maximize).not.toHaveBeenCalled();
      h.once.get("ready-to-show")?.();
      expect(h.maximize).toHaveBeenCalledTimes(1);
      expect(h.show).toHaveBeenCalledTimes(1);
    });

    it("should not maximize a window that was left normal", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      h.once.get("ready-to-show")?.();
      expect(h.maximize).not.toHaveBeenCalled();
    });

    it("should persist the window bounds when the window closes", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      h.winOn.get("close")?.();
      expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({
        x: 200,
        y: 145,
        width: 1600,
        height: 960,
        maximized: false,
      });
    });
  });

  describe("ready-to-show", () => {
    it("should show the window only once it is ready-to-show", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      expect(h.show).not.toHaveBeenCalled();
      h.once.get("ready-to-show")?.();
      expect(h.show).toHaveBeenCalledTimes(1);
    });
  });

  describe("window-open handler", () => {
    it("should deny every popup and open an http(s) target in the system browser instead", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      const result = h.windowOpenHandler?.({ url: "https://example.com/docs" });
      expect(result).toEqual({ action: "deny" });
      expect(h.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    });

    it("should deny and NOT hand a non-openable scheme to the OS", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      const result = h.windowOpenHandler?.({ url: "file:///etc/passwd" });
      expect(result).toEqual({ action: "deny" });
      expect(h.openExternal).not.toHaveBeenCalled();
    });
  });

  describe("will-navigate guard", () => {
    it("should allow a same-origin navigation without blocking or opening it externally", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      h.currentUrl = "https://app.local/home";
      const event = { preventDefault: vi.fn() };
      h.on.get("will-navigate")?.(event, "https://app.local/settings");
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(h.openExternal).not.toHaveBeenCalled();
    });

    it("should block an off-origin http(s) navigation and open it externally instead", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      h.currentUrl = "https://app.local/home";
      const event = { preventDefault: vi.fn() };
      h.on.get("will-navigate")?.(event, "https://evil.example/phish");
      expect(event.preventDefault).toHaveBeenCalled();
      expect(h.openExternal).toHaveBeenCalledWith("https://evil.example/phish");
    });

    it("should block an off-origin non-openable navigation without handing it to the OS", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      h.currentUrl = "https://app.local/home";
      const event = { preventDefault: vi.fn() };
      h.on.get("will-navigate")?.(event, "file:///etc/passwd");
      expect(event.preventDefault).toHaveBeenCalled();
      expect(h.openExternal).not.toHaveBeenCalled();
    });
  });

  describe("renderer diagnostics wiring", () => {
    let errs: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      errs = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
    });

    afterEach(() => {
      errs.mockRestore();
    });

    /** The single crash-report blob printed to console.error, or "". */
    const reportText = () =>
      String(
        errs.mock.calls
          .map((c: unknown[]) => c[0])
          .find((a: unknown) => String(a).includes("[diag] renderer/crash report")) ?? "",
      );

    it("should print a crash report naming the reason when the render process goes", () => {
      h.on.get("render-process-gone")?.(null, { reason: "oom", exitCode: 5 });
      const report = reportText();
      expect(report).toContain("trigger         render-process-gone");
      expect(report).toContain("reason          oom");
    });

    it("should report and log an unresponsive renderer, then note recovery", () => {
      h.on.get("unresponsive")?.();
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer unresponsive"))).toBe(true);
      expect(reportText()).toContain("trigger         unresponsive");
      h.on.get("responsive")?.();
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer responsive again"))).toBe(true);
    });

    it("should record navigations and surface them in a later crash report timeline", () => {
      h.on.get("did-start-navigation")?.({ url: "app://index/#/chat" });
      h.on.get("did-finish-load")?.();
      h.on.get("render-process-gone")?.(null, { reason: "crashed" });
      const report = reportText();
      expect(report).toContain("did-start-navigation");
      expect(report).toContain("app://index/#/chat");
      expect(report).toContain("did-finish-load");
    });

    it("should NOT raise a crash report for an aborted load (errorCode -3)", () => {
      h.on.get("did-fail-load")?.(null, -3, "ERR_ABORTED", "app://index/", true);
      expect(reportText()).toBe("");
    });

    it("should raise a crash report for a real main-frame load failure", () => {
      h.on.get("did-fail-load")?.(null, -105, "ERR_NAME_NOT_RESOLVED", "app://index/", true);
      expect(reportText()).toContain("trigger         did-fail-load");
      expect(reportText()).toContain("ERR_NAME_NOT_RESOLVED");
    });

    it("should forward a preload error to the diagnostics log", () => {
      h.on.get("preload-error")?.(null, "/app/preload/index.mjs", new Error("bad import"));
      expect(
        errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("preload error in /app/preload/index.mjs")),
      ).toBe(true);
    });

    it("should stringify a non-Error preload-error value", () => {
      h.on.get("preload-error")?.(null, "/app/preload/index.mjs", "not an Error instance");
      h.on.get("render-process-gone")?.(null, { reason: "crashed" });
      expect(reportText()).toContain("preload-error: not an Error instance");
    });

    it("should surface renderer console errors (legacy positional signature)", () => {
      h.on.get("console-message")?.(null, 3, "ReferenceError: x is not defined", 12, "app://index/bundle.js");
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer console.error"))).toBe(true);
    });

    it("should surface renderer console warnings (legacy positional signature)", () => {
      h.on.get("console-message")?.(null, 2, "deprecated call", 3, "app://index/bundle.js");
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer console.warning"))).toBe(true);
    });

    it("should surface renderer console warnings (object signature)", () => {
      h.on.get("console-message")?.({
        level: "warning",
        message: "deprecated API",
        sourceId: "app://index/bundle.js",
        lineNumber: 5,
      });
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer console.warning"))).toBe(true);
    });

    it("should ignore renderer console info", () => {
      h.on.get("console-message")?.(null, 0, "just chatter", 1, "x");
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("renderer console."))).toBe(false);
    });

    it("should log rather than crash the window when a handler body throws", () => {
      // A details object whose `reason` getter throws simulates a handler
      // failing partway through -- the window must survive it.
      const poison = {
        get reason() {
          throw new Error("boom");
        },
      };
      expect(() => h.on.get("render-process-gone")?.(null, poison)).not.toThrow();
      expect(errs.mock.calls.some((c: unknown[]) => String(c[0]).includes("[diag] handler threw"))).toBe(true);
    });

    it("should read the navigation URL from the legacy positional argument", () => {
      h.on.get("did-start-navigation")?.(null, "app://index/#/legacy");
      h.on.get("render-process-gone")?.(null, { reason: "crashed" });
      expect(reportText()).toContain("app://index/#/legacy");
    });

    it("should fall back to the current URL when did-start-navigation carries neither form", () => {
      h.on.get("did-start-navigation")?.();
      h.on.get("render-process-gone")?.(null, { reason: "crashed" });
      expect(reportText()).toContain("did-start-navigation");
    });
  });

  describe("content loading", () => {
    it("should load the dev renderer URL and apply no CSP when ELECTRON_RENDERER_URL is set", async () => {
      process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
      await createWindow();
      expect(h.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
      expect(h.loadFile).not.toHaveBeenCalled();
      expect(h.onHeadersReceived).toBeUndefined();
    });

    it("should load the packaged index.html and enforce a locked-down CSP when no dev URL is set", async () => {
      delete process.env.ELECTRON_RENDERER_URL;
      await createWindow();
      expect(h.loadFile).toHaveBeenCalledTimes(1);
      expect(String((h.loadFile.mock.calls[0] as unknown[])[0])).toMatch(/renderer[/\\]index\.html$/);
      expect(h.loadURL).not.toHaveBeenCalled();
      expect(h.onHeadersReceived).toBeTypeOf("function");

      const captured: { responseHeaders?: Record<string, string[]> } = {};
      h.onHeadersReceived?.({ responseHeaders: { "X-Existing": ["1"] } }, (r: unknown) => {
        Object.assign(captured, r);
      });
      const csp = captured.responseHeaders?.["Content-Security-Policy"]?.[0] ?? "";
      // Spec: the packaged renderer is locked to its own origin.
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      // Pre-existing headers are preserved, not dropped.
      expect(captured.responseHeaders?.["X-Existing"]).toEqual(["1"]);
    });
  });
});
