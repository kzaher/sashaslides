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
  outcomeOf,
  parseCandidateCommentsReply,
  parseInsertReply,
  parseRenderPreviewsReply,
  parseOpenPickerReply,
  parsePickerTargetReply,
  parseReportWindowUrl,
  parseReadEventsReply,
  parseReadFeedbackReply,
  parseReadTextReply,
  parseCommentReply,
  parseReplyCommentReply,
  parseReportTargetReply,
  parseResolveCommentReply,
  parseScanReply,
  parseSendFeedbackReply,
  parseWriteEventReply,
  parseWritePickReply,
  type CallOutcome,
  type CandidateCommentsReply,
  type HelloReply,
  type InsertReply,
  type PickerTargetReply,
  type RenderPreviewsReply,
  type InsertRequestSpec,
  type OpenPickerReply,
  type ProposalMark,
  type ReadEventsReply,
  type ReadFeedbackReply,
  type CommentReplyReply,
  type ReplyCommentReply,
  type ReportTargetReply,
  type SendFeedbackReply,
  type WriteEventReply, explainHostFailure } from "./bridge.ts";
import { parseHelloReply } from "./bridge.ts";
import type {
  CandidateCommentsApi,
  CommentThreadApi,
  DriveApi,
  FeedbackApi,
  PickApi,
  PickerWindowApi,
  ReportTargetApi,
  SessionLogApi,
  SlidesApi,
} from "./drive-api.ts";

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

export async function helloFromServer({ call }: { call: ServerCall }): Promise<CallOutcome<HelloReply>> {
  const replied = await call<unknown>({ invoke: (runner) => runner.sashaHello(), what: "sashaHello" });
  if (replied.kind !== "ok") return replied;
  return outcomeOf({ parsed: parseHelloReply(replied.value), what: "sashaHello" });
}

export function appsScriptDriveApi({ call }: { call: ServerCall }): DriveApi {
  return {
    async scanInbox({ pageSize }) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaScanInbox({ pageSize }),
        what: "sashaScanInbox",
      });
      if (replied.kind !== "ok") return replied;
      const parsed = outcomeOf({ parsed: parseScanReply(replied.value), what: "sashaScanInbox" });
      return parsed.kind === "ok"
        ? { kind: "ok", value: parsed.value.marks satisfies readonly ProposalMark[] }
        : parsed;
    },

    async downloadText(fileId) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReadText({ fileId }),
        what: "sashaReadText",
      });
      if (replied.kind !== "ok") return replied;
      const parsed = outcomeOf({ parsed: parseReadTextReply(replied.value), what: "sashaReadText" });
      return parsed.kind === "ok" ? { kind: "ok", value: parsed.value.text } : parsed;
    },
  };
}

export function appsScriptSlidesApi({ call }: { call: ServerCall }): SlidesApi {
  return {
    async insert(spec: InsertRequestSpec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaInsert(spec),
        what: "sashaInsert",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({ parsed: parseInsertReply(replied.value), what: "sashaInsert" }) satisfies CallOutcome<InsertReply>;
    },

    async renderPreviews(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaRenderPreviews(spec),
        what: "sashaRenderPreviews",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseRenderPreviewsReply(replied.value),
        what: "sashaRenderPreviews",
      }) satisfies CallOutcome<RenderPreviewsReply>;
    },
  };
}

export function appsScriptPickApi({ call }: { call: ServerCall }): PickApi {
  return {
    async createPick({ folderId, name, mimeType, body, appProperties }) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaWritePick({ folderId, name, mimeType, body, appProperties }),
        what: "sashaWritePick",
      });
      if (replied.kind !== "ok") return replied;
      const parsed = outcomeOf({ parsed: parseWritePickReply(replied.value), what: "sashaWritePick" });
      return parsed.kind === "ok" ? { kind: "ok", value: { fileId: parsed.value.fileId } } : parsed;
    },
  };
}

export function appsScriptSessionLogApi({ call }: { call: ServerCall }): SessionLogApi {
  return {
    async readEvents(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReadEvents(spec),
        what: "sashaReadEvents",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseReadEventsReply(replied.value),
        what: "sashaReadEvents",
      }) satisfies CallOutcome<ReadEventsReply>;
    },

    async appendEvent(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaWriteEvent(spec),
        what: "sashaWriteEvent",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseWriteEventReply(replied.value),
        what: "sashaWriteEvent",
      }) satisfies CallOutcome<WriteEventReply>;
    },
  };
}

export function appsScriptCandidateCommentsApi({ call }: { call: ServerCall }): CandidateCommentsApi {
  return {
    async read(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaCandidateComments(spec),
        what: "sashaCandidateComments",
        // THE HEAVY ONE, and the one most often made to wait. It is a Drive call PER CANDIDATE,
        // and on a cold start it queues behind the slides window fetching and converting every
        // candidate. At the 25 s default it was killed mid-queue and the window printed "open
        // comments could not be read" over a read that was merely waiting its turn.
        budgetMs: COMMENT_READ_BUDGET_MS,
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseCandidateCommentsReply(replied.value),
        what: "sashaCandidateComments",
      }) satisfies CallOutcome<CandidateCommentsReply>;
    },
  };
}

export function appsScriptFeedbackApi({ call }: { call: ServerCall }): FeedbackApi {
  return {
    async send(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaSendFeedback(spec),
        what: "sashaSendFeedback",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseSendFeedbackReply(replied.value),
        what: "sashaSendFeedback",
      }) satisfies CallOutcome<SendFeedbackReply>;
    },

    async read(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReadFeedback(spec),
        what: "sashaReadFeedback",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseReadFeedbackReply(replied.value),
        what: "sashaReadFeedback",
      }) satisfies CallOutcome<ReadFeedbackReply>;
    },

    // Both go through the same rate-limited `call` as every poll, so a reply cannot be the one
    // path that escapes call-budget.ts. They are user-initiated -- one call per press -- and the
    // read that brings the reply back is a single flagged re-read, never a loop.
    async reply(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReplyComment(spec),
        what: "sashaReplyComment",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseReplyCommentReply(replied.value),
        what: "sashaReplyComment",
      }) satisfies CallOutcome<ReplyCommentReply>;
    },

    async resolve(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaResolveComment(spec),
        what: "sashaResolveComment",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseResolveCommentReply(replied.value),
        what: "sashaResolveComment",
      }) satisfies CallOutcome<ReplyCommentReply>;
    },
  };
}

/**
 * THE THREAD RAIL'S TWO BUTTONS, over the same rate-limited `call` as every poll -- a reply must
 * not be the one path that escapes call-budget.ts. Both are user-initiated, one call per press.
 *
 * `sashaResolveComment` is shared with `appsScriptFeedbackApi` above: Code.gs reads either spec
 * field, so the two surfaces post the same resolve through the same server function while the
 * sidebar is still on `content`. `sashaReplyToComment` is the `text` half of that pair.
 */
export function appsScriptCommentThreadApi({ call }: { call: ServerCall }): CommentThreadApi {
  return {
    async reply(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReplyToComment(spec),
        what: "sashaReplyToComment",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseCommentReply(replied.value),
        what: "sashaReplyToComment",
      }) satisfies CallOutcome<CommentReplyReply>;
    },

    async resolve(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaResolveComment(spec),
        what: "sashaResolveComment",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseCommentReply(replied.value),
        what: "sashaResolveComment",
      }) satisfies CallOutcome<CommentReplyReply>;
    },
  };
}

export function appsScriptPickerWindowApi({ call }: { call: ServerCall }): PickerWindowApi {
  return {
    async openPicker(target) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaOpenPicker(target),
        what: "sashaOpenPicker",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseOpenPickerReply(replied.value),
        what: "sashaOpenPicker",
      }) satisfies CallOutcome<OpenPickerReply>;
    },

    async takePickerTarget() {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaTakePickerTarget(),
        what: "sashaTakePickerTarget",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parsePickerTargetReply(replied.value),
        what: "sashaTakePickerTarget",
      }) satisfies CallOutcome<PickerTargetReply>;
    },

    async openDefectReport(spec) {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaOpenDefectReport(spec),
        what: "sashaOpenDefectReport",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseOpenPickerReply(replied.value),
        what: "sashaOpenDefectReport",
      }) satisfies CallOutcome<OpenPickerReply>;
    },

    async reportWindowUrl() {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaReportWindowUrl({}),
        what: "sashaReportWindowUrl",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseReportWindowUrl(replied.value),
        what: "sashaReportWindowUrl",
      }) satisfies CallOutcome<string | null>;
    },
  };
}

export function appsScriptReportTargetApi({ call }: { call: ServerCall }): ReportTargetApi {
  return {
    async takeTarget() {
      const replied = await call<unknown>({
        invoke: (runner) => runner.sashaTakeReportTarget(),
        what: "sashaTakeReportTarget",
      });
      if (replied.kind !== "ok") return replied;
      return outcomeOf({
        parsed: parseReportTargetReply(replied.value),
        what: "sashaTakeReportTarget",
      }) satisfies CallOutcome<ReportTargetReply>;
    },
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
