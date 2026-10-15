/**
 * CLAUDE'S DECK TOOLS on the connector (SPEC.md 21.14; vocabulary in
 * engine/src/contracts/assistant-deck-tools.ts):
 *
 *   deck_list                 the account's decks, with addresses and roles
 *   deck_create               a new blank deck owned by the account
 *   deck_read                 a deck's outline (ids, frames, plain text); `full` adds slide values
 *   deck_edit                 edits in a person's words, applied as ONE undo step, all or nothing
 *   deck_write_transition     a scripted transition, saved UNAPPROVED for a person to review
 *   deck_revert               undo an agent session's edits (this session's by default)
 *   deck_read_comments        the discussion, as threads an agent can act on
 *   deck_reply_comment        reply in a thread as the account's agent ("Claude")
 *   deck_resolve_comment      optionally reply, then resolve
 *   deck_await_comments       long-poll for new comments, with progress notifications
 *
 * Every tool resolves the caller through `callerFor` (the MCP bearer's Google subject -> the
 * account) and acts ONLY through `DeckService`, whose handles are leases on the deck's live room:
 * an edit is applied to the replica every open editor is connected to, so collaborators see it at
 * once, and is recorded under this session's agent session so a person can take it back ("Undo
 * Claude's edit"). The role is checked here for a clear answer and again by the room, which is the
 * authority.
 *
 * Without a deck service (stdio, or a connector started without `--store`) every tool is still
 * listed and answers why it cannot work, so a client's tool list does not depend on how the
 * connector was started and the model learns where decks live.
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomInt } from "node:crypto";
import type { AssistantEditOutcome, AssistantTransitionScript } from "../engine/src/contracts/assistant-deck-tools.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { CommandAuthor, CommandEnvelope, CommandRejection, DocumentCommand } from "../engine/src/contracts/commands.ts";
import { roleAllows, type DeckPermission, type DeckRole } from "../engine/src/contracts/deck-access.ts";
import { TRANSITION_REVIEW_QUERY } from "../engine/src/contracts/deck-api.ts";
import type { DiscussionCommand, DiscussionOutcome, DiscussionSnapshot } from "../engine/src/contracts/discussion.ts";
import type { AssetRecord, DocumentSnapshot } from "../engine/src/contracts/document.ts";
import { mintId, newSessionPrefix, type DeckId, type IdSeed, type MintedIdByKind, type ObjectIdKind, type SlideId } from "../engine/src/contracts/ids.ts";
import type { DeckCaller, DeckCallerResolution, DeckHandle, DeckService, RegisterDeckTools } from "../deck-contracts/deck-service-contract.ts";
import { pollProgressReporter, type ProgressSink } from "../long-poll-progress.ts";
import type { AssistantEditRequest } from "./assistant-edit-request.ts";
import { assistantThreads, discussionChanges, type DiscussionChange } from "./assistant-threads.ts";
import { deckAddress, deckOutline } from "./deck-outline.ts";
import { describeRejection, editIndexOfRejection, expandAssistantEdits } from "./edit-expansion.ts";
import { fetchImageSource } from "./image-source.ts";
import { expandTransitionScript } from "./transition-script-edit.ts";
import {
  DECK_AWAIT_COMMENTS_INPUT,
  DECK_CREATE_INPUT,
  DECK_EDIT_INPUT,
  DECK_LIST_INPUT,
  DECK_READ_COMMENTS_INPUT,
  DECK_READ_INPUT,
  DECK_REPLY_COMMENT_INPUT,
  DECK_RESOLVE_COMMENT_INPUT,
  DECK_REVERT_INPUT,
  DECK_WRITE_TRANSITION_INPUT,
  parsedEditRequest,
} from "./tool-input-schemas.ts";

/** What every tool answers when the connector has no deck service. */
export const DECKS_UNAVAILABLE_MESSAGE =
  "Sasha decks are not available on this connector: it runs without a deck store (stdio, or started without --store). " +
  "Decks live on the remote connector at https://sashaslides.com/mcp, signed in with the account that owns or shares them.";

export const registerDeckTools: RegisterDeckTools = (options) => {
  const tools: Tools = { ...options, discussionMemory: new Map() };
  const { server } = options;

  server.registerTool(
    "deck_list",
    {
      title: "List Sasha decks",
      description: "The Sasha decks this account owns or was invited to, most recently updated first, with each deck's address and your role.",
      inputSchema: DECK_LIST_INPUT,
    },
    async (_arguments, extra) =>
      withCaller({ tools, extra }, async ({ service, resolution }) => {
        const decks = await service.listDecks({ caller: resolution.caller });
        return structuredResult({
          count: decks.length,
          decks: decks.map((deck) => ({
            deckId: deck.deckId,
            title: deck.title,
            role: deck.role,
            owner: deck.owner.displayName,
            address: deckAddress({ publicUrl: tools.publicUrl, deckId: deck.deckId }),
            updatedAt: new Date(deck.updatedAt).toISOString(),
          })),
        });
      }),
  );

  server.registerTool(
    "deck_create",
    {
      title: "Create a Sasha deck",
      description: "A new deck owned by this account: a default theme and layouts and one empty title slide. Returns its deckId and the address to share with the user.",
      inputSchema: DECK_CREATE_INPUT,
    },
    async ({ title }, extra) =>
      withCaller({ tools, extra }, async ({ service, resolution }) => {
        const outcome = await service.createDeck({ caller: resolution.caller, title });
        switch (outcome.kind) {
          case "opened": {
            await using deck = outcome.deck;
            return structuredResult({ deckId: deck.deckId, title: deck.summary().title, address: deckAddress({ publicUrl: tools.publicUrl, deckId: deck.deckId }) });
          }
          case "limitReached":
            return refusalResult(`limitReached: ${outcome.message}`);
          case "notFound":
          case "notPermitted":
            return refusalResult(`${outcome.kind}: this account cannot create decks`);
          case "deckUnreadable":
            return refusalResult(`deckUnreadable: ${outcome.message}`);
          default:
            return assertNever(outcome);
        }
      }),
  );

  server.registerTool(
    "deck_read",
    {
      title: "Read a Sasha deck",
      description:
        "A deck's outline: layouts and their placeholders, every slide in order with its elements (ids, kinds, frames in slide units, plain text), " +
        "transition scripts and open comment count. Read before editing: deck_edit addresses slides and elements by these ids. " +
        "detail 'full' also returns the complete values (styles, text runs) of the slides in slideIds.",
      inputSchema: DECK_READ_INPUT,
    },
    async ({ deckId, detail, slideIds }, extra) =>
      withDeck({ tools, extra, deckId, permission: "read" }, async ({ deck, role }) => {
        const snapshot = deck.snapshot();
        const fullSlideIds = fullSlidesOf({ detail, slideIds, snapshot });
        return structuredResult(
          deckOutline({ snapshot, summary: deck.summary(), role, address: deckAddress({ publicUrl: tools.publicUrl, deckId }), discussion: deck.discussion(), fullSlideIds }),
        );
      }),
  );

  server.registerTool(
    "deck_edit",
    {
      title: "Edit a Sasha deck",
      description:
        "Change a deck the way a person would ask: add, delete, move or restyle slides and elements, set or find-and-replace text, add images (https) " +
        "and tables. Everything in one call is applied together as ONE undo step, or nothing is (the answer names the failing edit). Collaborators " +
        "see the change live with your `summary` and can undo it. Omitted styles come from the theme; omitted frames from the layout. To address " +
        "something added earlier in the same call, give it an `id` of your choosing (e.g. sl_pricing01, el_proCard01). Read the deck first. " +
        "Use one deck_edit per user request.",
      inputSchema: DECK_EDIT_INPUT,
    },
    async ({ deckId, summary, edits }, extra) =>
      withDeck({ tools, extra, deckId, permission: "editDocument" }, async ({ deck, resolution }) =>
        editOutcomeResult(await applyEdits({ tools, deck, resolution, summary, edits: edits.map(parsedEditRequest) })),
      ),
  );

  server.registerTool(
    "deck_write_transition",
    {
      title: "Write a scripted transition",
      description:
        "Save a scripted slide transition (JavaScript calling sashaTransition.define(...), with optional stylesheet and markup) and optionally assign " +
        "it to slides. It is saved UNAPPROVED: it runs only after a person reviews and approves it in the editor, so give the user the " +
        "reviewAddress. Until then those slides fall back to a fade. Pass scriptId to replace one of the deck's scripts.",
      inputSchema: DECK_WRITE_TRANSITION_INPUT,
    },
    async (request, extra) =>
      withDeck({ tools, extra, deckId: request.deckId, permission: "editDocument" }, async ({ deck, resolution }) => writeTransition({ tools, deck, resolution, request })),
  );

  server.registerTool(
    "deck_revert",
    {
      title: "Undo an agent session's edits",
      description:
        "Undo every edit an agent session made to a deck, newest first, keeping anything collaborators changed since. Without agentSessionId it is " +
        "this session's own edits (deck_edit returns the id).",
      inputSchema: DECK_REVERT_INPUT,
    },
    async ({ deckId, agentSessionId }, extra) =>
      withDeck({ tools, extra, deckId, permission: "revertAgentEdits" }, async ({ deck, resolution }) => {
        const outcome = await deck.revertAgentSession({ agentSessionId: agentSessionId ?? resolution.agentSessionId });
        switch (outcome.kind) {
          case "reverted":
          case "nothingToRevert":
            return structuredResult({ ...outcome, agentSessionId: agentSessionId ?? resolution.agentSessionId });
          case "notPermitted":
            return refusalResult(notPermittedMessage({ deck, permission: "revertAgentEdits" }));
          case "failed":
            return refusalResult(`failed: ${outcome.message}`);
          default:
            return assertNever(outcome);
        }
      }),
  );

  server.registerTool(
    "deck_read_comments",
    {
      title: "Read a deck's comments",
      description:
        "The deck's comment threads: slide and number, the element or quoted text they are on, the kinds of marks drawn (pen, rectangle, ...) and " +
        "every message. Returns `sequence`: pass it to deck_await_comments to wait for what comes next.",
      inputSchema: DECK_READ_COMMENTS_INPUT,
    },
    async ({ deckId, status, slideId }, extra) =>
      withDeck({ tools, extra, deckId, permission: "read" }, async ({ deck }) => {
        const discussion = deck.discussion();
        remember({ tools, deckId, discussion });
        return structuredResult({ sequence: discussion.sequence, threads: assistantThreads({ discussion, snapshot: deck.snapshot(), status, slideId }) });
      }),
  );

  server.registerTool(
    "deck_reply_comment",
    {
      title: "Reply to a comment",
      description: "Reply in a deck's comment thread as Claude (labelled as the agent for this account). Answering is how the commenter knows it is done.",
      inputSchema: DECK_REPLY_COMMENT_INPUT,
    },
    async ({ deckId, threadId, body }, extra) =>
      withDeck({ tools, extra, deckId, permission: "comment" }, async ({ deck }) =>
        discussionResult({ deck, outcome: await submitAsAgent({ deck, command: { kind: "reply", threadId, messageId: mintOne("message"), body, mentions: [] } }) }),
      ),
  );

  server.registerTool(
    "deck_resolve_comment",
    {
      title: "Resolve a comment",
      description: "Resolve a deck's comment thread, first replying with `note` when given (say what was changed).",
      inputSchema: DECK_RESOLVE_COMMENT_INPUT,
    },
    async ({ deckId, threadId, note }, extra) =>
      withDeck({ tools, extra, deckId, permission: "comment" }, async ({ deck }) => {
        if (note !== undefined) {
          const replied = await submitAsAgent({ deck, command: { kind: "reply", threadId, messageId: mintOne("message"), body: note, mentions: [] } });
          switch (replied.kind) {
            case "rejected":
              return discussionResult({ deck, outcome: replied });
            case "applied":
              break;
            default:
              return assertNever(replied);
          }
        }
        return discussionResult({ deck, outcome: await submitAsAgent({ deck, command: { kind: "resolveThread", threadId } }) });
      }),
  );

  server.registerTool(
    "deck_await_comments",
    {
      title: "Wait for new comments",
      description:
        "Block until someone comments, replies, resolves or reopens a thread on the deck after `afterSequence`, or until timeoutSeconds pass " +
        "(empty `changes`, timedOut true). Your own replies do not wake it. Returns the new `sequence` to wait from next.",
      inputSchema: DECK_AWAIT_COMMENTS_INPUT,
    },
    async ({ deckId, afterSequence, timeoutSeconds }, extra) =>
      withDeck({ tools, extra, deckId, permission: "read" }, async ({ deck, resolution }) =>
        structuredResult(await awaitComments({ tools, deck, caller: resolution.caller, afterSequence, timeoutMilliseconds: timeoutSeconds * 1000, extra })),
      ),
  );
};

// --- context ------------------------------------------------------------------------------------

type Tools = Parameters<RegisterDeckTools>[0] &
  Readonly<{
    /**
     * Discussion snapshots this server has answered with, by deck and sequence, so a later
     * `deck_await_comments` from that sequence can say exactly what changed since (bounded).
     */
    discussionMemory: Map<string, DiscussionSnapshot>;
  }>;

/** The slice of the SDK's per-request `extra` the tools read. */
type RequestExtra = ProgressSink & Readonly<{ authInfo?: AuthInfo | undefined; sessionId?: string | undefined; signal: AbortSignal }>;

type ResolvedCaller = Extract<DeckCallerResolution, { kind: "ok" }>;

async function withCaller(
  options: Readonly<{ tools: Tools; extra: RequestExtra }>,
  work: (context: Readonly<{ service: DeckService; resolution: ResolvedCaller }>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const service = options.tools.deckService;
  if (service === null) return refusalResult(DECKS_UNAVAILABLE_MESSAGE);
  try {
    const resolution = await options.tools.callerFor({ authInfo: options.extra.authInfo, sessionId: options.extra.sessionId });
    switch (resolution.kind) {
      case "unavailable":
        return refusalResult(resolution.message);
      case "ok":
        return await work({ service, resolution });
      default:
        return assertNever(resolution);
    }
  } catch (cause: unknown) {
    // A tool answers; it never throws into the transport (the model would see a protocol error
    // instead of a reason it can act on).
    return refusalResult(`the deck tool failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function withDeck(
  options: Readonly<{ tools: Tools; extra: RequestExtra; deckId: DeckId; permission: DeckPermission }>,
  work: (context: Readonly<{ deck: DeckHandle; role: DeckRole; resolution: ResolvedCaller }>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  return withCaller(options, async ({ service, resolution }) => {
    const outcome = await service.openDeck({ caller: resolution.caller, deckId: options.deckId });
    switch (outcome.kind) {
      case "opened": {
        // The lease keeps the room loaded for the call and is released on every path.
        await using deck = outcome.deck;
        const role = deck.role();
        // Removed from the deck between opening and now: as for any deck it cannot open.
        if (role === null) return refusalResult(`notFound: there is no deck ${options.deckId} this account can open (deck_list shows the ones it can)`);
        if (!roleAllows({ role, permission: options.permission })) return refusalResult(notPermittedMessage({ deck, permission: options.permission }));
        return await work({ deck, role, resolution });
      }
      case "notFound":
        return refusalResult(`notFound: there is no deck ${options.deckId} this account can open (deck_list shows the ones it can)`);
      case "notPermitted":
        return refusalResult(`notPermitted: this account cannot open deck ${options.deckId}`);
      case "limitReached":
        return refusalResult(`limitReached: ${outcome.message}`);
      case "deckUnreadable":
        return refusalResult(`deckUnreadable: deck ${options.deckId} was not opened. ${outcome.message}`);
      default:
        return assertNever(outcome);
    }
  });
}

/** `full` returns the named slides' values (all of them when none are named); an outline none. */
function fullSlidesOf(options: Readonly<{ detail: "outline" | "full"; slideIds: readonly SlideId[]; snapshot: DocumentSnapshot }>): readonly SlideId[] {
  switch (options.detail) {
    case "outline":
      return [];
    case "full":
      return options.slideIds.length === 0 ? options.snapshot.slides.map((slide) => slide.id) : options.slideIds;
    default:
      return assertNever(options.detail);
  }
}

function notPermittedMessage(options: Readonly<{ deck: DeckHandle; permission: DeckPermission }>): string {
  const role = options.deck.role();
  if (role === null) return `notPermitted: this account is no longer a member of deck ${options.deck.deckId}`;
  return `notPermitted: your role on deck ${options.deck.deckId} is ${role}, which cannot ${PERMISSION_WORDS[options.permission]}; ask the deck's owner for more access`;
}

/** Total over permissions, so a new permission must say what it allows. */
const PERMISSION_WORDS: Readonly<Record<DeckPermission, string>> = {
  read: "read it",
  editDocument: "edit it",
  approveTransitionScript: "approve transition scripts",
  comment: "comment on it",
  moderateDiscussion: "delete other people's comments",
  share: "share it",
  exchangeWithGoogleSlides: "import or export with Google Slides",
  revertAgentEdits: "undo agent edits",
  deleteDeck: "delete it",
};

// --- deck_edit ----------------------------------------------------------------------------------

/**
 * Fetch and store the images, expand the edits against the current snapshot, apply ONE envelope.
 * A `staleText` rejection means the deck changed between reading and applying; the edits are
 * expanded again against the new snapshot once.
 */
async function applyEdits(
  options: Readonly<{ tools: Tools; deck: DeckHandle; resolution: ResolvedCaller; summary: string; edits: readonly AssistantEditRequest[] }>,
): Promise<AssistantEditOutcome | Readonly<{ kind: "notPermitted" | "tooLarge"; message: string }>> {
  const { deck, resolution } = options;
  const images = await storeImages(options);
  switch (images.kind) {
    case "stored":
      break;
    case "rejected":
    case "notPermitted":
    case "tooLarge":
      return images;
    default:
      return assertNever(images);
  }
  for (let attempt = 0; ; attempt += 1) {
    const expansion = expandAssistantEdits({ snapshot: deck.snapshot(), edits: options.edits, images: images.records, seed: freshSeed() });
    switch (expansion.kind) {
      case "rejected":
        return expansion;
      case "expanded":
        break;
      default:
        return assertNever(expansion);
    }
    const envelope = agentEnvelope({ resolution, commands: expansion.commands, seed: expansion.seed });
    const applied = await deck.apply({ envelope, summaryForCollaborators: options.summary });
    switch (applied.kind) {
      case "applied":
        return { kind: "applied", agentSessionId: resolution.agentSessionId, created: expansion.created };
      case "rejected": {
        const rejection = applied.outcome.rejection;
        if (attempt === 0 && WORTH_RETRYING[rejection.reason]) continue;
        return { kind: "rejected", editIndex: editIndexOfRejection({ rejection, commands: expansion.commands, commandEditIndexes: expansion.commandEditIndexes }), reason: describeRejection(rejection) };
      }
      case "notPermitted":
        return { kind: "notPermitted", message: notPermittedMessage({ deck, permission: "editDocument" }) };
      case "tooLarge":
        return { kind: "tooLarge", message: `tooLarge: ${applied.message}` };
      default:
        return assertNever(applied);
    }
  }
}

/** Only a deck that changed between reading and applying is worth a second expansion. Total over reasons. */
const WORTH_RETRYING: Readonly<Record<CommandRejection["reason"], boolean>> = {
  staleText: true,
  slideMissing: false,
  elementMissing: false,
  layoutMissing: false,
  transitionScriptMissing: false,
  assetMissing: false,
  tableLineMissing: false,
  duplicateId: false,
  invalidId: false,
  invalidValue: false,
  wrongKind: false,
  groupCycle: false,
  textOutOfRange: false,
  staleScript: false,
  staleApproval: false,
  approvalNeedsPerson: false,
};

type StoredImages =
  | Readonly<{ kind: "stored"; records: ReadonlyMap<number, AssetRecord> }>
  | Readonly<{ kind: "rejected"; editIndex: number; reason: string }>
  | Readonly<{ kind: "notPermitted" | "tooLarge"; message: string }>;

/**
 * Every `addImage` source fetched (https only, size and type checked, image-source.ts) and stored
 * with `putAsset` BEFORE the envelope is built, because the envelope must name the asset. Bytes of
 * an edit that is then rejected stay stored but unregistered, which is harmless: assets are
 * content-addressed and the server collects unreferenced ones.
 */
async function storeImages(options: Readonly<{ tools: Tools; deck: DeckHandle; edits: readonly AssistantEditRequest[] }>): Promise<StoredImages> {
  const records = new Map<number, AssetRecord>();
  for (const [editIndex, edit] of options.edits.entries()) {
    const source = imageSourceOf(edit);
    if (source === null) continue;
    const fetched = await fetchImageSource({ source, fetch: options.tools.fetch });
    switch (fetched.kind) {
      case "refused":
        return { kind: "rejected", editIndex, reason: `invalidValue: ${fetched.reason}` };
      case "fetched":
        break;
      default:
        return assertNever(fetched);
    }
    const stored = await options.deck.putAsset({ bytes: fetched.bytes, mediaType: fetched.mediaType });
    switch (stored.kind) {
      case "stored":
        records.set(editIndex, {
          id: stored.assetId,
          mediaType: fetched.mediaType,
          pixelWidth: fetched.pixelWidth,
          pixelHeight: fetched.pixelHeight,
          name: fetched.name,
          byteLength: stored.byteLength,
        });
        break;
      case "tooLarge":
        return { kind: "rejected", editIndex, reason: `tooLarge: ${stored.message}` };
      case "notPermitted":
        return { kind: "notPermitted", message: notPermittedMessage({ deck: options.deck, permission: "editDocument" }) };
      default:
        return assertNever(stored);
    }
  }
  return { kind: "stored", records };
}

function imageSourceOf(edit: AssistantEditRequest): string | null {
  switch (edit.kind) {
    case "addImage":
      return edit.source;
    case "addSlide":
    case "deleteSlides":
    case "moveSlides":
    case "setSlide":
    case "addShape":
    case "addLine":
    case "addTable":
    case "moveElements":
    case "restyleElements":
    case "setText":
    case "replaceText":
    case "styleText":
    case "deleteElements":
    case "reorderElements":
    case "groupElements":
    case "setTitle":
    case "raw":
      return null;
    default:
      return assertNever(edit);
  }
}

function editOutcomeResult(outcome: AssistantEditOutcome | Readonly<{ kind: "notPermitted" | "tooLarge"; message: string }>): CallToolResult {
  switch (outcome.kind) {
    case "applied":
      return structuredResult(outcome);
    case "rejected":
      return { ...structuredResult(outcome), isError: true };
    case "notPermitted":
    case "tooLarge":
      return refusalResult(outcome.message);
    default:
      return assertNever(outcome);
  }
}

/** One envelope, authored by this session's agent: one undo step, revertible by agent session. */
function agentEnvelope(options: Readonly<{ resolution: ResolvedCaller; commands: readonly DocumentCommand[]; seed: IdSeed }>): CommandEnvelope {
  const author: CommandAuthor = { kind: "agent", name: options.resolution.caller.agent.displayName, agentSessionId: options.resolution.agentSessionId };
  return {
    commandId: mintId({ seed: options.seed, kind: "command" }).id,
    author,
    commands: options.commands,
    selectionBefore: { kind: "none" },
    selectionAfter: { kind: "none" },
    mergeWithPrevious: false,
  };
}

/**
 * A fresh id seed per call: the 8-character session prefix makes ids of different calls (and of
 * the editors' own sessions) distinct, the counter makes ids within the call distinct (ids.ts).
 */
function freshSeed(): IdSeed {
  return { sessionPrefix: newSessionPrefix(() => randomInt(0, 2 ** 32) / 2 ** 32), counter: 0 };
}

function mintOne<TKind extends ObjectIdKind>(kind: TKind): MintedIdByKind[TKind] {
  return mintId({ seed: freshSeed(), kind }).id;
}

// --- deck_write_transition --------------------------------------------------------------------------

async function writeTransition(options: Readonly<{ tools: Tools; deck: DeckHandle; resolution: ResolvedCaller; request: AssistantTransitionScript }>): Promise<CallToolResult> {
  const { deck, resolution, request } = options;
  const expansion = expandTransitionScript({ snapshot: deck.snapshot(), request, seed: freshSeed() });
  switch (expansion.kind) {
    case "rejected":
      return refusalResult(expansion.reason);
    case "expanded":
      break;
    default:
      return assertNever(expansion);
  }
  const envelope = agentEnvelope({ resolution, commands: expansion.commands, seed: expansion.seed });
  const assigned = request.assignTo.length === 0 ? "" : ` for ${String(request.assignTo.length)} slide${request.assignTo.length === 1 ? "" : "s"}`;
  const applied = await deck.apply({ envelope, summaryForCollaborators: `wrote the transition "${request.name}"${assigned}; it runs once someone reviews and approves it` });
  switch (applied.kind) {
    case "applied":
      return structuredResult({
        scriptId: expansion.scriptId,
        approved: false,
        reviewAddress: `${deckAddress({ publicUrl: options.tools.publicUrl, deckId: deck.deckId })}?${TRANSITION_REVIEW_QUERY}=${encodeURIComponent(expansion.scriptId)}`,
        assignedSlideIds: request.assignTo.map((assignment) => assignment.slideId),
        agentSessionId: resolution.agentSessionId,
        note: "Saved unapproved: it runs only after a person approves it in the editor. Give the user the reviewAddress.",
      });
    case "rejected":
      return refusalResult(describeRejection(applied.outcome.rejection));
    case "notPermitted":
      return refusalResult(notPermittedMessage({ deck, permission: "editDocument" }));
    case "tooLarge":
      return refusalResult(`tooLarge: ${applied.message}`);
    default:
      return assertNever(applied);
  }
}

// --- comments -------------------------------------------------------------------------------------

async function submitAsAgent(options: Readonly<{ deck: DeckHandle; command: DiscussionCommand }>): Promise<DiscussionOutcome> {
  return options.deck.submitDiscussion({ as: "agent", request: { requestId: mintOne("discussionRequest"), command: options.command } });
}

function discussionResult(options: Readonly<{ deck: DeckHandle; outcome: DiscussionOutcome }>): CallToolResult {
  const { outcome } = options;
  switch (outcome.kind) {
    case "applied":
      return structuredResult(outcome);
    case "rejected":
      switch (outcome.reason) {
        case "notPermitted":
          return refusalResult(notPermittedMessage({ deck: options.deck, permission: "comment" }));
        case "threadMissing":
        case "messageMissing":
        case "notAuthor":
        case "duplicateId":
        case "invalidValue":
        case "limitReached":
        // An agent submits through the room directly, never over a rate-limited socket; kept total.
        case "rateLimited":
          return refusalResult(`${outcome.reason}: ${outcome.message}`);
        default:
          return assertNever(outcome.reason);
      }
    default:
      return assertNever(outcome);
  }
}

const REMEMBERED_DISCUSSIONS = 64;

function remember(options: Readonly<{ tools: Tools; deckId: DeckId; discussion: DiscussionSnapshot }>): void {
  const memory = options.tools.discussionMemory;
  memory.set(memoryKey({ deckId: options.deckId, sequence: options.discussion.sequence }), options.discussion);
  while (memory.size > REMEMBERED_DISCUSSIONS) {
    const oldest = memory.keys().next();
    if (oldest.done === true) break;
    memory.delete(oldest.value);
  }
}

function memoryKey(options: Readonly<{ deckId: DeckId; sequence: number }>): string {
  return `${options.deckId}#${String(options.sequence)}`;
}

/** How often a waiting call tells the client it is alive: well inside the measured 60 s client timeout. */
const PROGRESS_INTERVAL_MILLISECONDS = 15_000;

type AwaitedComments = Readonly<{
  sequence: number;
  timedOut: boolean;
  /** True when `afterSequence` was not one this connector answered, so every thread with others' messages is listed. */
  sinceUnknown: boolean;
  changes: readonly DiscussionChange[];
}>;

/**
 * Long-polls the room's discussion (`waitForDiscussion`) until something someone ELSE did arrives
 * or the time is up, sending a progress notification at the start and every interval: without
 * them the client gives up after its own timeout (long-poll-progress.ts).
 */
async function awaitComments(
  options: Readonly<{ tools: Tools; deck: DeckHandle; caller: DeckCaller; afterSequence: number; timeoutMilliseconds: number; extra: RequestExtra }>,
): Promise<AwaitedComments> {
  const { tools, deck, afterSequence, timeoutMilliseconds } = options;
  const startedAt = tools.now();
  const deadline = startedAt + timeoutMilliseconds;
  const report = pollProgressReporter({
    extra: options.extra,
    timeoutMs: timeoutMilliseconds,
    describe: (progress) => `waiting for comments on ${deck.deckId} (${String(Math.round(progress.elapsedMs / 1000))} s)`,
    warn: (message) => {
      process.stderr.write(`[deck-tools] ${message}\n`);
    },
  });
  let polls = 0;
  const tick = (): void => {
    polls += 1;
    report({ polls, elapsedMs: tools.now() - startedAt });
  };
  tick();
  using _ticker = repeating({ every: Math.max(50, Math.min(PROGRESS_INTERVAL_MILLISECONDS, timeoutMilliseconds / 4)), run: tick });
  const ignoreAuthorId = options.caller.agent.id;
  const start = deck.discussion();
  let before: DiscussionSnapshot | null = start.sequence <= afterSequence ? start : (tools.discussionMemory.get(memoryKey({ deckId: deck.deckId, sequence: afterSequence })) ?? null);
  const answer = (outcome: Omit<AwaitedComments, "sinceUnknown"> & Readonly<{ sinceUnknown?: boolean; discussion: DiscussionSnapshot }>): AwaitedComments => {
    remember({ tools, deckId: deck.deckId, discussion: outcome.discussion });
    return { sequence: outcome.sequence, timedOut: outcome.timedOut, sinceUnknown: outcome.sinceUnknown ?? false, changes: outcome.changes };
  };
  if (start.sequence > afterSequence) {
    const changes = discussionChanges({ before, after: start, snapshot: deck.snapshot(), ignoreAuthorId });
    if (changes.length > 0) return answer({ sequence: start.sequence, timedOut: false, sinceUnknown: before === null, changes, discussion: start });
  }
  before = start;
  let current = start;
  for (;;) {
    const remaining = deadline - tools.now();
    if (remaining <= 0 || options.extra.signal.aborted) break;
    const next = await deck.waitForDiscussion({ afterSequence: current.sequence, timeoutMilliseconds: remaining, signal: options.extra.signal });
    if (next.sequence <= current.sequence) break;
    // Removed from the deck while waiting (a wait lasts up to 50 minutes): what arrived after that
    // is no longer theirs to read.
    if (deck.role() === null) break;
    current = next;
    const changes = discussionChanges({ before, after: current, snapshot: deck.snapshot(), ignoreAuthorId });
    if (changes.length > 0) return answer({ sequence: current.sequence, timedOut: false, changes, discussion: current });
  }
  return answer({ sequence: current.sequence, timedOut: true, changes: [], discussion: current });
}

/** A repeating timer bound to a scope (`using`), so it stops on every exit path. */
function repeating(options: Readonly<{ every: number; run: () => void }>): Disposable {
  const timer = setInterval(options.run, options.every);
  return {
    [Symbol.dispose]: () => {
      clearInterval(timer);
    },
  };
}

// --- results ------------------------------------------------------------------------------------

function structuredResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function refusalResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
