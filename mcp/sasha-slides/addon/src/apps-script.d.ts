// The two globals an HtmlService page is handed by its host, declared rather than imported.
//
// `google.script.run` is injected into an HtmlService page by Apps Script itself -- there is no
// package to install and `@types/google-apps-script` only types the SERVER side (SlidesApp,
// UrlFetchApp, ...), not this client shim. It is declared with the twelve real function signatures
// instead of an index signature so a typo in a function name is a compile error and not a silent
// "script function not found" at runtime.
//
// ALL THREE SURFACES GET THE SAME SHIM. The conversation, the slides window and the defect-report
// window are separate HtmlService documents and each is injected its own `google.script.run`; none
// uses every function (the conversation never inserts, the report window never picks), but the shim
// is one declaration because Code.gs is one file.

import type {
  CandidateCommentsSpec,
  InsertRequestSpec,
  ReadEventsSpec,
  ReadFeedbackSpec,
  ReportTargetSpec,
  WriteEventSpec,
  WritePickSpec,
} from "./bridge.ts";
import type { SendFeedbackSpec } from "./feedback.ts";

declare global {
  /**
   * The compiled `renderer/html2slides/extract-dom.ts` IIFE, BASE64-encoded and inlined by
   * build-addon.ts via esbuild `--define`. It is a script, not a module (it has no `export`), which
   * is why the bundler has to be the thing that carries it; base64 is why HtmlService's sanitiser
   * cannot corrupt it on the way into the sidebar (see build-addon.ts step 2).
   */
  const __SASHA_EXTRACTOR_JS_B64__: string;

  /**
   * One pending `google.script.run` call. Each `withSuccessHandler` / `withFailureHandler` returns
   * a new runner, and the call itself returns void -- the result arrives through the handlers.
   */
  type AppsScriptRunner = Readonly<{
    withSuccessHandler(handler: (value: unknown) => void): AppsScriptRunner;
    withFailureHandler(handler: (error: unknown) => void): AppsScriptRunner;
    sashaHello(): void;
    sashaScanInbox(spec: Readonly<{ pageSize: number }>): void;
    sashaReadText(spec: Readonly<{ fileId: string }>): void;
    /** One proposal's whole `events/` folder, name and bytes per file. See session-log.ts. */
    sashaReadEvents(spec: ReadEventsSpec): void;
    /** CREATE one event file under `<proposal>/events/`. Drive has no append (PROTOCOL.md). */
    sashaWriteEvent(spec: WriteEventSpec): void;
    /** The comment threads on each candidate's own NN.html -- the unresolved counts' one source. */
    sashaCandidateComments(spec: CandidateCommentsSpec): void;
    sashaInsert(spec: InsertRequestSpec): void;
    sashaWritePick(spec: WritePickSpec): void;
    sashaSendFeedback(spec: SendFeedbackSpec): void;
    sashaReadFeedback(spec: ReadFeedbackSpec): void;
    /** Takes nothing: the slides window is the same for every caller, and its size is Code.gs's. */
    sashaOpenPicker(): void;
    /** Show the DEFECT-REPORT window. Records which candidate, then shows that third document. */
    sashaOpenDefectReport(spec: ReportTargetSpec): void;
    /** The web-app URL for the report window, or null when the script is not deployed as one. */
    sashaReportWindowUrl(spec: Readonly<Record<string, never>>): void;
    /** Which candidate the report window was opened on, read once and cleared. */
    sashaTakeReportTarget(): void;
  }>;

  const google: Readonly<{
    script: Readonly<{
      run: AppsScriptRunner;
      /** Only present in a real sidebar; the standalone smoke page has no host chrome to close. */
      host?: Readonly<{ close(): void }>;
    }>;
  }>;
}
