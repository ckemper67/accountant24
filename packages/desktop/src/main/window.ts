import path from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";
import { diag } from "./diag";
import { isInternalNavigation, isOpenableExternalUrl, rendererCsp } from "./urls";
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, restoreWindowState, trackWindowState } from "./window-state";

// Device-local UI state, so it lives in Electron's per-app userData dir,
// not in the (portable) Accountant24 workspace.
const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");

/** Create the single app window. macOS chrome mirrors the old Tauri config:
 *  inset traffic lights, no native title bar; the renderer paints the top strip.
 *  Size/placement policy lives in window-state.ts: first launch large and
 *  centered on the active display, afterwards wherever the user left it. */
export function createWindow(): BrowserWindow {
  // The display the user is working on (cursor), not necessarily the primary.
  const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const state = restoreWindowState(loadWindowState(windowStateFile()), workAreas, active);

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      // ESM preload (electron-vite emits index.mjs under "type":"module"); ESM
      // preload requires sandbox:false (set below).
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    // Maximize only here: on a still-hidden window it can force an early show.
    if (state.maximized) win.maximize();
    win.show();
  });
  trackWindowState(win, windowStateFile());
  installRendererDiagnostics(win);

  // Links (target=_blank / window.open) never open as app windows. Only
  // http/https/mailto reach the system browser; every other scheme (file:,
  // javascript:, custom app schemes, …) is refused, so a link in untrusted
  // agent/markdown output can't make the OS launch a local handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  // The app frame must never navigate off its own origin (e.g. a link with
  // target=_self). Same-origin navigations/reloads pass; an off-origin http(s)
  // target is opened externally instead, anything else is simply blocked.
  win.webContents.on("will-navigate", (event, url) => {
    if (isInternalNavigation(url, win.webContents.getURL())) return;
    event.preventDefault();
    if (isOpenableExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // Packaged build serves static file:// content — lock the renderer down with
    // a Content-Security-Policy (dev skips this to keep Vite HMR working).
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [rendererCsp()] },
      });
    });
    void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }

  return win;
}

/** Attach renderer-blank / crash instrumentation to a window. Observability
 *  only -- these handlers never change what the app does, they record why the
 *  renderer went away so one reproduction is enough (see diag.ts). Every body
 *  is defensive: a broken handler must not take the window down.
 *
 *  Electron has churned these event signatures across majors, so each handler
 *  parses its args loosely (object form or legacy positional form). */
function installRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents;
  // webContents extends EventEmitter; the loose view lets these handlers accept
  // whichever arg shape the running Electron passes without fighting the typed
  // per-event overloads (which have changed across majors).
  const on = (event: string, listener: (...args: unknown[]) => void): void => {
    (wc as unknown as NodeJS.EventEmitter).on(event, listener);
  };
  const urlNow = () => {
    try {
      return wc.isDestroyed() ? "(destroyed)" : wc.getURL();
    } catch {
      return "(unknown)";
    }
  };
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error("[diag] handler threw:", err);
    }
  };

  on("render-process-gone", (_e, details) => {
    guard(() =>
      diag.report("render-process-gone", {
        reason: (details as { reason?: string }).reason,
        exitCode: (details as { exitCode?: number }).exitCode,
        rendererUrl: urlNow(),
      }),
    );
  });

  let unresponsiveAt = 0;
  on("unresponsive", () => {
    unresponsiveAt = Date.now();
    console.error("[diag] renderer unresponsive (main thread wedged)");
    guard(() => diag.report("unresponsive", { rendererUrl: urlNow() }));
  });
  on("responsive", () => {
    console.error(`[diag] renderer responsive again after ${unresponsiveAt ? Date.now() - unresponsiveAt : 0}ms`);
  });

  on("did-fail-load", (...args: unknown[]) => {
    // Legacy positional: (event, errorCode, errorDescription, validatedURL, isMainFrame).
    const [, errorCode, errorDescription, validatedURL, isMainFrame] = args as [
      unknown,
      number,
      string,
      string,
      boolean,
    ];
    diag.recordNav("did-fail-load", `${validatedURL} (${errorCode} ${errorDescription})`);
    // -3 is ERR_ABORTED (a superseded navigation) -- not a failure.
    if (isMainFrame && errorCode !== -3) {
      guard(() =>
        diag.report("did-fail-load", {
          detail: { errorCode, errorDescription, validatedURL, isMainFrame },
          rendererUrl: urlNow(),
        }),
      );
    }
  });

  const navUrl = (args: unknown[]): string => {
    const first = args[0] as { url?: string } | undefined;
    if (first && typeof first.url === "string") return first.url; // object form
    return typeof args[1] === "string" ? args[1] : urlNow(); // legacy positional
  };
  on("did-start-navigation", (...args: unknown[]) => diag.recordNav("did-start-navigation", navUrl(args)));
  on("did-finish-load", () => diag.recordNav("did-finish-load", urlNow()));
  on("dom-ready", () => diag.recordNav("dom-ready", urlNow()));

  on("preload-error", (_e, preloadPath, error) => {
    console.error(`[diag] preload error in ${preloadPath}:`, error);
    diag.recordRendererReport({
      kind: "error",
      message: `preload-error: ${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      url: preloadPath,
    });
  });

  if (!app.isPackaged) {
    on("console-message", (...args: unknown[]) => {
      // Electron 42 object form: { level: "warning"|"error"|..., message, lineNumber, sourceId }.
      // Legacy positional: (event, level:number, message, line, sourceId).
      const obj = args[0] as { level?: unknown; message?: string; sourceId?: string; lineNumber?: number } | undefined;
      let level: string;
      let message: string;
      let source: string;
      if (obj && typeof obj === "object" && "message" in obj) {
        level = String(obj.level ?? "");
        message = String(obj.message ?? "");
        source = `${obj.sourceId ?? ""}:${obj.lineNumber ?? ""}`;
      } else {
        const [, lvl, msg, line, sourceId] = args as [unknown, number, string, number, string];
        level = lvl >= 3 ? "error" : lvl === 2 ? "warning" : "info";
        message = msg;
        source = `${sourceId}:${line}`;
      }
      if (level === "error" || level === "warning") {
        console.error(`[diag] renderer console.${level} (${source}): ${message}`);
      }
    });
  }
}
