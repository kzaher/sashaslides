// COMMENTS AND ANNOTATIONS: threads anchored to a slide, optionally to an element or a text range
// and a region, with markings drawn over the slide, replies, and resolve/reopen.
//
// Key decisions:
//
//  * A SERVER-AUTHORITATIVE, APPEND-ONLY LOG, NOT A SHARED DOCUMENT. "Only the author may edit a
//    message" cannot be enforced on a shared Yjs document: a commenter's client can rewrite any
//    item, and a server cannot partially accept a Yjs update. Comments do not need automatic
//    merging either -- each request is small, independent and ordered. So the discussion is a log
//    of `DiscussionLogEntry`s; the AUTHORITY (the in-memory store in milestone 1, the deck server
//    from milestone 2) checks each request against the requester's identity, stamps the actor and
//    the time, appends it, and every replica reduces the same log to the same snapshot with the
//    pure `reduceDiscussionLog` (model module). Thread status is therefore one reduced value: a
//    concurrent resolve and reopen are two ordered entries, never a half-resolved thread.
//
//  * ANCHORS FOLLOW THE ELEMENT. When the target is an element (or text in it), `region` and every
//    marking are FRACTIONS OF THE ELEMENT'S FRAME, so moving or resizing the element carries the
//    comment and its drawing with it. A slide-level anchor uses fractions of the slide. One unit for
//    all markings (`FractionalPoint`, `FractionalRegion`).
//
//  * ANCHORS DEGRADE, THEY DO NOT DISAPPEAR. A thread whose element was deleted falls back to
//    `elementFrameAtCreation` on its slide, with "the element was removed"; a thread whose slide
//    was deleted is listed under "on deleted slides" until resolved. Cut and paste within a deck
//    KEEPS element ids when they are free (a move), so it does not orphan comments. Placement is
//    computed by a pure selector in the state module (`arrangeThreads`), from the discussion, the
//    document and the resolved text anchors.
//
//  * TEXT ANCHORS ARE Yjs RELATIVE POSITIONS (document-store.ts `EncodedTextAnchor`), so the
//    anchored range follows the text through everyone's edits instead of drifting by index.
//
//  * THE AGENT IS A PARTICIPANT. Claude reads and answers threads through the connector (the
//    comment bot already does this for Google Slides comments); `Person.kind` distinguishes it so
//    the view can label it and so "answering IS the completion signal" works the same way.
//
//  * OUTSIDE THE UNDO HISTORY: resolving a comment is not something Ctrl+Z should take back.

import type { Observable } from "rxjs";
import type { EncodedTextAnchor, TextRange } from "./document-store.ts";
import type { Box, FractionalPoint, FractionalRegion } from "./geometry.ts";
import type { DiscussionRequestId, ElementId, MessageId, PersonId, SlideId, ThreadId } from "./ids.ts";
import type { HexadecimalColour } from "./style.ts";

export type Person = Readonly<{
  id: PersonId;
  displayName: string;
  /** Presence and comment avatars; one of the scheme's peer colours (theme/tidepool-theme.ts). */
  colourIndex: number;
  kind: "person" | "agent";
}>;

export type CommentTarget =
  | Readonly<{ kind: "slide" }>
  | Readonly<{ kind: "element"; elementId: ElementId }>
  | Readonly<{ kind: "text"; elementId: ElementId; anchor: EncodedTextAnchor; quotedText: string }>;

export type CommentAnchor = Readonly<{
  slideId: SlideId;
  target: CommentTarget;
  /**
   * The area the comment is about, as fractions of the element's frame (element or text target)
   * or of the slide (slide target); null pins it to that box's top-right corner.
   */
  region: FractionalRegion | null;
  /** The element's frame when the thread was created, slide units: the fallback once it is deleted. */
  elementFrameAtCreation: Box | null;
}>;

/** A mark drawn as part of a comment: the annotation layer. Same reference box as `region`. */
export type Marking =
  | Readonly<{ kind: "pen"; points: readonly FractionalPoint[]; colour: HexadecimalColour; width: number }>
  | Readonly<{ kind: "rectangle"; region: FractionalRegion; colour: HexadecimalColour }>
  | Readonly<{ kind: "arrow"; from: FractionalPoint; to: FractionalPoint; colour: HexadecimalColour }>
  | Readonly<{ kind: "highlight"; region: FractionalRegion; colour: HexadecimalColour }>;

export type CommentMessage = Readonly<{
  id: MessageId;
  author: Person;
  /** Plain text; a mention reads `@displayName` in it. */
  body: string;
  /**
   * The people this message mentions, by id, as the composer chose them from the members list.
   * The server keeps only ids of current members (others are dropped, at most
   * `COLLABORATION_LIMITS.maximumMentionsPerMessage`); the view highlights `@displayName` for each.
   * Stored as ids, not parsed from the text, because two members may share a display name.
   */
  mentions: readonly PersonId[];
  createdAt: number;
  editedAt: number | null;
  /** How many times the author edited it, counted by the fold; the deck server limits it (`COLLABORATION_LIMITS.maximumEditsPerMessage`). */
  editCount: number;
}>;

export type ThreadStatus =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "resolved"; resolvedBy: Person; resolvedAt: number }>;

export type CommentThread = Readonly<{
  id: ThreadId;
  anchor: CommentAnchor;
  status: ThreadStatus;
  createdBy: Person;
  createdAt: number;
  /** Oldest first; the first message is the comment itself. Deleted messages are absent. */
  messages: readonly CommentMessage[];
  markings: readonly Marking[];
}>;

/** The reduced log. Threads in log order; ordering for display is the state module's selector. */
export type DiscussionSnapshot = Readonly<{
  /** The sequence number of the last entry reduced; 0 for an empty log. */
  sequence: number;
  threads: readonly CommentThread[];
}>;

export const EMPTY_DISCUSSION: DiscussionSnapshot = { sequence: 0, threads: [] };

/** What a client asks the authority to do. Ids are minted by the client (ids.ts). */
export type DiscussionCommand =
  | Readonly<{
      kind: "createThread";
      threadId: ThreadId;
      anchor: CommentAnchor;
      markings: readonly Marking[];
      messageId: MessageId;
      body: string;
      mentions: readonly PersonId[];
    }>
  | Readonly<{ kind: "reply"; threadId: ThreadId; messageId: MessageId; body: string; mentions: readonly PersonId[] }>
  /** Only the message's author; rejected `notAuthor` otherwise. */
  | Readonly<{ kind: "editMessage"; threadId: ThreadId; messageId: MessageId; body: string; mentions: readonly PersonId[] }>
  /** Only the message's author. */
  | Readonly<{ kind: "deleteMessage"; threadId: ThreadId; messageId: MessageId }>
  | Readonly<{ kind: "resolveThread"; threadId: ThreadId }>
  | Readonly<{ kind: "reopenThread"; threadId: ThreadId }>
  /**
   * Only the thread's creator, or a role with `moderateDiscussion` (deck-access.ts). The AUTHORITY
   * decides (the deck server refuses anyone else with `notPermitted`); the log's fold
   * (model/discussion-log.ts) applies a `deleteThread` from any actor the authority accepted, since
   * a fold cannot see roles. The in-memory authority of milestone 1 stays creator-only.
   */
  | Readonly<{ kind: "deleteThread"; threadId: ThreadId }>;

export type DiscussionRequest = Readonly<{ requestId: DiscussionRequestId; command: DiscussionCommand }>;

/** One accepted request, as the authority recorded it. `actor` and `at` are the AUTHORITY's, never the client's. */
export type DiscussionLogEntry = Readonly<{
  sequence: number;
  requestId: DiscussionRequestId;
  actor: Person;
  at: number;
  command: DiscussionCommand;
}>;

export type DiscussionRejectionReason =
  | "threadMissing"
  | "messageMissing"
  | "notAuthor"
  | "duplicateId"
  | "invalidValue"
  | "notPermitted"
  /** The deck's discussion is full: threads per deck, messages per thread, edits per message or text per deck (`COLLABORATION_LIMITS`). */
  | "limitReached"
  /**
   * The deck server dropped the request because its connection was over the rate. NOT remembered as
   * the request's outcome: sending the same request again once the rate allows can succeed.
   */
  | "rateLimited";

export type DiscussionOutcome =
  | Readonly<{ kind: "applied"; requestId: DiscussionRequestId; sequence: number }>
  | Readonly<{ kind: "rejected"; requestId: DiscussionRequestId; reason: DiscussionRejectionReason; message: string }>;

/**
 * The client's view of the discussion log. Milestone 1: an in-memory authority acting as `actor`.
 * Milestone 2: a replica of the deck server's log over the deck's WebSocket, with the same shape.
 */
export interface DiscussionStore extends Disposable {
  snapshot(): DiscussionSnapshot;
  /** Hot: every new snapshot after entries are appended (by anyone). */
  readonly changes: Observable<DiscussionSnapshot>;
  /** Asks the authority; resolves with its verdict. Never throws: transport failures resolve as rejected. */
  submit(request: DiscussionRequest): Promise<DiscussionOutcome>;
}

/** The pure fold every replica runs; the model module implements it. Unknown references skip the entry. */
export type ReduceDiscussionLog = (snapshot: DiscussionSnapshot, entry: DiscussionLogEntry) => DiscussionSnapshot;

/**
 * A comment as the editor drafts it, before the text range is encoded. The discussion feedback
 * turns a `text` draft into an `EncodedTextAnchor` with `DocumentStore.encodeTextAnchor`.
 */
export type CommentTargetDraft =
  | Readonly<{ kind: "slide" }>
  | Readonly<{ kind: "element"; elementId: ElementId }>
  | Readonly<{ kind: "text"; elementId: ElementId; range: TextRange; quotedText: string }>;
