/**
 * cdp.ts — typed boundary for the untyped `chrome-remote-interface` default
 * export.
 *
 * `chrome-remote-interface` ships no `.d.ts`, so `types/ambient.d.ts` declares
 * its default export as `unknown`. This module narrows that import ONCE into a
 * precise, hand-written interface (`CDPModule`) that mirrors the documented
 * runtime contract for the subset of the CDP domains the presentation scripts
 * actually use. Scripts import `cdp` from here instead of the raw module so
 * every call site is fully typed.
 *
 * See https://github.com/cyrus-and/chrome-remote-interface for the runtime API.
 */

import CDPDefault from "chrome-remote-interface";

/** A debugging target as returned by `CDP.List` / `CDP.New`. */
export interface CDPTarget {
  id: string;
  type: string;
  url: string;
  /** Present on `/json/list` entries; used to reconnect to a specific tab. */
  webSocketDebuggerUrl?: string;
}

/** The dynamic value returned by `Runtime.evaluate`. Callers narrow `value`. */
export interface CDPEvaluateResult {
  result: { value?: unknown; description?: string };
  exceptionDetails?: unknown;
}

export interface CDPEvaluateParams {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export interface CDPRuntime {
  enable(): Promise<unknown>;
  evaluate(params: CDPEvaluateParams): Promise<CDPEvaluateResult>;
}

export interface CDPKeyEventParams {
  type: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
  text?: string;
}

export interface CDPMouseEventParams {
  type: string;
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
}

export interface CDPInput {
  dispatchKeyEvent(params: CDPKeyEventParams): Promise<unknown>;
  dispatchMouseEvent(params: CDPMouseEventParams): Promise<unknown>;
  insertText(params: { text: string }): Promise<unknown>;
}

export interface CDPScreenshotParams {
  format?: string;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  captureBeyondViewport?: boolean;
}

export interface CDPPage {
  enable(): Promise<unknown>;
  reload(params?: { ignoreCache?: boolean }): Promise<unknown>;
  navigate(params: { url: string }): Promise<unknown>;
  loadEventFired(): Promise<unknown>;
  captureScreenshot(params?: CDPScreenshotParams): Promise<{ data: string }>;
}

export interface CDPDeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export interface CDPEmulation {
  setDeviceMetricsOverride(params: CDPDeviceMetrics): Promise<unknown>;
  setDefaultBackgroundColorOverride(params: {
    color: { r: number; g: number; b: number; a: number };
  }): Promise<unknown>;
}

export interface CDPTargetDomain {
  activateTarget(params: { targetId: string }): Promise<unknown>;
}

export interface CDPClient {
  Runtime: CDPRuntime;
  Input: CDPInput;
  Page: CDPPage;
  Emulation: CDPEmulation;
  Target: CDPTargetDomain;
  close(): Promise<void>;
}

export interface CDPConnectOptions {
  /** A target object, or a target's webSocketDebuggerUrl string. */
  target?: CDPTarget | string;
  port?: number;
}

/**
 * The `chrome-remote-interface` default export: callable to open a client
 * connection, with `List` / `New` / `Close` runtime-attached static methods.
 */
export interface CDPModule {
  (options?: CDPConnectOptions): Promise<CDPClient>;
  List(options: { port: number }): Promise<CDPTarget[]>;
  New(options: { port: number; url?: string }): Promise<CDPTarget>;
  Close(options: { port: number; id: string }): Promise<unknown>;
}

// SAFETY: the ambient declaration types the default export as `unknown`
// (untyped JS module). This is the single boundary assertion that maps it onto
// the documented runtime contract above; every script consumes the typed form.
export const cdp: CDPModule = CDPDefault as CDPModule;
