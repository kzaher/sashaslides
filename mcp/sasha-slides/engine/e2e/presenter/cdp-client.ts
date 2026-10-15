// A MINIMAL CHROME DEBUGGING PROTOCOL CLIENT over Node's own WebSocket, typed for exactly what the
// presenter's driver uses. chrome-remote-interface has no type definitions in this repository, and
// the engine adds no dependency without a line in SPEC.md, so the driver speaks the protocol
// directly: one browser connection, a page target attached with `flatten`, and sessions by id.
//
// Every wait has a short budget (project rule: fail fast, poll for observable state); a page load is
// awaited by subscribing to `Page.loadEventFired` BEFORE navigating, because the event does not fire
// twice for a page that already loaded.

export type ProtocolResult = Readonly<Record<string, unknown>>;

export class ChromeConnection implements Disposable {
  private nextId = 1;
  private readonly pending = new Map<number, Readonly<{ resolve: (result: ProtocolResult) => void; reject: (error: Error) => void }>>();
  private readonly listeners = new Set<(message: Readonly<{ method: string; sessionId: string | undefined; params: ProtocolResult }>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
  }

  static async open(options: Readonly<{ debuggingAddress: string }>): Promise<ChromeConnection> {
    const version = (await (await fetch(`${options.debuggingAddress}/json/version`)).json()) as Readonly<{ webSocketDebuggerUrl?: unknown }>;
    if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Chrome did not report a browser WebSocket address.");
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome.")), { once: true });
    });
    return new ChromeConnection(socket);
  }

  send(options: Readonly<{ method: string; params?: Readonly<Record<string, unknown>>; sessionId?: string; timeoutMilliseconds?: number }>): Promise<ProtocolResult> {
    const id = this.nextId;
    this.nextId += 1;
    const budget = options.timeoutMilliseconds ?? 5000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${options.method} did not answer within ${budget} milliseconds`));
      }, budget);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method: options.method, params: options.params ?? {}, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }));
    });
  }

  /** Resolves on the next `method` event of `sessionId`; subscribe BEFORE causing it. */
  nextEvent(options: Readonly<{ method: string; sessionId: string; timeoutMilliseconds: number }>): Promise<ProtocolResult> {
    return new Promise((resolve, reject) => {
      const listener = (message: Readonly<{ method: string; sessionId: string | undefined; params: ProtocolResult }>): void => {
        if (message.method !== options.method || message.sessionId !== options.sessionId) return;
        this.listeners.delete(listener);
        clearTimeout(timer);
        resolve(message.params);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`No ${options.method} within ${options.timeoutMilliseconds} milliseconds`));
      }, options.timeoutMilliseconds);
      this.listeners.add(listener);
    });
  }

  [Symbol.dispose](): void {
    for (const entry of this.pending.values()) entry.reject(new Error("The connection closed."));
    this.pending.clear();
    this.socket.close();
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as Readonly<{ id?: number; result?: ProtocolResult; error?: Readonly<{ message?: string }>; method?: string; sessionId?: string; params?: ProtocolResult }>;
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error.message ?? "protocol error"));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method === undefined) return;
    for (const listener of [...this.listeners]) listener({ method: message.method, sessionId: message.sessionId, params: message.params ?? {} });
  }
}

/** One tab the driver owns: opened blank, closed on dispose. */
export class ChromePage implements AsyncDisposable {
  private constructor(
    private readonly connection: ChromeConnection,
    private readonly targetId: string,
    readonly sessionId: string,
  ) {}

  static async open(options: Readonly<{ connection: ChromeConnection; width: number; height: number }>): Promise<ChromePage> {
    const created = await options.connection.send({ method: "Target.createTarget", params: { url: "about:blank", background: false } });
    const targetId = String(created["targetId"]);
    const attached = await options.connection.send({ method: "Target.attachToTarget", params: { targetId, flatten: true } });
    const page = new ChromePage(options.connection, targetId, String(attached["sessionId"]));
    await page.command("Page.enable");
    await page.command("Runtime.enable");
    await page.command("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
    await page.command("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.command("Page.bringToFront");
    return page;
  }

  command(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<ProtocolResult> {
    return this.connection.send({ method, params, sessionId: this.sessionId });
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.connection.nextEvent({ method: "Page.loadEventFired", sessionId: this.sessionId, timeoutMilliseconds: 8000 });
    await this.command("Page.navigate", { url });
    await loaded;
  }

  async evaluate<TValue>(expression: string): Promise<TValue> {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const exception = result["exceptionDetails"];
    if (exception !== undefined) throw new Error(`Evaluation failed: ${JSON.stringify(exception).slice(0, 400)}`);
    const remote = result["result"] as Readonly<{ value?: unknown }> | undefined;
    // returnByValue: the protocol hands back the JSON value the expression produced; callers name its type.
    return remote?.value as TValue;
  }

  /** Polls `expression` every 25 milliseconds until it is truthy; returns that value. */
  async waitFor<TValue>(options: Readonly<{ expression: string; what: string; timeoutMilliseconds: number }>): Promise<TValue> {
    const deadline = Date.now() + options.timeoutMilliseconds;
    for (;;) {
      const value = await this.evaluate<TValue>(options.expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out after ${options.timeoutMilliseconds} milliseconds waiting for ${options.what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async screenshot(): Promise<Buffer> {
    const shot = await this.command("Page.captureScreenshot", { format: "png" });
    return Buffer.from(String(shot["data"]), "base64");
  }

  async pressKey(key: string): Promise<void> {
    const code = KEY_CODES[key] ?? { code: key, keyCode: 0 };
    for (const type of ["keyDown", "keyUp"]) {
      await this.command("Input.dispatchKeyEvent", { type, key, code: code.code, windowsVirtualKeyCode: code.keyCode, nativeVirtualKeyCode: code.keyCode });
    }
  }

  async movePointer(options: Readonly<{ x: number; y: number }>): Promise<void> {
    await this.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: options.x, y: options.y });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.connection.send({ method: "Target.closeTarget", params: { targetId: this.targetId } }).catch(() => undefined);
  }
}

const KEY_CODES: Readonly<Record<string, Readonly<{ code: string; keyCode: number }>>> = {
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  Escape: { code: "Escape", keyCode: 27 },
};
