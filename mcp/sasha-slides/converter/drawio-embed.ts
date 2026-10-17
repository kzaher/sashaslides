/**
 * drawio-embed.ts — the self-hosted draw.io editor (`https://sashaslides.com/drawio/`) driven over
 * its JSON embed protocol, for every browser surface that needs a diagram drawn or edited: the
 * converter's `renderDrawio` (the add-on's candidates window and the developer page), and the
 * add-on's diagram dialog.
 *
 * THE PROTOCOL (https://www.drawio.com/doc/faq/embed-mode, measured on the vendored editor by
 * renderer/html2slides/e2e/drawio-editor.e2e.ts): the frame posts JSON STRINGS.
 *   frame  -> {event:"init"}                               ready for a diagram
 *   parent -> {action:"load", xml, autosave}               (or xmlpng: a data: PNG with an mxfile chunk)
 *   frame  -> {event:"load", xml}                          shown (not always sent: see renderDrawioPicture)
 *   parent -> {action:"export", format, scale?, spin?}     "xmlpng" | "xmlsvg" | "png" | "svg"
 *   frame  -> {event:"export", data, format, xml}          data is a data: address
 *   frame  -> {event:"save", xml, exit?}                   the person pressed Save (or Save & Exit)
 *   frame  -> {event:"exit", modified}                     the person closed the editor
 *
 * The address keeps its TRAILING SLASH: index.html loads `js/…` relatively.
 */

export type DrawioExportFormat = "xmlpng" | "xmlsvg" | "png" | "svg";

export type DrawioEvent =
  | Readonly<{ kind: "init" }>
  | Readonly<{ kind: "load"; xml: string | null }>
  | Readonly<{ kind: "export"; data: string; format: string | null; xml: string | null }>
  | Readonly<{ kind: "save"; xml: string; exit: boolean }>
  | Readonly<{ kind: "exit"; modified: boolean }>
  | Readonly<{ kind: "autosave"; xml: string }>;

export type DrawioAction =
  | Readonly<{ action: "load"; xml: string; autosave: 0 | 1; title?: string }>
  | Readonly<{ action: "load"; xmlpng: string; autosave: 0 | 1; title?: string }>
  | Readonly<{ action: "export"; format: DrawioExportFormat; scale?: number; border?: number; spin?: string }>
  | Readonly<{ action: "status"; message: string; modified: boolean }>
  | Readonly<{ action: "spinner"; message: string; show: boolean }>;

export type DrawioPicture = Readonly<{
  /** `data:image/png;base64,…` (the PNG carries the mxfile chunk). */
  pngDataUrl: string;
  /** draw.io's editable SVG (`content=` holds the source), as text. */
  svg: string;
  /** The source the editor ended with. */
  xml: string;
}>;

export type DrawioRender =
  | Readonly<{ kind: "rendered"; picture: DrawioPicture }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** Default render scale: 1x is blurry once Slides scales a full-slide picture up. */
export const DRAWIO_RENDER_SCALE = 3;
/** The editor cold-starts in 2-6 s on a warm cache; past this it is stuck, not slow. */
export const DRAWIO_RENDER_TIMEOUT_MILLISECONDS = 20_000;

/** The embed address on `origin` (`https://sashaslides.com`, or a local site in development). */
export function drawioEditorAddress(options: Readonly<{ origin: string; interactive: boolean }>): string {
  const origin = options.origin.replace(/\/+$/, "");
  const query = options.interactive ? "embed=1&proto=json&spin=1&saveAndExit=1&noExitBtn=0&libraries=1" : "embed=1&proto=json&spin=1&ui=min";
  return `${origin}/drawio/?${query}`;
}

/** One message from the frame, or null for anything that is not the embed protocol. */
export function parseDrawioMessage(data: unknown): DrawioEvent | null {
  if (typeof data !== "string" || data.length === 0 || data[0] !== "{") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const text = (key: string): string | null => (typeof record[key] === "string" ? (record[key] as string) : null);
  switch (record["event"]) {
    case "init":
      return { kind: "init" };
    case "load":
      return { kind: "load", xml: text("xml") };
    case "export": {
      const exported = text("data");
      return exported === null ? null : { kind: "export", data: exported, format: text("format"), xml: text("xml") };
    }
    case "save": {
      const xml = text("xml");
      return xml === null ? null : { kind: "save", xml, exit: record["exit"] === true };
    }
    case "autosave": {
      const xml = text("xml");
      return xml === null ? null : { kind: "autosave", xml };
    }
    case "exit":
      return { kind: "exit", modified: record["modified"] === true };
    default:
      return null;
  }
}

/** The load action for a seed: a PNG data address goes as `xmlpng`, everything else as `xml`. */
export function drawioLoadAction(options: Readonly<{ seed: string; autosave: boolean }>): DrawioAction {
  const autosave = options.autosave ? 1 : 0;
  return /^data:image\/png/i.test(options.seed) ? { action: "load", xmlpng: options.seed, autosave } : { action: "load", xml: options.seed, autosave };
}

/** The text of a `data:` address (base64 or percent-encoded), or null. */
export function dataUrlText(address: string): string | null {
  const match = /^data:([^,]*),(.*)$/s.exec(address);
  if (match === null) return null;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/**
 * Draws `xml` in a hidden editor frame and exports a PNG and the editable SVG. Resolves (never
 * rejects) within `timeoutMilliseconds`. The frame is removed on every path.
 */
export function renderDrawioPicture(
  options: Readonly<{ document: Document; editorOrigin: string; xml: string; scale?: number; timeoutMilliseconds?: number }>,
): Promise<DrawioRender> {
  const { document } = options;
  const view = document.defaultView;
  if (view === null) return Promise.resolve({ kind: "failed", reason: "no window to host the draw.io editor" });
  const scale = options.scale ?? DRAWIO_RENDER_SCALE;
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-20000px;top:0;width:1280px;height:720px;border:0;visibility:hidden";
    let png: string | null = null;
    let exportRequested = false;
    let settled = false;
    const post = (action: DrawioAction): void => frame.contentWindow?.postMessage(JSON.stringify(action), "*");
    const finish = (outcome: DrawioRender): void => {
      if (settled) return;
      settled = true;
      view.removeEventListener("message", onMessage);
      view.clearTimeout(deadline);
      frame.remove();
      resolve(outcome);
    };
    const requestExport = (): void => {
      if (exportRequested) return;
      exportRequested = true;
      post({ action: "export", format: "xmlpng", scale, border: 0 });
    };
    const onMessage = (message: MessageEvent): void => {
      if (message.source !== frame.contentWindow) return;
      const event = parseDrawioMessage(message.data);
      if (event === null) return;
      switch (event.kind) {
        case "init":
          post(drawioLoadAction({ seed: options.xml, autosave: false }));
          // MEASURED (feature-drawio.js renderXmlToPng): the editor does not always answer a
          // load with `load`, so the export is also asked for shortly after.
          view.setTimeout(requestExport, 600);
          return;
        case "load":
          requestExport();
          return;
        case "export": {
          if (png === null) {
            png = event.data;
            post({ action: "export", format: "xmlsvg", border: 0 });
            return;
          }
          const svg = dataUrlText(event.data);
          if (svg === null) return finish({ kind: "failed", reason: "draw.io returned an unreadable SVG" });
          return finish({ kind: "rendered", picture: { pngDataUrl: png, svg, xml: event.xml ?? options.xml } });
        }
        case "save":
        case "autosave":
        case "exit":
          return;
        default:
          return assertNeverEvent(event);
      }
    };
    const deadline = view.setTimeout(
      () => finish({ kind: "failed", reason: `the draw.io editor did not render within ${Math.round((options.timeoutMilliseconds ?? DRAWIO_RENDER_TIMEOUT_MILLISECONDS) / 1000)} s` }),
      options.timeoutMilliseconds ?? DRAWIO_RENDER_TIMEOUT_MILLISECONDS,
    );
    view.addEventListener("message", onMessage);
    frame.src = drawioEditorAddress({ origin: options.editorOrigin, interactive: false });
    document.body.appendChild(frame);
  });
}

function assertNeverEvent(value: never): never {
  throw new Error(`unhandled draw.io event: ${JSON.stringify(value)}`);
}
