// THE DEVELOPER PAGE (sashaslides.com/dev, deliberately linked from no public page). Paste or drop
// HTML slides, see each one previewed and converted by the PRODUCT converter with its warnings
// drawn over the preview, then either insert them into your own Google Slides presentation, export
// a presentation's slides as PNGs, or download a .pptx without Google at all.
//
// Everything that decides something lives in the pure modules beside this file (queue-state.ts,
// insert-request.ts, export-request.ts, deck-api.ts, warnings.ts), which the tests drive; this file
// only renders their values and wires events to them.

import { render, type JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";
import type { InsertHtmlResponseBody } from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import { convertDocument, objectIdPrefixFor } from "./conversion.ts";
import { exportPng, insertHtml, okValueOf, readSession, signInAddressOf, type DeckCallOutcome, type ExportedZip, type Fetch, type SessionState } from "./deck-api.ts";
import { buildExportRequest, exportFileName } from "./export-request.ts";
import { buildInsertRequest, type PositionChoice } from "./insert-request.ts";
import { loadPptxBuilder, PPTX_MEDIA_TYPE } from "./pptx-builder.ts";
import {
  convertedItems,
  convertedSlideOf,
  EMPTY_QUEUE,
  isHtmlFile,
  nextToConvert,
  pastedDocument,
  queueSummary,
  reduceQueue,
  selectedItem,
  type QueueItem,
  type QueuedDocument,
} from "./queue-state.ts";
import { warningMarks, warningSummary, type WarningMark } from "./warnings.ts";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;

type Session = Readonly<{ kind: "checking" }> | SessionState;

/** A call to the deck service, from the click to its answer. */
type CallState<TValue> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{ kind: "answered"; outcome: DeckCallOutcome<TValue> }>;

type PptxState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "building"; lines: readonly string[] }>
  | Readonly<{ kind: "built"; fileName: string; slideCount: number; bytes: number; failures: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string }>;

function DevPage({ fetch }: { fetch: Fetch }): JSX.Element {
  const [queue, dispatch] = useReducer(reduceQueue, EMPTY_QUEUE);
  const [session, setSession] = useState<Session>({ kind: "checking" });
  const [pasteNumber, setPasteNumber] = useState(1);

  useEffect(() => {
    void readSession({ fetch }).then(setSession);
  }, [fetch]);

  // THE CONVERSION PUMP: one item at a time, the next as soon as the previous one settles.
  const next = nextToConvert(queue);
  useEffect(() => {
    if (next === null) return;
    dispatch({ kind: "conversionStarted", itemId: next.itemId });
    const itemNumber = Number(next.itemId.replace(/\D/g, "")) || 0;
    convertDocument({
      html: next.html,
      objectIdPrefix: objectIdPrefixFor({ itemNumber, randomTail: Math.random().toString(36).slice(2) }),
      document,
      now: () => performance.now(),
    }).then(
      (slide) => dispatch({ kind: "conversionFinished", itemId: next.itemId, slide }),
      (error: unknown) => dispatch({ kind: "conversionFailed", itemId: next.itemId, message: error instanceof Error ? error.message : String(error) }),
    );
  }, [next?.itemId]);

  const addDocuments = useCallback((documents: readonly QueuedDocument[]) => dispatch({ kind: "added", documents }), []);
  const selected = selectedItem(queue);

  return (
    <div class="dev">
      <header class="dev-head">
        <div>
          <h1>Sasha Slides: developer page</h1>
          <p class="muted">HTML slides through the product converter, into your own Google Slides presentation.</p>
        </div>
        <SessionBadge session={session} />
      </header>

      <main class="dev-grid">
        <section class="card" aria-label="Input">
          <h2>1. HTML</h2>
          <DocumentInput
            onDocuments={addDocuments}
            onPaste={(text) => {
              const pasted = pastedDocument({ text, number: pasteNumber });
              if (pasted === null) return false;
              setPasteNumber(pasteNumber + 1);
              addDocuments([pasted]);
              return true;
            }}
          />
          <QueueList
            items={queue.items}
            selectedItemId={queue.selectedItemId}
            summary={summaryLine(queue)}
            onSelect={(itemId) => dispatch({ kind: "selected", itemId })}
            onRemove={(itemId) => dispatch({ kind: "removed", itemId })}
            onClear={() => dispatch({ kind: "cleared" })}
          />
        </section>

        <section class="card preview-card" aria-label="Preview and conversion">
          <h2>2. Preview and conversion</h2>
          {selected === null ? <p class="muted empty">Paste or drop an HTML slide to see it here.</p> : <SelectedItem item={selected} />}
        </section>
      </main>

      <section class="dev-actions">
        <GooglePanel fetch={fetch} session={session} queueItems={queue.items} onSession={setSession} />
        <PptxPanel queueItems={queue.items} />
      </section>
    </div>
  );
}

function SessionBadge({ session }: { session: Session }): JSX.Element {
  switch (session.kind) {
    case "checking":
      return <p class="session muted" data-session="checking">Checking your Sasha Slides session…</p>;
    case "signedIn":
      return (
        <p class="session" data-session="signed-in">
          Signed in as <strong>{session.email ?? session.displayName}</strong>
        </p>
      );
    case "signedOut":
      return (
        <p class="session" data-session="signed-out">
          Signed out. <a class="button" href={session.signInAddress}>Sign in</a> to insert into your presentations.
        </p>
      );
    case "unavailable":
      return <p class="session muted" data-session="unavailable">{session.message} Conversion and .pptx download still work.</p>;
    default:
      return assertNever(session);
  }
}

function DocumentInput({ onDocuments, onPaste }: { onDocuments: (documents: readonly QueuedDocument[]) => void; onPaste: (text: string) => boolean }): JSX.Element {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const readFiles = async (files: readonly File[]): Promise<void> => {
    const html = files.filter(isHtmlFile);
    const skipped = files.length - html.length;
    setNotice(skipped > 0 ? `${skipped} file(s) skipped: only .html files are converted.` : null);
    if (html.length === 0) return;
    const documents = await Promise.all(html.map(async (file) => ({ name: file.name, html: await file.text() })));
    onDocuments([...documents].sort((left, right) => left.name.localeCompare(right.name)));
  };

  return (
    <div class="input">
      <div
        class={dragging ? "drop dragging" : "drop"}
        role="button"
        tabIndex={0}
        aria-label="Drop .html files here, or choose files"
        onClick={() => picker.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") picker.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void readFiles(Array.from(event.dataTransfer?.files ?? []));
        }}
      >
        <strong>Drop .html files here</strong> or click to choose (several become a queue)
      </div>
      <input
        ref={picker}
        type="file"
        accept=".html,.htm,text/html"
        multiple
        hidden
        onChange={(event) => {
          void readFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <label class="paste">
        <span>…or paste one HTML document</span>
        <textarea
          id="paste-html"
          rows={5}
          spellcheck={false}
          placeholder="<!doctype html><html>… a 1280x720 slide …</html>"
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
        />
      </label>
      <div class="row">
        <button
          id="add-pasted"
          type="button"
          disabled={text.trim() === ""}
          onClick={() => {
            if (onPaste(text)) setText("");
          }}
        >
          Add to the queue
        </button>
        {notice === null ? null : <span class="muted">{notice}</span>}
      </div>
    </div>
  );
}

function QueueList(props: {
  items: readonly QueueItem[];
  selectedItemId: string | null;
  summary: string;
  onSelect: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onClear: () => void;
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <div class="queue">
      <div class="row spread">
        <span class="muted" id="queue-summary">{props.summary}</span>
        <button type="button" class="link" onClick={props.onClear}>
          Clear
        </button>
      </div>
      <ol>
        {props.items.map((item) => (
          <li key={item.itemId} class={item.itemId === props.selectedItemId ? "selected" : ""} data-item={item.itemId}>
            <button type="button" class="queue-name" onClick={() => props.onSelect(item.itemId)}>
              {item.name}
            </button>
            <span class={`status status-${item.conversion.kind}`}>{statusOf(item)}</span>
            <button type="button" class="remove" aria-label={`Remove ${item.name}`} onClick={() => props.onRemove(item.itemId)}>
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SelectedItem({ item }: { item: QueueItem }): JSX.Element {
  const slide = convertedSlideOf(item);
  const marks = slide === null ? [] : warningMarks(slide.unsupported);
  return (
    <div>
      <ScaledPreview html={item.html} title={item.name} marks={marks} />
      <ConversionDetails item={item} marks={marks} />
    </div>
  );
}

/** The document at its real 1280x720 in a sandboxed frame (no scripts), scaled to the column. */
function ScaledPreview({ html, title, marks }: { html: string; title: string; marks: readonly WarningMark[] }): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.4);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = (): void => {
      if (element.clientWidth > 0) setScale(element.clientWidth / SLIDE_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div class="preview" ref={box} style={{ height: `${Math.round(SLIDE_HEIGHT * scale)}px` }}>
      <iframe
        title={`Preview of ${title}`}
        sandbox=""
        srcDoc={html}
        width={SLIDE_WIDTH}
        height={SLIDE_HEIGHT}
        style={{ transform: `scale(${scale})` }}
      />
      <div class="overlay" aria-hidden="true">
        {marks.map((mark) => (
          <div key={mark.number} class={markClassOf(mark)} style={mark.box} title={mark.sentence}>
            <span>{mark.number}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A box at the very top of the slide carries its number inside, or the label would be cut off. */
function markClassOf(mark: WarningMark): string {
  return ["mark", mark.omitted ? "omitted" : "", mark.region.y < 0.04 ? "at-top" : ""].filter((part) => part !== "").join(" ");
}

function ConversionDetails({ item, marks }: { item: QueueItem; marks: readonly WarningMark[] }): JSX.Element {
  const { conversion } = item;
  switch (conversion.kind) {
    case "pending":
      return <p class="muted">Waiting to convert…</p>;
    case "converting":
      return <p class="muted">Converting with the product converter…</p>;
    case "failed":
      return <p class="error">The conversion failed: {conversion.message}</p>;
    case "converted": {
      const { slide } = conversion;
      return (
        <div class="conversion" id="conversion">
          <p class="counts">
            <strong data-count="requests">{slide.requests.length}</strong> requests from <strong data-count="elements">{slide.elementCount}</strong> elements
            {slide.drawioDiagrams.length > 0 ? `, ${counted(slide.drawioDiagrams.length, "draw.io diagram")}` : ""}
            {slide.malformedCount > 0 ? `, ${counted(slide.malformedCount, "malformed element")}` : ""}, in {Math.round(slide.elapsedMilliseconds)} ms.{" "}
            <button
              type="button"
              class="link"
              onClick={() => {
                const payload = { name: item.name, elementCount: slide.elementCount, requests: slide.requests, unsupported: slide.unsupported, drawioDiagrams: slide.drawioDiagrams };
                saveBlob({ blob: new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), fileName: `${item.name.replace(/\.html?$/i, "")}.requests.json` });
              }}
            >
              Download requests (.json)
            </button>
          </p>
          <p class="muted" id="warning-summary">{warningSummary(slide.unsupported)}</p>
          {marks.length === 0 ? null : (
            <ol class="warnings" id="warnings">
              {marks.map((mark) => (
                <li key={mark.number} class={mark.omitted ? "omitted" : ""}>
                  <span class="badge">{mark.number}</span> <code>{mark.kind}</code> {mark.sentence}
                </li>
              ))}
            </ol>
          )}
        </div>
      );
    }
    default:
      return assertNever(conversion);
  }
}

function GooglePanel(props: { fetch: Fetch; session: Session; queueItems: readonly QueueItem[]; onSession: (session: SessionState) => void }): JSX.Element {
  const [presentationText, setPresentationText] = useState("");
  const [positionKind, setPositionKind] = useState<PositionChoice["kind"]>("end");
  const [slideNumberText, setSlideNumberText] = useState("1");
  const [insert, setInsert] = useState<CallState<InsertHtmlResponseBody>>({ kind: "idle" });
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [skipHidden, setSkipHidden] = useState(true);
  const [exported, setExported] = useState<CallState<ExportedZip>>({ kind: "idle" });
  const csrfToken = csrfTokenOf(props.session);
  const converted = convertedItems(props.queueItems);

  const afterAnswer = (outcome: DeckCallOutcome<unknown>): void => {
    // A 401 mid-session (the cookie expired) turns the whole page signed out, not just this panel.
    const signedOut = signInAddressOf(outcome);
    if (signedOut !== null) props.onSession({ kind: "signedOut", signInAddress: signedOut });
  };

  const sendInsert = async (): Promise<void> => {
    if (csrfToken === null) return;
    const position = positionChoiceOf({ kind: positionKind, slideNumberText });
    const ready = buildInsertRequest({ presentationText, position, slides: converted.map((entry) => entry.slide) });
    if (ready.kind === "invalid") return setInsert(ready);
    setInsert({ kind: "sending" });
    const outcome = await insertHtml({ fetch: props.fetch, csrfToken, bodyText: ready.value.bodyText });
    afterAnswer(outcome);
    setInsert({ kind: "answered", outcome });
  };

  const sendExport = async (): Promise<void> => {
    if (csrfToken === null) return;
    const ready = buildExportRequest({ presentationText, fromText, toText, skipHidden });
    if (ready.kind === "invalid") return setExported(ready);
    setExported({ kind: "sending" });
    const outcome = await exportPng({ fetch: props.fetch, csrfToken, body: ready.value });
    afterAnswer(outcome);
    const zip = okValueOf(outcome);
    if (zip !== null) saveBlob({ blob: zip.zip, fileName: zip.fileName ?? exportFileName(ready.value) });
    setExported({ kind: "answered", outcome });
  };

  return (
    <section class="card" aria-label="Google Slides">
      <h2>3. Your Google Slides presentation</h2>
      {csrfToken === null ? <p class="muted">Sign in (top right) to insert into a presentation or export one. Your own Google account is used, never a developer's.</p> : null}
      <label class="field">
        <span>Presentation address or id</span>
        <input
          id="presentation"
          type="text"
          placeholder="https://docs.google.com/presentation/d/…/edit"
          value={presentationText}
          onInput={(event) => setPresentationText(event.currentTarget.value)}
        />
      </label>

      <fieldset>
        <legend>Insert the converted slides ({converted.length})</legend>
        <label class="inline">
          <input type="radio" name="position" checked={positionKind !== "atSlide"} onChange={() => setPositionKind("end")} /> at the end
        </label>
        <label class="inline">
          <input type="radio" name="position" checked={positionKind === "atSlide"} onChange={() => setPositionKind("atSlide")} /> as slide
          <input
            class="number"
            type="text"
            inputMode="numeric"
            aria-label="Slide number"
            value={slideNumberText}
            disabled={positionKind !== "atSlide"}
            onInput={(event) => setSlideNumberText(event.currentTarget.value)}
          />
        </label>
        <div class="row">
          <button id="insert" type="button" class="primary" disabled={csrfToken === null || converted.length === 0 || isSending(insert)} onClick={() => void sendInsert()}>
            {isSending(insert) ? "Inserting…" : "Insert into the presentation"}
          </button>
        </div>
        <CallResult state={insert} renderOk={(body) => <InsertDone body={body} />} />
      </fieldset>

      <fieldset>
        <legend>Export slides as PNG (a zip)</legend>
        <div class="row">
          <label class="inline">
            from <input class="number" type="text" inputMode="numeric" placeholder="first" value={fromText} onInput={(event) => setFromText(event.currentTarget.value)} />
          </label>
          <label class="inline">
            to <input class="number" type="text" inputMode="numeric" placeholder="last" value={toText} onInput={(event) => setToText(event.currentTarget.value)} />
          </label>
          <label class="inline">
            <input type="checkbox" checked={skipHidden} onChange={(event) => setSkipHidden(event.currentTarget.checked)} /> leave out skipped slides
          </label>
        </div>
        <div class="row">
          <button id="export" type="button" disabled={csrfToken === null || isSending(exported)} onClick={() => void sendExport()}>
            {isSending(exported) ? "Exporting…" : "Download slides as PNG (.zip)"}
          </button>
        </div>
        <CallResult state={exported} renderOk={(zip) => <p class="ok">Saved {zip.fileName ?? "the zip"} ({Math.round(zip.zip.size / 1024)} KB).</p>} />
      </fieldset>
    </section>
  );
}

function InsertDone({ body }: { body: InsertHtmlResponseBody }): JSX.Element {
  return (
    <div class="ok">
      <p>
        Inserted {counted(body.pageObjectIds.length, "slide")}{body.diagrams.length > 0 ? ` and saved ${counted(body.diagrams.length, "draw.io source")} to Drive` : ""}.{" "}
        {body.presentationAddress === "" ? null : (
          <a href={body.presentationAddress} target="_blank" rel="noopener">
            Open the presentation
          </a>
        )}
      </p>
      {body.warnings.length === 0 ? null : (
        <ul class="warnings">
          {body.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallResult<TValue>({ state, renderOk }: { state: CallState<TValue>; renderOk: (value: TValue) => JSX.Element }): JSX.Element | null {
  switch (state.kind) {
    case "idle":
    case "sending":
      return null;
    case "invalid":
      return <p class="error">{state.message}</p>;
    case "answered":
      return <Outcome outcome={state.outcome} renderOk={renderOk} />;
    default:
      return assertNever(state);
  }
}

function Outcome<TValue>({ outcome, renderOk }: { outcome: DeckCallOutcome<TValue>; renderOk: (value: TValue) => JSX.Element }): JSX.Element {
  switch (outcome.kind) {
    case "ok":
      return renderOk(outcome.value);
    case "signedOut":
      return (
        <p class="error">
          Your session ended. <a href={outcome.signInAddress}>Sign in</a> and try again.
        </p>
      );
    case "googleNotConnected":
      return (
        <p class="error">
          {outcome.message} <a class="button" href={outcome.connectAddress}>Connect Google Slides</a>
        </p>
      );
    case "refused":
      return <p class="error">{outcome.message}</p>;
    case "unreachable":
      return <p class="error">{outcome.message}</p>;
    default:
      return assertNever(outcome);
  }
}

function PptxPanel({ queueItems }: { queueItems: readonly QueueItem[] }): JSX.Element {
  const [oversampling, setOversampling] = useState(2);
  const [state, setState] = useState<PptxState>({ kind: "idle" });
  const documents = queueItems.map((item) => ({ name: item.name, html: item.html }));

  const build = async (): Promise<void> => {
    const lines: string[] = [];
    setState({ kind: "building", lines });
    try {
      const builder = await loadPptxBuilder(document);
      const file = await builder.buildPptx({
        documents,
        oversampling,
        log: (line) => {
          lines.push(line);
          setState({ kind: "building", lines: [...lines.slice(-6)] });
        },
      });
      saveBlob({ blob: new Blob([file.bytes.slice()], { type: PPTX_MEDIA_TYPE }), fileName: file.fileName });
      setState({ kind: "built", fileName: file.fileName, slideCount: file.slideCount, bytes: file.bytes.byteLength, failures: file.failures });
    } catch (error) {
      setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section class="card" aria-label="Download .pptx">
      <h2>Offline: download a .pptx</h2>
      <p class="muted">The command-line converter, in this page: no Google involved. Useful to compare with the native conversion.</p>
      <label class="field">
        <span>Oversampling of rasterised pictures: {oversampling}×</span>
        <input type="range" min={1} max={8} step={1} value={oversampling} onInput={(event) => setOversampling(Number(event.currentTarget.value))} />
      </label>
      <div class="row">
        <button id="download-pptx" type="button" disabled={documents.length === 0 || isBuilding(state)} onClick={() => void build()}>
          {isBuilding(state) ? "Building…" : `Download .pptx (${counted(documents.length, "slide")})`}
        </button>
      </div>
      <PptxResult state={state} />
    </section>
  );
}

function PptxResult({ state }: { state: PptxState }): JSX.Element | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "building":
      return <pre class="log">{state.lines.join("\n")}</pre>;
    case "built":
      return (
        <div class="ok">
          <p>
            Saved {state.fileName}: {counted(state.slideCount, "slide")}, {Math.round(state.bytes / 1024)} KB.
          </p>
          {state.failures.length === 0 ? null : <p class="error">Left out: {state.failures.join("; ")}</p>}
        </div>
      );
    case "failed":
      return <p class="error">{state.message}</p>;
    default:
      return assertNever(state);
  }
}

function csrfTokenOf(session: Session): string | null {
  switch (session.kind) {
    case "signedIn":
      return session.csrfToken;
    case "checking":
    case "signedOut":
    case "unavailable":
      return null;
    default:
      return assertNever(session);
  }
}

function positionChoiceOf(options: Readonly<{ kind: PositionChoice["kind"]; slideNumberText: string }>): PositionChoice {
  switch (options.kind) {
    case "end":
      return { kind: "end" };
    case "atSlide":
      return { kind: "atSlide", slideNumberText: options.slideNumberText };
    default:
      return assertNever(options.kind);
  }
}

function isSending(state: CallState<unknown>): boolean {
  switch (state.kind) {
    case "sending":
      return true;
    case "idle":
    case "invalid":
    case "answered":
      return false;
    default:
      return assertNever(state);
  }
}

function isBuilding(state: PptxState): boolean {
  switch (state.kind) {
    case "building":
      return true;
    case "idle":
    case "built":
    case "failed":
      return false;
    default:
      return assertNever(state);
  }
}

function statusOf(item: QueueItem): string {
  const { conversion } = item;
  switch (conversion.kind) {
    case "pending":
      return "waiting";
    case "converting":
      return "converting…";
    case "converted":
      return `${counted(conversion.slide.requests.length, "request")}, ${counted(conversion.slide.unsupported.length, "warning")}`;
    case "failed":
      return "failed";
    default:
      return assertNever(conversion);
  }
}

function summaryLine(queue: Parameters<typeof queueSummary>[0]): string {
  const summary = queueSummary(queue);
  return `${summary.total} in the queue: ${summary.converted} converted${summary.failed > 0 ? `, ${summary.failed} failed` : ""}${
    summary.pending + summary.converting > 0 ? `, ${summary.pending + summary.converting} to go` : ""
  }`;
}

/** "1 slide", "3 slides": every label here pluralises with a plain "s". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Hands a file to the browser's download. */
function saveBlob(options: Readonly<{ blob: Blob; fileName: string }>): void {
  const address = URL.createObjectURL(options.blob);
  const anchor = document.createElement("a");
  anchor.href = address;
  anchor.download = options.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // The download has started from the click; the address is released after it has been read.
  setTimeout(() => URL.revokeObjectURL(address), 30_000);
}

const root = document.getElementById("dev-root");
if (root === null) throw new Error("dev.html has no #dev-root");
render(<DevPage fetch={(address, init) => window.fetch(address, init)} />, root);
