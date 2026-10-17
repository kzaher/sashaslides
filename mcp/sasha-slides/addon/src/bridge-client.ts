// The ONLY implementation of DriveApi / SlidesApi / PickApi, and the only file that mentions
// `google.script.run`. It promisifies Apps Script's callback shim and parses every reply through
// bridge.ts, so nothing above it can tell that the transport is an add-on rather than HTTP.
//
// WHY A TIMEOUT. `google.script.run` has no abort and no timeout of its own: a call whose handlers
// never fire leaves the promise pending forever, which would freeze the picker on a dead poll.
// CLAUDE.md's rule applies -- fail fast with a budget and diagnose, rather than wait. The budget is
// generous compared with a CDP operation because an Apps Script execution genuinely takes a
// round trip to Google plus the Drive calls inside it, but it is bounded.

import { CALLS_PER_MINUTE, createCallRateLimit } from "./call-budget.ts";
import {
  explainHostFailure,
  outcomeOf,
  parseCandidateCommentsReply,
  parseCommentReply,
  parseHelloReply,
  parseInsertReply,
  parseOpenPickerReply,
  parsePageElementsReply,
  parsePickerTargetReply,
  parseReadEventsReply,
  parseReadTextReply,
  parseReadTextsReply,
  parseRenderPreviewsReply,
  parseReportTargetReply,
  parseReportWindowUrl,
  parseScanReply,
  parseSendFeedbackReply,
  parseWriteEventReply,
  parseWritePickReply,
  parseWriteRenderReply,
  type CallOutcome,
  type HelloReply,
  type ServerFunctionArgs,
  type ServerFunctionName,
  type ServerFunctions,
} from "./bridge.ts";
import { parseCommentAccessAnswer, type CommentAccessAnswer } from "../../comment-bot/comment-access-contract.ts";
import { parseDiagramLinkReply, parseDiagramSaveReply, parseDiagramSourcesReply } from "./diagram-wire.ts";
import type {
  BatchReadApi,
  CandidateCommentsApi,
  CommentThreadApi,
  DiagramApi,
  DriveApi,
  FeedbackApi,
  PickApi,
  PickerWindowApi,
  ReportTargetApi,
  SessionLogApi,
  SlidesApi,
} from "./drive-api.ts";
import { PROTOCOL_VERSION, type Parsed } from "./protocol.ts";

/** How long any one server call may take before it is reported as a failure. */
export const CALL_BUDGET_MS = 25_000;

/**
 * The comment read's own budget. One Drive call PER CANDIDATE, and Apps Script serialises a
 * single user's calls across BOTH surfaces -- so on a cold start it queues behind the slides
 * window fetching and converting every candidate. Measured: the read itself answers in ~1.5 s
 * for two candidates, and still blew the 25 s default while queued (deployed add-on,
 * 2026-10-04). The work is not slow; the queue in front of it is.
 */
export const COMMENT_READ_BUDGET_MS = 90_000;

/**
 * One server call, as a promise. Injected everywhere below so the whole client half can be driven
 * by a fake in a test without an Apps Script host in the room.
 */
export type ServerCall = <TReply>(
  spec: Readonly<{
    invoke: (runner: AppsScriptRunner) => void;
    what: string;
    /**
     * A longer budget for one call. Apps Script SERIALISES a single user's calls and the two
     * surfaces share that queue, so a read can be made to wait by work that is not its own --
     * and a read killed for queueing is reported to the user as a failure that is not one.
     */
    budgetMs?: number;
  }>,
) => Promise<CallOutcome<TReply>>;

export function appsScriptCall({
  run,
  budgetMs: defaultBudgetMs = CALL_BUDGET_MS,
}: {
  run: AppsScriptRunner;
  budgetMs?: number;
}): ServerCall {
  // Counted so a reducer bug cannot spend a daily quota again: see call-budget.ts.
  const rateLimit = createCallRateLimit({ now: () => Date.now() });
  return <TReply>({
    invoke,
    what,
    budgetMs = defaultBudgetMs,
  }: Readonly<{ invoke: (runner: AppsScriptRunner) => void; what: string; budgetMs?: number }>) =>
    new Promise<CallOutcome<TReply>>((resolve) => {
      if (!rateLimit.allow()) {
        resolve({
          kind: "failed",
          message:
            `${what} was not sent: this surface has made ${String(CALLS_PER_MINUTE)} server calls ` +
            "in a minute, which is far more than polling needs. It is being held back so a loop " +
            "cannot spend the day's Apps Script quota. It will resume by itself.",
        });
        return;
      }
      let answered = false;
      const settle = (outcome: CallOutcome<TReply>): void => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => settle({ kind: "failed", message: `${what} did not answer within ${budgetMs} ms` }),
        budgetMs,
      );
      try {
        invoke(
          run
            // SAFETY: the value is handed straight to a bridge.ts parser by every caller below;
            // `unknown` would need a cast at each of them instead of this one.
            .withSuccessHandler((value) => settle({ kind: "ok", value: value as TReply }))
            .withFailureHandler((error) => {
              // A host failure is Google declining to run the function; explainHostFailure turns
              // the opaque string into an instruction. The original is kept so nothing is hidden.
              const raw = describe(error);
              const explained = explainHostFailure(raw);
              settle({ kind: "failed", message: explained === null ? `${what}: ${raw}` : `${explained} (${what} reported: ${raw})` });
            }),
        );
      } catch (cause) {
        // A synchronous throw means the function name is not on the server at all, which is a
        // deploy mismatch -- `clasp push` ran against an older Code.gs.
        settle({ kind: "failed", message: `${what} could not be called: ${describe(cause)}` });
      }
    });
}

/**
 * ONE SERVER FUNCTION, CALLED AND PARSED: the call, then its reply through the bridge.ts parser that
 * owns it. `name` is both the function invoked and the `what` every failure names, so the two can
 * no longer disagree.
 */
async function invoke<Name extends ServerFunctionName, Reply>({
  call,
  name,
  args,
  parse,
  budgetMs,
}: {
  call: ServerCall;
  name: Name;
  args: ServerFunctionArgs[Name];
  parse: (value: unknown) => Parsed<Reply>;
  budgetMs?: number;
}): Promise<CallOutcome<Reply>> {
  const replied = await call<unknown>({
    invoke: (runner) => {
      const functions: ServerFunctions = runner;
      functions[name](...args);
    },
    what: name,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });
  if (replied.kind !== "ok") return replied;
  return outcomeOf({ parsed: parse(replied.value), what: name });
}

/** The value of a successful outcome, changed; a failure passes through. */
function mapOk<Value, Changed>(outcome: CallOutcome<Value>, change: (value: Value) => Changed): CallOutcome<Changed> {
  return outcome.kind === "ok" ? { kind: "ok", value: change(outcome.value) } : outcome;
}

export function helloFromServer({ call }: { call: ServerCall }): Promise<CallOutcome<HelloReply>> {
  return invoke({ call, name: "sashaHello", args: [], parse: parseHelloReply });
}

/**
 * EVERY SURFACE'S FIRST QUESTION: which deck, and does the server speak this build's protocol. The
 * answer comes from the seed Code.gs appended when there is one, so the round trip is skipped. A host
 * that does not answer, or speaks another version, is a failure with words -- a banner on screen
 * rather than reads that silently never land.
 */
export async function connect({
  call,
  seeded,
  surface,
}: {
  call: ServerCall;
  seeded: HelloReply | null;
  /** What this document calls itself in the version message: "panel", "slides window", "report". */
  surface: string;
}): Promise<CallOutcome<HelloReply>> {
  const hello = seeded !== null ? { kind: "ok" as const, value: seeded } : await helloFromServer({ call });
  if (hello.kind !== "ok" || hello.value.protocolVersion === PROTOCOL_VERSION) return hello;
  return {
    kind: "failed",
    message: `the add-on speaks protocolVersion ${hello.value.protocolVersion}, this ${surface} ${PROTOCOL_VERSION}`,
  };
}

/**
 * WHAT A SURFACE SAYS WHEN IT IS NOT CONNECTED. Its services are null until the hello is in hand,
 * and every path has to treat that as a REPORTABLE outcome: returning silently is what made a failed
 * hello look like a hang -- a panel set its loading flags and sat on "loading..." for ever.
 */
export function notConnected(reopen: string): string {
  return `the add-on is not connected to Google Slides. Reload the presentation and ${reopen}.`;
}

/**
 * `sashaCommentAccess()`: Code.gs asks the connector whether the user's own grant reaches this
 * deck's comments (comment-access-state.ts). Its reply is the connector's answer, parsed here.
 */
export function commentAccessFromServer({ call }: { call: ServerCall }): Promise<CallOutcome<CommentAccessAnswer>> {
  return invoke({ call, name: "sashaCommentAccess", args: [], parse: parseAccessAnswer });
}

function parseAccessAnswer(value: unknown): Parsed<CommentAccessAnswer> {
  const answer = parseCommentAccessAnswer(value);
  return answer === null ? { kind: "invalid", reason: "it returned no access answer" } : { kind: "ok", value: answer };
}

export function appsScriptDriveApi({ call }: { call: ServerCall }): DriveApi {
  return {
    scanInbox: async (spec) =>
      mapOk(await invoke({ call, name: "sashaScanInbox", args: [spec], parse: parseScanReply }), (reply) => reply.marks),
    downloadText: async (fileId) =>
      mapOk(await invoke({ call, name: "sashaReadText", args: [{ fileId }], parse: parseReadTextReply }), (reply) => reply.text),
  };
}

export function appsScriptBatchReadApi({ call }: { call: ServerCall }): BatchReadApi {
  return {
    downloadTexts(fileIds, options) {
      const rememberForSidebar = options?.rememberForSidebar;
      const spec = rememberForSidebar === undefined ? { fileIds } : { fileIds, rememberForSidebar };
      return invoke({ call, name: "sashaReadTexts", args: [spec], parse: parseReadTextsReply });
    },
  };
}

export function appsScriptSlidesApi({ call }: { call: ServerCall }): SlidesApi {
  return {
    insert: (spec) => invoke({ call, name: "sashaInsert", args: [spec], parse: parseInsertReply }),
    writeRender: (spec) => invoke({ call, name: "sashaWriteRender", args: [spec], parse: parseWriteRenderReply }),
    pageElements: (spec) => invoke({ call, name: "sashaPageElements", args: [spec], parse: parsePageElementsReply }),
    renderPreviews: (spec) => invoke({ call, name: "sashaRenderPreviews", args: [spec], parse: parseRenderPreviewsReply }),
  };
}

/**
 * A diagram save stages a picture, writes a Drive file and runs a batchUpdate in one execution, and
 * queues behind any other call this user has in flight, so it gets the long budget.
 */
export const DIAGRAM_CALL_BUDGET_MS = 90_000;

export function appsScriptDiagramApi({ call }: { call: ServerCall }): DiagramApi {
  return {
    save: (spec) => invoke({ call, name: "sashaSaveDiagram", args: [spec], parse: parseDiagramSaveReply, budgetMs: DIAGRAM_CALL_BUDGET_MS }),
    readSources: (fileIds) => invoke({ call, name: "sashaReadDiagramSources", args: [{ fileIds }], parse: parseDiagramSourcesReply, budgetMs: DIAGRAM_CALL_BUDGET_MS }),
    linkInserted: (spec) => invoke({ call, name: "sashaLinkInsertedDiagrams", args: [spec], parse: parseDiagramLinkReply, budgetMs: DIAGRAM_CALL_BUDGET_MS }),
  };
}

export function appsScriptPickApi({ call }: { call: ServerCall }): PickApi {
  return {
    createPick: async ({ folderId, name, mimeType, body, appProperties }) =>
      mapOk(
        await invoke({
          call,
          name: "sashaWritePick",
          args: [{ folderId, name, mimeType, body, appProperties }],
          parse: parseWritePickReply,
        }),
        (reply) => ({ fileId: reply.fileId }),
      ),
  };
}

export function appsScriptSessionLogApi({ call }: { call: ServerCall }): SessionLogApi {
  return {
    readEvents: (spec) => invoke({ call, name: "sashaReadEvents", args: [spec], parse: parseReadEventsReply }),
    appendEvent: (spec) => invoke({ call, name: "sashaWriteEvent", args: [spec], parse: parseWriteEventReply }),
  };
}

export function appsScriptCandidateCommentsApi({ call }: { call: ServerCall }): CandidateCommentsApi {
  return {
    read: (spec) =>
      invoke({
        call,
        name: "sashaCandidateComments",
        args: [spec],
        parse: parseCandidateCommentsReply,
        // THE HEAVY ONE, and the one most often made to wait. It is a Drive call PER CANDIDATE,
        // and on a cold start it queues behind the slides window fetching and converting every
        // candidate. At the 25 s default it was killed mid-queue and the window printed "open
        // comments could not be read" over a read that was merely waiting its turn.
        budgetMs: COMMENT_READ_BUDGET_MS,
      }),
  };
}

export function appsScriptFeedbackApi({ call }: { call: ServerCall }): FeedbackApi {
  return {
    send: (spec) => invoke({ call, name: "sashaSendFeedback", args: [spec], parse: parseSendFeedbackReply }),
  };
}

/**
 * THE THREAD RAIL'S TWO BUTTONS, over the same rate-limited `call` as every poll -- a reply must
 * not be the one path that escapes call-budget.ts. Both are user-initiated, one call per press.
 *
 * `sashaReplyToComment` posts the user's words; `sashaResolveComment` closes the thread.
 */
export function appsScriptCommentThreadApi({ call }: { call: ServerCall }): CommentThreadApi {
  return {
    reply: (spec) => invoke({ call, name: "sashaReplyToComment", args: [spec], parse: parseCommentReply }),
    resolve: (spec) => invoke({ call, name: "sashaResolveComment", args: [spec], parse: parseCommentReply }),
  };
}

export function appsScriptPickerWindowApi({ call }: { call: ServerCall }): PickerWindowApi {
  return {
    openPicker: (target) =>
      invoke({ call, name: "sashaOpenPicker", args: target === undefined ? [] : [target], parse: parseOpenPickerReply }),
    takePickerTarget: () => invoke({ call, name: "sashaTakePickerTarget", args: [], parse: parsePickerTargetReply }),
    openDefectReport: (spec) => invoke({ call, name: "sashaOpenDefectReport", args: [spec], parse: parseOpenPickerReply }),
    reportWindowUrl: () => invoke({ call, name: "sashaReportWindowUrl", args: [{}], parse: parseReportWindowUrl }),
  };
}

export function appsScriptReportTargetApi({ call }: { call: ServerCall }): ReportTargetApi {
  return {
    takeTarget: () => invoke({ call, name: "sashaTakeReportTarget", args: [], parse: parseReportTargetReply }),
  };
}

/**
 * Apps Script's failure handler is documented to hand over an Error, but a sandboxed host has been
 * seen passing a bare string, so this reads either without throwing inside the error path.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>)["message"] : null;
  return typeof message === "string" ? message : String(error);
}
