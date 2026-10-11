// The Drive/Slides surfaces the sidebar needs, as INTERFACES only. Everything above this file
// depends on the interface, so the observer, the PICK writer and the render artifact are exercised
// in unit tests against a fake with no network (fake-drive.ts) rather than by patching globals.
//
// WHAT CHANGED FROM THE EXTENSION'S drive-api.ts. There the same file also held `httpDriveApi` /
// `httpSlidesApi` -- hand-written `fetch` against googleapis.com with a bearer token the extension
// had to obtain, cache and refresh itself. In the add-on, every one of those calls happens in
// Code.gs under `ScriptApp.getOAuthToken()`, so the HTTP half moved out of TypeScript entirely and
// what is left is the shape plus `createdObjectIdsOf`. Nothing here knows about `google.script.run`
// either: bridge-client.ts is the only implementation and it is injected.
//
// `listByRoles` is gone. It asked Drive for `appProperties has {key='sashaSlides' ...}`, which
// CANNOT work across components -- appProperties are private to the writing OAuth client, so the
// add-on would have got an empty result with no error. `scanInbox` is the name walk PROTOCOL.md
// specifies in its place.

import type {
  CallOutcome,
  CandidateCommentsReply,
  CandidateCommentsSpec,
  InsertReply,
  InsertRequestSpec,
  OpenPickerReply,
  ProposalMark,
  ReadEventsReply,
  ReadEventsSpec,
  PickerTargetReply,
  PickerTargetSpec,
  ReadFeedbackReply,
  ReadFeedbackSpec,
  RenderPreviewsReply,
  CommentReplyReply,
  CommentReplySpec,
  ReplyCommentReply,
  ReplyCommentSpec,
  ReportTargetReply,
  ReportTargetSpec,
  SendFeedbackReply,
  WriteEventReply,
  WriteEventSpec,
} from "./bridge.ts";
import type { SendFeedbackSpec } from "./feedback.ts";
import type { SlidesApiRequest } from "./converter-contract.ts";

export type DriveApi = Readonly<{
  /**
   * One poll of the inbox: "Sasha Slides Inbox" -> every proposal folder -> whether each one has a
   * `READY` and a `PICK`. Both marks come back together because the observer always needs them at
   * once: a proposal that already has a PICK has been answered and must not be offered again.
   */
  scanInbox(spec: Readonly<{ pageSize: number }>): Promise<CallOutcome<readonly ProposalMark[]>>;
  /** READY, manifest.json and NN.html are all just text read by file id. */
  downloadText(fileId: string): Promise<CallOutcome<string>>;
}>;

/**
 * THE SESSION LOG, as Drive has it: the `events/` subfolder of one proposal folder, every file's
 * name and bytes in one round trip. Its own capability because it is the one thing BOTH surfaces
 * read and NEITHER owns -- the server writes most of it -- and because a per-file read would be N
 * round trips to Google for a folder that is polled.
 *
 * `appendEvent` CREATES a file; there is no update and no append. Drive has no append, and a
 * read-modify-write from two writers that cannot see each other loses one of their events
 * (PROTOCOL.md).
 */
export type SessionLogApi = Readonly<{
  readEvents(spec: ReadEventsSpec): Promise<CallOutcome<ReadEventsReply>>;
  appendEvent(spec: WriteEventSpec): Promise<CallOutcome<WriteEventReply>>;
}>;

/**
 * THE UNRESOLVED COUNTS' one read: the comment threads on each candidate's own `NN.html`. Its own
 * capability rather than another method on `FeedbackApi` because `FeedbackApi` is the DECK's
 * comment pane (the conversation's transport) and this is the candidates' -- and because this one
 * is a batch: both surfaces need every candidate's count at once to render a grid or a log.
 */
export type CandidateCommentsApi = Readonly<{
  read(spec: CandidateCommentsSpec): Promise<CallOutcome<CandidateCommentsReply>>;
}>;

export type SlidesApi = Readonly<{
  /**
   * The batchUpdate that puts the picked candidate in the deck, plus the best-effort render
   * artifact in the same round trip (see render-artifact.ts for why they are not separable).
   */
  insert(spec: InsertRequestSpec): Promise<CallOutcome<InsertReply>>;
  /**
   * The candidates as GOOGLE renders them. A throwaway deck, one page per candidate, photographed
   * and then deleted -- the only way to see the real thing before anything is in the user's deck.
   */
  renderPreviews(spec: RenderPreviewsSpec): Promise<CallOutcome<RenderPreviewsReply>>;
}>;

/** What to photograph: each candidate's 1-based index and the requests the converter emitted. */
export type RenderPreviewsSpec = Readonly<{
  slides: readonly Readonly<{ index: number; requests: readonly SlidesApiRequest[] }>[];
}>;

/**
 * THE CONVERSATION's transport: the user's messages, as native Google Slides comments on the
 * presentation, and whatever has been said back under them. The server half of the product reads
 * the same comments and answers by replying to the thread -- see feedback.ts for the wire text.
 */
export type FeedbackApi = Readonly<{
  send(spec: SendFeedbackSpec): Promise<CallOutcome<SendFeedbackReply>>;
  read(spec: ReadFeedbackSpec): Promise<CallOutcome<ReadFeedbackReply>>;
  /** Answer an existing thread, in the user's own words, on the file the thread lives on. */
  reply(spec: ReplyCommentSpec): Promise<CallOutcome<ReplyCommentReply>>;
  /** Close a thread -- Google's "Mark as resolved and hide discussion". */
  resolve(spec: ReplyCommentSpec): Promise<CallOutcome<ReplyCommentReply>>;
}>;

/**
 * ANSWERING AND CLOSING A THREAD THAT ALREADY EXISTS -- the thread rail's two buttons.
 *
 * Its own capability, and not two more methods on `FeedbackApi`, because the surfaces need
 * different halves: the slides window drives threads on a CANDIDATE and never sends a new deck
 * comment, so handing it `send`/`read` would be handing it reach it has no business having. Both
 * methods take the file the thread lives on, like every other call in the comment channel --
 * nothing here knows whether that is the presentation or a candidate's own NN.html.
 *
 * A reply and a resolve are ONE Drive endpoint (a resolve is a reply carrying `action: "resolve"`),
 * so they share a reply shape; they are two methods so a caller cannot close a thread by passing
 * the wrong flag. `resolved` comes back from Drive rather than from which method was called.
 */
export type CommentThreadApi = Readonly<{
  /** Post the user's words into the thread. Leaves it open. */
  reply(spec: CommentReplySpec): Promise<CallOutcome<CommentReplyReply>>;
  /** Close the thread. Drive refuses a reply with no content, so a note always goes with it. */
  resolve(spec: CommentReplySpec): Promise<CallOutcome<CommentReplyReply>>;
}>;

/**
 * THE SIDEBAR'S one reach into the other surface: asking the host to show the candidates dialog.
 *
 * Its own capability, and not a method on `DriveApi` or `SlidesApi`, because it touches neither
 * Drive nor the deck -- it is a request to the Apps Script HOST to open a window. The sidebar
 * cannot do it itself: `showModelessDialog` is a server-side `SlidesApp.getUi()` call, and the two
 * HtmlService documents share nothing (UI-CONTRACT.md).
 */
export type PickerWindowApi = Readonly<{
  /**
   * Show the slides window. With a target it comes up ON that candidate -- the sidebar's
   * "Open" on a comment about slide 3 should land on slide 3, not on wherever the window was.
   */
  openPicker(target?: PickerTargetSpec): Promise<CallOutcome<OpenPickerReply>>;
  /** What the window was asked to open on. Reading CLEARS it, so a later open is unaffected. */
  takePickerTarget(): Promise<CallOutcome<PickerTargetReply>>;
  /**
   * Show the DEFECT-REPORT window -- a third HtmlService document of its own, not a mode of the
   * slides window. Its own method rather than an argument to `openPicker`, so a caller cannot pass
   * the wrong job: the target is recorded server-side before the window is shown, because the
   * documents share nothing.
   */
  openDefectReport(spec: ReportTargetSpec): Promise<CallOutcome<OpenPickerReply>>;
  /**
   * The web-app URL, or null when the script is not deployed as one.
   *
   * It is asked for ONCE AT STARTUP, not when the button is pressed: `window.open` is blocked
   * unless it runs inside the synchronous call stack of a real click, and an `await` in that
   * handler ends the trusted gesture.
   */
  reportWindowUrl(): Promise<CallOutcome<string | null>>;
}>;

/**
 * THE REPORT WINDOW's side of that handoff: which candidate it was opened on. Its own capability
 * because only that window asks -- and because reading it CONSUMES it, so a window opened later
 * does not come up on a slide the user finished with.
 */
export type ReportTargetApi = Readonly<{
  takeTarget(): Promise<CallOutcome<ReportTargetReply>>;
}>;

/** Writing `PICK` -- deliberately its own capability, because it is the one file the UI may create. */
export type PickApi = Readonly<{
  createPick(
    spec: Readonly<{
      folderId: string;
      name: string;
      mimeType: string;
      body: string;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<CallOutcome<Readonly<{ fileId: string }>>>;
}>;

/**
 * Every objectId any reply in a batchUpdate response reports as created. Slides names the field
 * `objectId` on createSlide/createShape/createTable/createImage replies alike, so one sweep covers
 * whatever requests the converter emitted without this file knowing the converter's repertoire.
 *
 * It stays in TypeScript -- rather than in Code.gs next to the call that produced the reply --
 * precisely so it is testable: `PICK.insertedObjectIds` is what tells the MCP server what landed.
 */
export function createdObjectIdsOf(response: unknown): readonly string[] {
  const replies = asRecord(response)?.["replies"];
  if (!Array.isArray(replies)) return [];
  const ids: string[] = [];
  for (const reply of replies) {
    const record = asRecord(reply);
    if (record === null) continue;
    for (const value of Object.values(record)) {
      const objectId = asRecord(value)?.["objectId"];
      if (typeof objectId === "string" && objectId !== "") ids.push(objectId);
    }
  }
  return ids;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
