/**
 * EditorShell.html: the add-on dialog that HOSTS the deck editor (SPEC.md 21.13 item 2).
 *
 * It does three things and nothing else: shows the editor's page in a frame
 * (`<origin>/deck/<id>?embed=addon#ticket=<t>`), offers "Open the Sasha deck" or "Import again"
 * when the presentation changed since its import, and RELAYS `AddonShellMessage`s: the editor asks
 * for an export (`exportRequested`) and this page runs it with the add-on's own Slides authority
 * through `google.script.run.sashaRunExport`, then answers `exportFinished`.
 *
 * TRUST: a message counts only when its origin is the editor's origin (from Code.gs's seed, which
 * is `https://sashaslides.com` in production) AND it says `source: "sasha-editor"`; everything else
 * is ignored before any other field is read. Answers go to that one origin, never `*`.
 *
 * WHY NOT REACT: the page has a 10 kilobyte budget (surface-budget.ts) and React alone is twenty
 * times that; what it draws is one frame or one small card, so it is built with a few DOM calls in
 * `renderShell` and every other function here is pure and unit-tested. Colours and sizes come from
 * the Tidepool tokens (engine/src/theme), never literals.
 */
import type { AddonShellMessage } from "../../engine/src/contracts/deck-api.ts";
import { TIDEPOOL_TOKENS } from "../../engine/src/theme/tidepool-theme.ts";
import { assertNever } from "./protocol.ts";

export type EditorSeed =
  | Readonly<{ kind: "open"; editorOrigin: string; deckId: string; ticket: string }>
  | Readonly<{ kind: "changedSinceImport"; editorOrigin: string; deckId: string; ticket: string; importToken: string }>
  | Readonly<{ kind: "failed"; editorOrigin: string; message: string }>;

export type ExportOutcome = Readonly<{ kind: "applied" }> | Readonly<{ kind: "failed"; message: string }>;

/** What the message handler may do; the page passes the real ones, the tests pass recorders. */
export type ShellEffects = Readonly<{
  postToEditor(message: AddonShellMessage): void;
  runExport(options: Readonly<{ exportId: string; finished: (outcome: ExportOutcome) => void }>): void;
  close(): void;
}>;

/** The seed Code.gs appended to the page, or null when it is missing or malformed. */
export function parseEditorSeed(text: string): EditorSeed | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const editorOrigin = stringField(value, "editorOrigin");
  if (editorOrigin === null || !/^https:\/\/[a-z0-9.-]+$/.test(editorOrigin)) return null;
  switch (stringField(value, "kind")) {
    case "open": {
      const deckId = stringField(value, "deckId");
      const ticket = stringField(value, "ticket");
      return deckId === null || ticket === null ? null : { kind: "open", editorOrigin, deckId, ticket };
    }
    case "changedSinceImport": {
      const deckId = stringField(value, "deckId");
      const ticket = stringField(value, "ticket");
      const importToken = stringField(value, "importToken");
      return deckId === null || ticket === null || importToken === null ? null : { kind: "changedSinceImport", editorOrigin, deckId, ticket, importToken };
    }
    case "failed":
      return { kind: "failed", editorOrigin, message: stringField(value, "message") ?? "The editor could not be opened." };
    default:
      return null;
  }
}

/** The editor page inside the dialog; the ticket travels in the fragment, which no server log sees (deck-api.ts). */
export function editorFrameAddress(options: Readonly<{ editorOrigin: string; deckId: string; ticket: string }>): string {
  return `${options.editorOrigin}/deck/${encodeURIComponent(options.deckId)}?embed=addon#ticket=${encodeURIComponent(options.ticket)}`;
}

/**
 * The `message` listener. Returns what it did, so a test can tell an ignored message from a
 * handled one without a page.
 */
export function createShellMessageHandler(
  options: Readonly<{ editorOrigin: string; effects: ShellEffects }>,
): (event: Readonly<{ origin: string; data: unknown }>) => "ignored" | "handled" {
  return (event) => {
    if (event.origin !== options.editorOrigin) return "ignored";
    if (stringField(event.data, "source") !== "sasha-editor") return "ignored";
    switch (stringField(event.data, "kind")) {
      case "ready":
        return "handled";
      case "closeRequested":
        options.effects.close();
        return "handled";
      case "exportRequested": {
        const exportId = stringField(event.data, "exportId");
        if (exportId === null) return "ignored";
        options.effects.runExport({
          exportId,
          finished: (outcome) => options.effects.postToEditor(exportFinished({ exportId, outcome })),
        });
        return "handled";
      }
      default:
        return "ignored";
    }
  };
}

function exportFinished(options: Readonly<{ exportId: string; outcome: ExportOutcome }>): AddonShellMessage {
  switch (options.outcome.kind) {
    case "applied":
      return { source: "sasha-addon-shell", kind: "exportFinished", exportId: options.exportId, outcome: "applied", message: "" };
    case "failed":
      return { source: "sasha-addon-shell", kind: "exportFinished", exportId: options.exportId, outcome: "failed", message: options.outcome.message };
    default:
      return assertNever(options.outcome);
  }
}

/** The element Code.gs appends the handoff under (editor-code-gs.ts `sashaOpenEditor`). */
export const EDITOR_SEED_ELEMENT_ID = "sasha-editor-seed";

/** The page: read the seed, draw the frame or the card, install the relay. */
function renderShell(page: Readonly<{ document: Document; window: Window }>): void {
  const { document, window } = page;
  const seedElement = document.getElementById(EDITOR_SEED_ELEMENT_ID);
  const seed = seedElement === null ? null : parseEditorSeed(seedElement.textContent ?? "");
  const style = document.createElement("style");
  style.textContent = shellStylesheet();
  document.head.append(style);
  if (seed === null) {
    showCard({ document, message: "The editor could not be opened: Code.gs sent no handoff.", buttons: [] });
    return;
  }
  let frame: HTMLIFrameElement | null = null;
  const openFrame = (deckId: string, ticket: string): void => {
    document.body.replaceChildren();
    frame = document.createElement("iframe");
    frame.src = editorFrameAddress({ editorOrigin: seed.editorOrigin, deckId, ticket });
    frame.allow = "clipboard-write; fullscreen";
    frame.title = "Sasha editor";
    frame.className = "sasha-editor-frame";
    document.body.append(frame);
  };
  const handler = createShellMessageHandler({
    editorOrigin: seed.editorOrigin,
    effects: {
      postToEditor: (message) => frame?.contentWindow?.postMessage(message, seed.editorOrigin),
      runExport: ({ exportId, finished }) =>
        google.script.run
          .withSuccessHandler((value) => finished(stringField(value, "outcome") === "applied" ? { kind: "applied" } : { kind: "failed", message: stringField(value, "message") ?? "The export failed." }))
          .withFailureHandler((error) => finished({ kind: "failed", message: error instanceof Error ? error.message : String(error) }))
          .sashaRunExport(exportId),
      close: () => google.script.host?.close(),
    },
  });
  window.addEventListener("message", (event) => handler({ origin: event.origin, data: event.data }));
  switch (seed.kind) {
    case "open":
      openFrame(seed.deckId, seed.ticket);
      return;
    case "changedSinceImport":
      showCard({
        document,
        message: "This presentation changed since it was imported into Sasha.",
        buttons: [
          { label: "Open the Sasha deck", primary: false, press: () => openFrame(seed.deckId, seed.ticket) },
          {
            label: "Import again",
            primary: true,
            press: () => {
              showCard({ document, message: "Importing the presentation again...", buttons: [] });
              google.script.run
                .withSuccessHandler((value) => openFrame(stringField(value, "deckId") ?? seed.deckId, stringField(value, "ticket") ?? seed.ticket))
                .withFailureHandler((error) => showCard({ document, message: `The import failed: ${error instanceof Error ? error.message : String(error)}`, buttons: [] }))
                .sashaImportAgain({ importToken: seed.importToken, deckId: seed.deckId });
            },
          },
        ],
      });
      return;
    case "failed":
      showCard({ document, message: `${seed.message} Sign in again from the SashaSlides menu.`, buttons: [{ label: "Close", primary: false, press: () => google.script.host?.close() }] });
      return;
    default:
      assertNever(seed);
  }
}

type CardButton = Readonly<{ label: string; primary: boolean; press: () => void }>;

function showCard(options: Readonly<{ document: Document; message: string; buttons: readonly CardButton[] }>): void {
  const { document } = options;
  const card = document.createElement("main");
  card.className = "sasha-shell-card";
  const text = document.createElement("p");
  text.textContent = options.message;
  card.append(text);
  for (const button of options.buttons) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = button.label;
    element.className = button.primary ? "sasha-shell-primary" : "sasha-shell-secondary";
    element.addEventListener("click", button.press);
    card.append(element);
  }
  document.body.replaceChildren(card);
}

/** Only Tidepool tokens: the light scheme's ground, ink and pills (SPEC.md 2). */
function shellStylesheet(): string {
  const light = TIDEPOOL_TOKENS.light;
  const typography = TIDEPOOL_TOKENS.typography;
  const spacing = TIDEPOOL_TOKENS.spacing;
  return [
    `html,body{margin:0;height:100%;background:${light.ground};color:${light.text};font:${typography.sizes.body}px/${typography.lineHeight} ${typography.fontFamily}}`,
    `.sasha-editor-frame{display:block;width:100%;height:100%;border:0}`,
    `.sasha-shell-card{max-width:440px;margin:${spacing.extraLarge * 2}px auto;padding:${spacing.large}px;border-radius:${TIDEPOOL_TOKENS.radius.card}px;background:${light.cardGlass};box-shadow:${light.liftShadow}}`,
    `.sasha-shell-card button{margin:${spacing.small}px ${spacing.small}px 0 0;height:${TIDEPOOL_TOKENS.control.height}px;padding:0 ${spacing.large}px;border:0;border-radius:${TIDEPOOL_TOKENS.radius.pill}px;font:inherit;cursor:pointer}`,
    `.sasha-shell-primary{background:${light.inkButton};color:${light.inkButtonText}}`,
    `.sasha-shell-secondary{background:${light.secondaryButton};color:${light.text}}`,
  ].join("");
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : null;
}


// The bundle runs in the HtmlService page; under the unit tests there is no document. Code.gs
// APPENDS the seed after this bundle's loader (measured: read at once, the seed element did not
// exist yet and the shell said "sent no handoff"), so the page waits for the whole document.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => renderShell({ document, window }));
  else renderShell({ document, window });
}
