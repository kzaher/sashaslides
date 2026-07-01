// Boundary-only types for `chrome-remote-interface`, which ships no .d.ts
// (its default export is declared `unknown` in types/ambient.d.ts). These
// interfaces mirror the documented runtime shapes of the CDP domains/static
// methods these presentation scripts actually invoke, narrowed here at the
// import boundary so no `any` leaks into the scripts themselves.

export interface CDPEvaluateResult<T = unknown> {
  result: { value?: T; description?: string };
  exceptionDetails?: unknown;
}

export interface CDPRuntime {
  enable(): Promise<unknown>;
  evaluate<T = unknown>(opts: {
    expression: string;
    returnByValue?: boolean;
    awaitPromise?: boolean;
  }): Promise<CDPEvaluateResult<T>>;
}

export interface CDPInput {
  dispatchKeyEvent(opts: Record<string, unknown>): Promise<unknown>;
  dispatchMouseEvent(opts: Record<string, unknown>): Promise<unknown>;
  insertText(opts: { text: string }): Promise<unknown>;
}

export interface CDPScreenshotResult {
  data: string;
}

export interface CDPPage {
  enable(): Promise<unknown>;
  navigate(opts: { url: string }): Promise<unknown>;
  captureScreenshot(opts?: {
    format?: string;
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
  }): Promise<CDPScreenshotResult>;
}

export interface CDPTargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface CDPTargetDomain {
  setDiscoverTargets(opts: { discover: boolean }): Promise<unknown>;
  getTargets(): Promise<{ targetInfos: CDPTargetInfo[] }>;
  activateTarget(opts: { targetId: string }): Promise<unknown>;
}

export interface CDPClient {
  Runtime: CDPRuntime;
  Input: CDPInput;
  Page: CDPPage;
  Target: CDPTargetDomain;
  close(): Promise<void>;
}

export interface CDPListEntry {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// The default export of `chrome-remote-interface` is the connect-fn; `List` /
// `New` / `Close` are runtime-attached static methods.
export interface CDPStatic {
  (opts: { target?: CDPListEntry; port?: number }): Promise<CDPClient>;
  List(opts: { port: number }): Promise<CDPListEntry[]>;
  New(opts: { port: number; url?: string }): Promise<CDPListEntry>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
