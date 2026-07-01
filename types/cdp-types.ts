/**
 * cdp-types.ts — precise, type-only boundary declarations for the subset of the
 * Chrome DevTools Protocol surface that this repo's scripts actually touch via
 * `chrome-remote-interface` (which ships no .d.ts; see types/ambient.d.ts where
 * its default export is `unknown`).
 *
 * Import these as TYPES only and assert the untyped default export once, e.g.:
 *   import CDPraw from "chrome-remote-interface";
 *   import type { CdpModule } from "../../types/cdp-types.ts";
 *   const CDP = CDPraw as CdpModule;
 *
 * Every interface mirrors the documented runtime contract of the methods we
 * call — it is intentionally a narrow view, not the full protocol.
 */

/** A DevTools target (tab) as returned by CDP.New / CDP.List. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Options accepted by the callable default export to open a connection. */
export interface CdpConnectOptions {
  target?: CdpTarget | string;
  host?: string;
  port?: number;
}

export interface CdpEvaluateParams {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

/** Result envelope of Runtime.evaluate — `value` is untyped JSON from the page. */
export interface CdpRemoteResult {
  result: { value: unknown };
  exceptionDetails?: unknown;
}

/** A remote object as it appears in a console-API / exception payload. */
export interface CdpRemoteObject {
  value?: unknown;
  description?: string;
  preview?: unknown;
}

/** Payload of the Runtime.consoleAPICalled event. */
export interface CdpConsoleApiEvent {
  type: string;
  args: CdpRemoteObject[];
}

export interface CdpExceptionDetails {
  exception?: { description?: string };
  text: string;
}

/** Payload of the Runtime.exceptionThrown event. */
export interface CdpExceptionThrownEvent {
  exceptionDetails: CdpExceptionDetails;
}

export interface CdpRuntime {
  evaluate(params: CdpEvaluateParams): Promise<CdpRemoteResult>;
  enable(): Promise<void>;
  consoleAPICalled(listener: (event: CdpConsoleApiEvent) => void): void;
  exceptionThrown(listener: (event: CdpExceptionThrownEvent) => void): void;
}

export interface CdpKeyEventParams {
  type: string;
  key?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
}

export interface CdpMouseEventParams {
  type: string;
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
}

export interface CdpInput {
  dispatchKeyEvent(params: CdpKeyEventParams): Promise<void>;
  dispatchMouseEvent(params: CdpMouseEventParams): Promise<void>;
}

export interface CdpScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export interface CdpScreenshotParams {
  format?: string;
  quality?: number;
  clip?: CdpScreenshotClip;
  captureBeyondViewport?: boolean;
  omitBackground?: boolean;
}

export interface CdpPage {
  enable(): Promise<void>;
  captureScreenshot(params?: CdpScreenshotParams): Promise<{ data: string }>;
  navigate(params: { url: string }): Promise<unknown>;
  reload(params?: { ignoreCache?: boolean }): Promise<unknown>;
  loadEventFired(): Promise<unknown>;
}

export interface CdpBrowser {
  grantPermissions(params: { origin: string; permissions: string[] }): Promise<void>;
}

export interface CdpTargetDomain {
  setDiscoverTargets(params: { discover: boolean }): Promise<void>;
  activateTarget(params: { targetId: string }): Promise<void>;
}

export interface CdpDeviceMetricsParams {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export interface CdpEmulation {
  setDeviceMetricsOverride(params: CdpDeviceMetricsParams): Promise<void>;
}

/** A connected CDP client (the resolved value of calling the default export). */
export interface CdpClient {
  Runtime: CdpRuntime;
  Input: CdpInput;
  Page: CdpPage;
  Target: CdpTargetDomain;
  Emulation: CdpEmulation;
  Browser: CdpBrowser;
  on(event: string, listener: (params: unknown) => void): void;
  close(): Promise<void>;
}

/**
 * The `chrome-remote-interface` default export: a connect-function with the
 * runtime-attached static helpers New / Close / List.
 */
export interface CdpModule {
  (opts?: CdpConnectOptions): Promise<CdpClient>;
  New(opts: { port: number; url?: string }): Promise<CdpTarget>;
  Close(opts: { port: number; id: string }): Promise<void>;
  List(opts: { port: number }): Promise<CdpTarget[]>;
}
