// TALKING TO THE ADD-ON'S HTMLSERVICE SHELL (deck-api.ts `AddonShellMessage`, SPEC.md 21.13): the
// editor frame posts `ready`, `exportRequested` and `closeRequested` to its parent, the shell, and
// hears `exportFinished` back.
//
// Key decisions:
//
//  * ONE ORIGIN, CHECKED BOTH WAYS. The shell's origin is read once from the browser
//    (`location.ancestorOrigins`, else the referrer) and accepted only when it matches
//    `ADDON_FRAME_ANCESTORS`. Every message is posted to exactly that origin, never "*", and an
//    inbound message from any other origin -- or from a window other than the parent -- is
//    ignored before its data is read.
//  * INBOUND DATA IS PARSED AT THIS BOUNDARY: only a well-formed `exportFinished` from the shell
//    gets through.
//  * EXPORT IN THE ADD-ON (`runInAddon`): the frame posts `exportRequested` with the server's
//    `exportId` and waits for the shell's `exportFinished` with the same id; the add-on's own
//    authorization writes the presentation (Code.gs `sashaRunExport`).

import { filter, firstValueFrom, Subject, timeout, type Observable, type SchedulerLike } from "rxjs";
import { ADDON_FRAME_ANCESTORS, type AddonShellMessage } from "../../contracts/deck-api.ts";
import { keysOf, memberAt, parseOrNull, recordOf, stringAt } from "../../shared/untrusted-values.ts";

export type EditorToShellMessage = Extract<AddonShellMessage, { source: "sasha-editor" }>;
export type ShellToEditorMessage = Extract<AddonShellMessage, { source: "sasha-addon-shell" }>;

/** The slice of a `MessageEvent` the relay reads. */
export type InboundMessage = Readonly<{ origin: string; source: unknown; data: unknown }>;

export type ShellRelay = Disposable &
  Readonly<{
    shellOrigin: string;
    post: (message: EditorToShellMessage) => void;
    /** Hot: every well-formed message from the shell. */
    messages: Observable<ShellToEditorMessage>;
    /** Posts `exportRequested` and resolves with the shell's `exportFinished` for that id. */
    runExport: (exportId: string) => Promise<ShellToEditorMessage>;
  }>;

/** The longest an export in the add-on may take before the frame stops waiting. */
export const ADDON_EXPORT_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;

/** The shell's origin when the browser names one that `ADDON_FRAME_ANCESTORS` allows, else null. */
export function shellOriginOf(options: Readonly<{ ancestorOrigins: readonly string[] | null; referrer: string }>): string | null {
  const candidate = options.ancestorOrigins?.[0] ?? originOfAddress(options.referrer);
  if (candidate === null) return null;
  return ADDON_FRAME_ANCESTORS.some((pattern) => originMatches({ origin: candidate, pattern })) ? candidate : null;
}

/** `https://docs.google.com` matches itself; `https://*.googleusercontent.com` matches any subdomain over https. */
export function originMatches(options: Readonly<{ origin: string; pattern: string }>): boolean {
  const origin = parseOrigin(options.origin);
  const pattern = parseOrigin(options.pattern.replace("://*.", "://wildcard."));
  if (origin === null || pattern === null || origin.protocol !== pattern.protocol || origin.port !== pattern.port) return false;
  if (!options.pattern.includes("://*.")) return origin.hostname === pattern.hostname;
  const suffix = pattern.hostname.slice("wildcard".length);
  return origin.hostname.endsWith(suffix) && origin.hostname.length > suffix.length;
}

export function createShellRelay(options: Readonly<{
  shellOrigin: string;
  /** The parent window: where messages go, and the only `source` messages are accepted from. */
  shell: Readonly<{ postMessage: (message: unknown, targetOrigin: string) => void }>;
  /** `window.addEventListener("message", ...)`, returning its removal. */
  listen: (handler: (message: InboundMessage) => void) => Disposable;
  scheduler: SchedulerLike;
}>): ShellRelay {
  const messages = new Subject<ShellToEditorMessage>();
  const listening = options.listen((inbound) => {
    if (inbound.origin !== options.shellOrigin || inbound.source !== options.shell) return;
    const message = parseShellMessage(inbound.data);
    if (message !== null) messages.next(message);
  });
  const post = (message: EditorToShellMessage): void => options.shell.postMessage(message, options.shellOrigin);
  return {
    shellOrigin: options.shellOrigin,
    post,
    messages: messages.asObservable(),
    runExport: (exportId) => {
      const finished = firstValueFrom(messages.pipe(filter((message) => message.exportId === exportId), timeout({ first: ADDON_EXPORT_TIMEOUT_MILLISECONDS, scheduler: options.scheduler })));
      post({ source: "sasha-editor", kind: "exportRequested", exportId });
      return finished;
    },
    [Symbol.dispose]: () => {
      listening[Symbol.dispose]();
      messages.complete();
    },
  };
}

/** A message from the shell, or null for anything else (see the header). */
export function parseShellMessage(data: unknown): ShellToEditorMessage | null {
  return parseOrNull(() => {
    const record = recordOf(data, "shell message");
    memberAt(record, "source", SHELL_SOURCES);
    memberAt(record, "kind", SHELL_KINDS);
    return {
      source: "sasha-addon-shell",
      kind: "exportFinished",
      exportId: stringAt(record, "exportId"),
      outcome: memberAt(record, "outcome", EXPORT_OUTCOMES),
      message: stringAt(record, "message"),
    };
  });
}

const SHELL_SOURCES = keysOf<ShellToEditorMessage["source"]>({ "sasha-addon-shell": true });
const SHELL_KINDS = keysOf<ShellToEditorMessage["kind"]>({ exportFinished: true });
const EXPORT_OUTCOMES = keysOf<ShellToEditorMessage["outcome"]>({ applied: true, failed: true });

function originOfAddress(address: string): string | null {
  return parseOrigin(address)?.origin ?? null;
}

function parseOrigin(address: string): URL | null {
  try {
    return new URL(address);
  } catch {
    return null;
  }
}
