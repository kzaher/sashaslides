// IDENTIFIERS for everything a collaborator can address: slides, elements, layouts, assets, comment
// threads, transition scripts, people, the commands themselves, and the editor's own effect
// requests (uploads, notices, transition runs).
//
// Three decisions live here:
//
//  * BRANDED STRINGS. A `SlideId` and an `ElementId` are both strings at runtime, but swapping one
//    for the other is the classic bug of a document model with many id kinds (a command that
//    "deletes element <slide id>" type-checks with plain strings). The brand makes it a compile
//    error. A brand is only ever applied by a parse function or a minting function below, never by
//    a cast at a call site.
//
//  * GOOGLE SLIDES OBJECT ID RULES, from day one. Milestone 3 exports a document to Slides with
//    `batchUpdate`, where every created object carries a caller-chosen `objectId` that must be 5 to
//    50 characters, start with a letter, digit or underscore, and continue with letters, digits,
//    `_`, `-` or `:`. Every engine id satisfies that, so an element keeps ONE identity across the
//    engine and Slides, and re-export can update objects in place instead of mapping ids.
//
//  * IDS ARE MINTED FROM STATE, NOT FROM A RANDOM CALL. The editor's reducer must stay pure and
//    replayable, yet it creates ids (a new slide, a duplicated element, an upload, a notice). So
//    the editor state carries an `IdSeed`: a session prefix of 8 random characters, drawn ONCE by
//    the composition root, plus a counter. `mintId` returns the id and the next seed, so replaying
//    the same events from the same state reproduces the same ids. 8 characters from a 62-letter
//    alphabet is about 47 bits per session, far beyond what the sessions of one deck can collide
//    on, and the counter makes ids within a session unique by construction.

declare const brand: unique symbol;

/** A string that has been checked to be a valid id of one kind. */
export type Branded<TValue, TBrand extends string> = TValue & { readonly [brand]: TBrand };

export type DeckId = Branded<string, "DeckId">;
export type SlideId = Branded<string, "SlideId">;
export type ElementId = Branded<string, "ElementId">;
export type LayoutId = Branded<string, "LayoutId">;
/** Content address of an uploaded image or font: the lowercase hexadecimal SHA-256 of its bytes. */
export type AssetId = Branded<string, "AssetId">;
export type ThreadId = Branded<string, "ThreadId">;
export type MessageId = Branded<string, "MessageId">;
export type TransitionScriptId = Branded<string, "TransitionScriptId">;
/** A table row or column. Rows and columns are addressed by id, not index, so a concurrent insert
 *  of a row cannot shift another collaborator's cell edit into the wrong row. */
export type TableRowId = Branded<string, "TableRowId">;
export type TableColumnId = Branded<string, "TableColumnId">;
/** Paragraphs sharing a list id number together. */
export type ListId = Branded<string, "ListId">;
/** A person (signed-in account, or the agent) as comments, presence and approvals name them. */
export type PersonId = Branded<string, "PersonId">;
/** One queued edit, so the editor can match an outcome to the intent that caused it. */
export type CommandId = Branded<string, "CommandId">;
/** One request to the discussion log (create a thread, reply, resolve ...). */
export type DiscussionRequestId = Branded<string, "DiscussionRequestId">;
/** An image the editor is storing in the asset store. */
export type UploadId = Branded<string, "UploadId">;
/** A notice shown in the editor's notice stack. */
export type NoticeId = Branded<string, "NoticeId">;
/** One transition run in the presenter. */
export type TransitionRunId = Branded<string, "TransitionRunId">;
/** One sandboxed runner frame in the presenter. */
export type RunnerId = Branded<string, "RunnerId">;

/** What the editor state carries to mint ids without calling a random source (see the header). */
export type IdSeed = Readonly<{ sessionPrefix: string; counter: number }>;

/** The id kinds `mintId` can produce, with the branded type each one yields. */
export type MintedIdByKind = Readonly<{
  slide: SlideId;
  element: ElementId;
  layout: LayoutId;
  thread: ThreadId;
  message: MessageId;
  transitionScript: TransitionScriptId;
  tableRow: TableRowId;
  tableColumn: TableColumnId;
  list: ListId;
  command: CommandId;
  discussionRequest: DiscussionRequestId;
  upload: UploadId;
  notice: NoticeId;
  transitionRun: TransitionRunId;
  runner: RunnerId;
}>;

export type ObjectIdKind = keyof MintedIdByKind;

/** A uniform random number in [0, 1), injected so tests are deterministic. */
export type RandomSource = () => number;

export const OBJECT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_\-:]{4,49}$/;

export const SESSION_PREFIX_LENGTH = 8;

/** True when `candidate` is usable as a Google Slides `objectId` (see the header). */
export function isObjectId(candidate: string): boolean {
  return OBJECT_ID_PATTERN.test(candidate);
}

/**
 * The next id of `kind`, and the seed to store for the one after it.
 * `mintId({ seed: { sessionPrefix: "Qx81mPa0", counter: 41 }, kind: "element" })`
 * -> `{ id: "el_Qx81mPa015", seed: { sessionPrefix: "Qx81mPa0", counter: 42 } }` (counter in base 36).
 */
export function mintId<TKind extends ObjectIdKind>(
  options: Readonly<{ seed: IdSeed; kind: TKind }>,
): Readonly<{ id: MintedIdByKind[TKind]; seed: IdSeed }> {
  const text = `${PREFIX[options.kind]}_${options.seed.sessionPrefix}${options.seed.counter.toString(36)}`;
  return {
    // The prefix, a session prefix drawn from ALPHABET and a base-36 counter always match
    // OBJECT_ID_PATTERN (ids.test.ts proves it at the extremes); the brand records that.
    id: text as MintedIdByKind[TKind],
    seed: { sessionPrefix: options.seed.sessionPrefix, counter: options.seed.counter + 1 },
  };
}

/** The 8 random characters a session's ids start with; drawn once, at the composition root. */
export function newSessionPrefix(random: RandomSource): string {
  let prefix = "";
  for (let index = 0; index < SESSION_PREFIX_LENGTH; index += 1) {
    prefix += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length] ?? "0";
  }
  return prefix;
}

/** Parse-boundary guard for ids read from untrusted input (a pasted clipboard payload, a message). */
export function parseSlideId(candidate: string): SlideId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as SlideId) : null;
}

export function parseElementId(candidate: string): ElementId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as ElementId) : null;
}

/**
 * An asset id is a content address, not an object id: the lowercase hexadecimal SHA-256 of the
 * bytes, 64 characters -- longer than OBJECT_ID_PATTERN allows. Assets never become Slides objects
 * (milestone 3 uploads the bytes and Slides names the image), so the object-id rule does not apply.
 */
export function parseAssetId(candidate: string): AssetId | null {
  // The brand is only a compile-time marker; the content-address pattern is the runtime invariant.
  return ASSET_ID_PATTERN.test(candidate) ? (candidate as AssetId) : null;
}

export const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Deck ids are minted by the deck server as `dk_` + 22 random base-62 characters. */
export function parseDeckId(candidate: string): DeckId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as DeckId) : null;
}

export function parsePersonId(candidate: string): PersonId | null {
  // Person ids come from the account service; the same object-id shape keeps them printable.
  return isObjectId(candidate) ? (candidate as PersonId) : null;
}

export function parseLayoutId(candidate: string): LayoutId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as LayoutId) : null;
}

export function parseThreadId(candidate: string): ThreadId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as ThreadId) : null;
}

export function parseMessageId(candidate: string): MessageId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as MessageId) : null;
}

/** A deck address's `?reviewTransitionScript=` value, an agent's tool input, a pasted script. */
export function parseTransitionScriptId(candidate: string): TransitionScriptId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as TransitionScriptId) : null;
}

export function parseListId(candidate: string): ListId | null {
  // The brand is only a compile-time marker; the pattern check is the runtime invariant.
  return isObjectId(candidate) ? (candidate as ListId) : null;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Total over ObjectIdKind: adding a kind without a prefix is a compile error. */
const PREFIX: Readonly<Record<ObjectIdKind, string>> = {
  slide: "sl",
  element: "el",
  layout: "ly",
  thread: "th",
  message: "ms",
  transitionScript: "tr",
  tableRow: "rw",
  tableColumn: "cl",
  list: "ls",
  command: "cm",
  discussionRequest: "dq",
  upload: "up",
  notice: "nt",
  transitionRun: "rn",
  runner: "rr",
};
