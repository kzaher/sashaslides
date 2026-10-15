// The slice of chrome-remote-interface (no published types) the editor's end-to-end drivers use,
// typed at the boundary so nothing past it is `any`. Parameters follow the Chrome DevTools Protocol.

declare module "chrome-remote-interface" {
  type EventWaiter<TParameters> = () => Promise<TParameters>;

  export type EvaluateResult = Readonly<{ result: Readonly<{ value?: unknown; description?: string }>; exceptionDetails?: Readonly<{ text: string; exception?: Readonly<{ description?: string }> }> }>;

  export interface Client {
    Page: {
      enable(): Promise<void>;
      navigate(parameters: Readonly<{ url: string }>): Promise<unknown>;
      loadEventFired: EventWaiter<unknown>;
      captureScreenshot(parameters: Readonly<{ format: "png"; captureBeyondViewport?: boolean }>): Promise<Readonly<{ data: string }>>;
      bringToFront(): Promise<void>;
    };
    Runtime: {
      enable(): Promise<void>;
      evaluate(parameters: Readonly<{ expression: string; awaitPromise?: boolean; returnByValue?: boolean }>): Promise<EvaluateResult>;
    };
    Emulation: {
      setDeviceMetricsOverride(parameters: Readonly<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }>): Promise<void>;
      setEmulatedMedia(parameters: Readonly<{ features: readonly Readonly<{ name: string; value: string }>[] }>): Promise<void>;
    };
    Input: {
      dispatchMouseEvent(parameters: Readonly<{ type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "none" | "right"; buttons?: number; clickCount?: number }>): Promise<void>;
      dispatchKeyEvent(parameters: Readonly<{ type: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key?: string; code?: string; text?: string; windowsVirtualKeyCode?: number; modifiers?: number }>): Promise<void>;
      insertText(parameters: Readonly<{ text: string }>): Promise<void>;
    };
    close(): Promise<void>;
  }

  export type ConnectionOptions = Readonly<{ host?: string; port?: number; target?: string }>;
  export type Target = Readonly<{ id: string }>;

  interface Connect {
    (options: ConnectionOptions): Promise<Client>;
    New(options: ConnectionOptions & Readonly<{ url?: string }>): Promise<Target>;
    Close(options: ConnectionOptions & Readonly<{ id: string }>): Promise<void>;
  }

  const CDP: Connect;
  export default CDP;
}
