#!/usr/bin/env node
/**
 * The "sasha-slides" MCP server: stages candidate slide HTML in Drive, waits for the user's
 * pick in Google Slides, and reports it back.
 *
 *   npx tsx mcp/sasha-slides/server.ts --http --public-url https://slides.example.com
 *   npx tsx mcp/sasha-slides/server.ts --stdio      # dev only: one developer's token
 *
 * **The mode is explicit, never inferred.** `--http` is the real deployment: a remote
 * Streamable HTTP server that brokers each connecting user through Google and acts as
 * *that* user (see `http/authorization-server.ts`). `--stdio` is the local dev mode, and
 * the only thing left in the process that reads `.auth/tokens.json` — the MCP
 * authorization spec is explicit that stdio servers "SHOULD NOT follow this specification,
 * and instead retrieve credentials from the environment", so per-user OAuth and stdio are
 * mutually exclusive by design rather than by omission.
 *
 * Composition root. Everything effectful — the Drive channel, the clock, the randomness, the
 * filesystem probe, the warning sink — is constructed here and injected into `proposal.ts`,
 * which is why the unit tests can run the entire protocol with no credentials. Tool payloads are shaped by the exported pure `*Payload` functions below, so
 * the wire contract is testable without a transport.
 *
 * The only difference between the two modes below `createSashaSlidesServer` is *which*
 * `ProposalEnvironment` a tool call resolves: `proposal.ts`, `drive-channel.ts` and the
 * whole Drive protocol are untouched by the HTTP/OAuth work.
 *
 * stdout belongs to the stdio MCP transport: diagnostics go to stderr, always.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingHttpHeaders, Server as ListeningServer } from "node:http";
import { z } from "zod";
import { formatFrameLine, RecordingTransport } from "./jsonrpc-recording-transport.ts";
import { googleDriveChannel, type DriveChannel } from "./drive-channel";
import {
  DEFAULT_RESOLVE_NOTE,
  slidePlacement,
  type FeedbackCursor,
  type FeedbackEnvironment,
  type FeedbackPost,
  type FeedbackThread,
  type ReadFeedbackOutcome,
  type SlideNumbering,
  type UnresolvedSlideCount,
} from "./feedback/feedback";
import {
  awaitCandidateFeedback,
  describeCandidateAddressFailure,
  readCandidateFeedback,
  replyToCandidateComment,
  resolveCandidateComment,
  type AwaitCandidateFeedbackOutcome,
  type CandidateFeedbackEnvironment,
  type CandidateReplyOutcome,
  type DeliveryReceipt,
  type ReadCandidateFeedbackOutcome,
} from "./feedback/candidate-feedback";
import { googleFeedbackChannel, type FeedbackChannel } from "./feedback/feedback-channel";
import { FEEDBACK_DELIVERY_THRESHOLD_MS } from "./feedback-delivery";
import { pollProgressReporter } from "./long-poll-progress.ts";
import { describeCommentAnchor } from "./feedback/comment-anchor";
import { CLIENT_PATH, assertNever, describeAuthFailure, loadClientCredentials, loadOAuthClient } from "./google-auth";
import { googleSubjectOf } from "./http/authorization-server";
import { loadBrokeredStack, type BrokeredStack } from "./http/brokered-stack";
import { createSashaSlidesHttpServer } from "./http/http-server";
import type { CommentBot } from "./comment-bot/comment-bot";
import { loadCommentBot } from "./comment-bot/comment-bot-stack";
import { openCommentTasks, registerCommentTools, type CommentTaskPayload } from "./comment-bot/comment-tools";
import { loadAccountPortal } from "./http/account-portal-stack";
import { parseSessionSecret } from "./http/account-portal";
import { withDeckErasure } from "./http/account-eraser";
import { storeAccountDirectory } from "./http/account-directory";
import { randomAccountId } from "./http/accounts";
import { randomUrlSafeToken } from "./http/authorization-server";
import type { DeckCallerResolution, DeckService } from "./deck-contracts/deck-service-contract";
import { registerDeckTools } from "./deck-tools/deck-tools";
import { createGoogleSlidesInterchange } from "./google-slides/google-slides-interchange";
import { cryptoRandom } from "./decks/deck-identity";
import { REAL_TIMERS } from "./decks/deck-registry";
import { createDeckServer, type DeckServer } from "./decks/deck-stack";
import { memoryDeckStorage, openFileDeckStorage, type DeckStorage } from "./decks/deck-storage";
import type { Endpoints } from "./http/oauth-metadata";
import type { UserDriveFactory } from "./http/user-drive";
import {
  CLAUDE_CODE_INSTRUCTIONS_BUDGET,
  SKILL_RELATIVE_PATH,
  workflowInstructionsFromDisk,
  type WorkflowInstructions,
  type WorkflowInstructionsSource,
} from "./workflow-instructions.ts";
import { registerWorkflowPrompts } from "./workflow-prompts.ts";
import {
  awaitPick,
  clearSlides,
  createProposal,
  downloadSlideImages,
  readProposalLog,
  readProposalState,
  reviseSlide,
  type ClearSlidesOutcome,
  type CreateProposalOutcome,
  type ManifestSlide,
  type PickAnomaly,
  type PickOutcome,
  type ProposalEnvironment,
  type ProposalLogOutcome,
  type ProposalMerge,
  type ProposalState,
  type ReviseSlideOutcome,
  type ReviseStage,
  type SlideImagesOutcome,
  type SlideSource,
  listOpenWork,
  type ListOpenWorkOutcome,
  type OpenWorkItem,
} from "./proposal";
import { slideStructureOf, type SlideStructure } from "./slide-structure";
import type { SlideRead, SlideSelector } from "./feedback/feedback-channel";
import {
  describeSessionEvent,
  sessionEventBody,
  type ReadSessionEventsOutcome,
  type SessionEventRecord,
} from "./session-log";

export const SERVER_NAME = "sasha-slides";
export const SERVER_VERSION = "0.1.0";

/**
 * stderr, never stdout: on `--stdio` stdout IS the JSON-RPC channel, so a stray line there
 * corrupts the framing rather than logging anything.
 */
function serverWarn(message: string): void {
  void process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

/** Resolved lazily so a missing credential file is a tool error, not a dead server. */
export type EnvironmentLoad =
  | Readonly<{ kind: "ok"; env: ProposalEnvironment }>
  | Readonly<{ kind: "auth-failed"; message: string }>;

/**
 * Resolved **per tool call**, from the caller's own credentials. In HTTP mode `authInfo`
 * is the `AuthInfo` our authorization server minted for one Google identity, so two
 * concurrent callers resolve two different Drives; in stdio mode it is absent and the
 * single developer token is used.
 */
export type ResolveEnvironment = (
  options: Readonly<{ authInfo: AuthInfo | undefined }>,
) => Promise<EnvironmentLoad>;

/** The same lazy, per-call resolution for the comment feedback channel. */
export type FeedbackEnvironmentLoad =
  | Readonly<{ kind: "ok"; env: FeedbackEnvironment }>
  | Readonly<{ kind: "auth-failed"; message: string }>;

export type ResolveFeedbackEnvironment = (
  options: Readonly<{ authInfo: AuthInfo | undefined }>,
) => Promise<FeedbackEnvironmentLoad>;

export type ToolOutcome<TPayload> =
  | Readonly<{ kind: "payload"; payload: TPayload }>
  | Readonly<{ kind: "error"; message: string }>;

type SlideArgument = Readonly<{
  path?: string | undefined;
  html?: string | undefined;
  label?: string | undefined;
  remove?: readonly string[] | undefined;
}>;

type MergeArgument = Readonly<{ presentationId: string; slideObjectId: string }>;

/**
 * The propose_slides MERGE boundary (PROTOCOL.md "Merge proposals"): the optional target and each
 * slide's optional `remove` list, checked together. `null` is an ordinary proposal. Whether the ids
 * are really on the slide is NOT checked here -- the deck can change before the user picks, so the
 * add-on checks them against the slide as it is when the pick is applied, and refuses stale ones.
 */
export function mergeRequestFrom(
  options: Readonly<{
    slides: readonly SlideArgument[];
    merge: MergeArgument | undefined;
    presentationId: string | undefined;
  }>,
): Readonly<{ kind: "ok"; merge: ProposalMerge | null }> | Readonly<{ kind: "error"; message: string }> {
  const { slides, merge, presentationId } = options;
  if (merge === undefined) {
    const stray = slides.findIndex((slide) => slide.remove !== undefined);
    return stray === -1
      ? { kind: "ok", merge: null }
      : {
          kind: "error",
          message:
            `slide ${String(stray + 1)}: \`remove\` deletes elements of an existing slide, so it needs ` +
            "`merge: { presentationId, slideObjectId }` naming that slide",
        };
  }
  if (presentationId !== undefined && presentationId !== merge.presentationId) {
    return { kind: "error", message: "merge.presentationId names a different deck than presentationId" };
  }
  const removePerSlide: (readonly string[])[] = [];
  for (const [position, slide] of slides.entries()) {
    const remove = slide.remove ?? [];
    const repeated = remove.find((objectId, at) => remove.indexOf(objectId) !== at);
    if (repeated !== undefined) {
      return { kind: "error", message: `slide ${String(position + 1)}: \`remove\` names ${repeated} twice` };
    }
    removePerSlide.push(remove);
  }
  return { kind: "ok", merge: { target: { presentationId: merge.presentationId, slideObjectId: merge.slideObjectId }, removePerSlide } };
}

/**
 * The propose_slides / revise_slide argument boundary: each slide carries exactly one of `path`
 * or `html`, and a remote connector refuses `path` without echoing it back.
 */
export function slideSourcesFrom(
  options: Readonly<{ slides: readonly SlideArgument[]; remote: boolean }>,
): Readonly<{ kind: "ok"; sources: readonly SlideSource[] }> | Readonly<{ kind: "error"; message: string }> {
  const sources: SlideSource[] = [];
  for (const [position, slide] of options.slides.entries()) {
    const which = `slide ${String(position + 1)}`;
    const label = slide.label ?? null;
    if (slide.path !== undefined && slide.html !== undefined) {
      return { kind: "error", message: `${which}: give path or html, not both` };
    }
    if (slide.html !== undefined) {
      sources.push({ html: slide.html, label });
    } else if (slide.path !== undefined) {
      if (options.remote) {
        return {
          kind: "error",
          message:
            `${which}: this connector runs remotely and cannot read files from your machine. ` +
            "Send each slide's complete HTML document in `html` instead of `path`.",
        };
      }
      sources.push({ path: slide.path, label });
    } else {
      return { kind: "error", message: `${which}: give the slide as path or html` };
    }
  }
  return { kind: "ok", sources };
}

/** What Claude's deck tools need from the deck server (SPEC.md 21.14). */
export type DeckToolWiring = Readonly<{
  deckService: DeckService;
  callerFor: DeckServer["callerFor"];
  publicUrl: string;
}>;

/** Where deck addresses point when no deck server runs here (the tools then explain why they cannot work). */
const DEFAULT_DECK_ORIGIN = "https://sashaslides.com";

function decksUnavailable(): Promise<DeckCallerResolution> {
  return Promise.resolve({ kind: "unavailable", message: "Sasha decks need the remote connector with its account portal (SASHA_SESSION_SECRET)." });
}

export function createSashaSlidesServer(
  options: Readonly<{
    resolveEnvironment: ResolveEnvironment;
    resolveFeedbackEnvironment: ResolveFeedbackEnvironment;
    /**
     * What the client is handed in the `initialize` result: the workflow guide from
     * `.claude/skills/sasha-slides/SKILL.md`, resolved by the composition root through
     * `workflowInstructionsFromDisk` so this function stays free of the filesystem.
     */
     instructions: string;
    /**
     * True for the public HTTPS connector. A remote caller has no files on this machine, so slides
     * must arrive as `html`, and `path` is refused: on a shared server it would let any signed-in
     * caller upload any file here (the OAuth store, the key store) into their own Drive.
     */
    remote: boolean;
    /** Absent (stdio): the comment tools answer that they need the remote connector. */
    commentBot?: CommentBot;
    /** Absent (stdio, or no account portal): the deck tools are listed and answer why they cannot work. */
    decks?: DeckToolWiring;
  }>,
): McpServer {
  // The connector's own onboarding: the spec lets a server describe how it is meant to be
  // used and real Claude Code 2.1.285 puts that string in the system prompt, so the workflow
  // rules travel with the connector instead of with a separately installed skill.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: options.instructions },
  );
  const { resolveEnvironment, resolveFeedbackEnvironment, remote } = options;
  const commentBot = options.commentBot ?? null;

  // Declares the `prompts` capability and so makes `/mcp__sasha-slides__<name>` appear in the
  // user's slash-command list. Registered first because it is what the user reaches for before
  // any tool.
  registerWorkflowPrompts({ server });

  server.registerTool(
    "propose_slides",
    {
      title: "Propose candidate slides",
      description:
        "Stage N candidate slides in a new Drive proposal folder for the user to pick from " +
        "inside Google Slides. Give each slide as `path` (a self-contained 1280x720 HTML file " +
        "on the machine running this connector; streamed to Drive, never read into the " +
        "conversation) or, when the connector is remote (claude.ai, ChatGPT, any https URL), as " +
        "`html`, the complete document itself. Writes the READY marker last, so the picker only " +
        "ever sees a complete proposal. Follow with await_pick. To REDESIGN PART OF AN EXISTING " +
        "SLIDE instead of adding a new one, pass `merge` (the slide; read it first with " +
        "slide_structure) and give each candidate only the NEW parts plus `remove`, the object ids " +
        "it replaces. Each new element's CSS z-index on its top-level box places it: negative goes " +
        "behind the slide's kept content (still in front of a full-page background), anything else in front.",
      inputSchema: {
        slides: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .optional()
                .describe("Local connector only: absolute path to a self-contained 1280x720 HTML slide."),
              html: z
                .string()
                .min(1)
                .optional()
                .describe("Remote connector: the complete self-contained 1280x720 HTML document. Give path or html, not both."),
              label: z
                .string()
                .optional()
                .describe("Short caption for the picker (e.g. 'Timeline, 3 phases'). Not a transcription."),
              remove: z
                .array(z.string().min(1))
                .optional()
                .describe(
                  "Merge only: object ids (from slide_structure) of the existing elements this candidate " +
                    "deletes. Omit or [] when it only adds.",
                ),
            }),
          )
          .min(1)
          .describe("Candidate slides, in the order the user should see them (1-based once staged)."),
        presentationId: z
          .string()
          .optional()
          .describe("Target deck id, when known, so the add-on can insert into it."),
        merge: z
          .object({
            presentationId: z.string().min(1).describe("The deck holding the slide."),
            slideObjectId: z.string().min(1).describe("The slide's page object id, as slide_structure reports it."),
          })
          .optional()
          .describe(
            "Redesign part of THIS existing slide instead of inserting a new one. The picked candidate's " +
              "new elements are added to it and its `remove` ids deleted, in one atomic update.",
          ),
      },
    },
    async ({ slides, presentationId, merge }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const parsed = slideSourcesFrom({ slides, remote });
      if (parsed.kind === "error") return errorResult(parsed.message);
      const merged = mergeRequestFrom({ slides, merge, presentationId });
      if (merged.kind === "error") return errorResult(`propose_slides: ${merged.message}`);
      const outcome = await createProposal({
        env: loaded.env,
        slides: parsed.sources,
        presentationId: presentationId ?? null,
        ...(merged.merge === null ? {} : { merge: merged.merge }),
      });
      return toCallToolResult(proposeSlidesPayload(outcome));
    },
  );

  server.registerTool(
    "await_pick",
    {
      title: "Wait for the user's pick",
      description:
        "Block until the user picks one of a proposal's slides in Google Slides (or dismisses " +
        "the picker), polling Drive with backoff. Returns the 1-based index, any conversion " +
        "anomalies the user filed, and the object ids the add-on inserted. A timeout is " +
        "returned as status 'timeout' with picked = null, never an exception.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .default(DEFAULT_PICK_TIMEOUT_SECONDS)
          .describe("How long to wait before giving up. Default 300."),
      },
    },
    async ({ proposalId, timeoutSeconds }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await awaitPick({
        env: loaded.env,
        proposalId,
        timeoutSeconds,
        // Without this the client's own request timeout (60 s measured) ends the wait long
        // before the user has picked anything.
        onPoll: pollProgressReporter({
          extra,
          timeoutMs: timeoutSeconds * 1000,
          describe: ({ polls, elapsedMs }) =>
            `waiting for a pick on ${proposalId}: ${String(polls)} polls, ` +
            `${String(Math.round(elapsedMs / 1000))}s elapsed`,
          warn: serverWarn,
        }),
      });
      return toCallToolResult(awaitPickPayload(outcome));
    },
  );

  server.registerTool(
    "slide_images",
    {
      title: "Fetch rendered slide previews",
      description:
        "Download any rendered previews the Google Slides add-on has published for a " +
        "proposal, and return local file PATHS - never image data - so nothing enters this " +
        "conversation unless you choose to read a path. Rendering is client-side in the " +
        "add-on; if it has published nothing, this reports status 'unavailable' rather " +
        "than inventing an image.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        indices: z
          .array(z.number().int().positive())
          .optional()
          .describe("1-based slide indices to fetch. Omit for all available."),
        outDir: z.string().min(1).describe("Directory to write the images into; created if missing."),
      },
    },
    async ({ proposalId, indices, outDir }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await downloadSlideImages({
        env: loaded.env,
        proposalId,
        indices: indices ?? null,
        outDir,
        remote,
      });
      return toCallToolResult(slideImagesPayload(outcome));
    },
  );

  server.registerTool(
    "proposal_state",
    {
      title: "Inspect a proposal",
      description:
        "Report whether a proposal's READY and PICK markers exist, how many slides it holds, " +
        "and a summary of its manifest (ids, names and labels only - no slide content). " +
        "Useful to check staging completed, or whether a pick has already been made.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
      },
    },
    async ({ proposalId }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const state = await readProposalState({ env: loaded.env, proposalId });
      return toCallToolResult(proposalStatePayload(state));
    },
  );

  server.registerTool(
    "open_work",
    {
      title: "What is waiting for me?",
      description:
        "START HERE when the user has not named a proposal. Takes NO arguments: it answers " +
        "from the Google account this connector is authenticated as, and returns every " +
        "proposal that account has staged - what needs answering FIRST, then the newest. Each " +
        "item carries the proposalId the other tools take, how many candidates it holds, and " +
        "how many comments are still unresolved. The user should never have to type a " +
        "proposalId: ask this instead. An empty list means nothing is staged, which is a real " +
        "answer - do not guess an id.",
      inputSchema: {},
    },
    async (_arguments, extra) => {
      const loaded = await resolveCandidateEnvironment({
        resolveEnvironment,
        resolveFeedbackEnvironment,
        authInfo: extra.authInfo,
      });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const work = await listOpenWork({ env: loaded.env.proposal, feedback: loaded.env.feedback });
      const commentTasks = await openCommentTasks({ commentBot, authInfo: extra.authInfo });
      return toCallToolResult(withCommentTasks({ outcome: openWorkPayload(work), commentTasks }));
    },
  );

  registerCommentTools({ server, commentBot });
  registerDeckTools({
    server,
    deckService: options.decks?.deckService ?? null,
    callerFor: options.decks?.callerFor ?? decksUnavailable,
    publicUrl: options.decks?.publicUrl ?? DEFAULT_DECK_ORIGIN,
    fetch,
    now: () => Date.now(),
  });

  server.registerTool(
    "read_feedback",
    {
      title: "Read the user's comments on the candidates",
      description:
        "Read the comment threads the user left on a proposal's CANDIDATES - the open ones " +
        "by default. A comment is art direction on a slide that has not been inserted yet, " +
        "so it is filed against (proposalId, slideIndex) and never against a deck page. " +
        "Returns each thread's comment id, author, text verbatim, created/modified time, " +
        "which candidate it is on, any region the user dragged, and every reply so far, plus " +
        "the unresolved count for EVERY candidate so you can see which slides still have " +
        "open art direction. Omit slideIndex to read the whole proposal. Reply with " +
        "reply_feedback, act with revise_slide, close with resolve_feedback, and wait for " +
        "more with await_feedback.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        slideIndex: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based candidate to read. Omit for every candidate in the proposal."),
        since: z
          .string()
          .optional()
          .describe(
            "RFC3339 timestamp. Only threads modified at or after this are returned. " +
              "Omit for every thread. Drive's filter is inclusive, so a thread exactly at " +
              "this instant is included.",
          ),
        includeResolved: z
          .boolean()
          .default(false)
          .describe("Include threads the user or the agent already resolved. Default false."),
      },
    },
    async ({ proposalId, slideIndex, since, includeResolved }, extra) => {
      const loaded = await resolveCandidateEnvironment({
        resolveEnvironment,
        resolveFeedbackEnvironment,
        authInfo: extra.authInfo,
      });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await readCandidateFeedback({
        env: loaded.env,
        proposalId,
        slideIndex: slideIndex ?? null,
        since: since ?? null,
        includeResolved,
      });
      return toCallToolResult(readFeedbackPayload(outcome));
    },
  );

  server.registerTool(
    "reply_feedback",
    {
      title: "Answer a comment on a candidate",
      description:
        "Post a reply into one of the user's own comment threads on a candidate, so the " +
        "answer appears exactly where the question was asked and the user is notified by " +
        "Google as usual. ANSWERING IS THE COMPLETION SIGNAL: an answered comment with a " +
        "revised slide beneath it is what 'done' looks like in the interface - there is no " +
        "spinner and no toast. The reply is tagged so later reads can tell the agent's posts " +
        "from the user's, and appends comment-answered to the session log. Use the " +
        "commentId and slideIndex from read_feedback or await_feedback.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        slideIndex: z
          .number()
          .int()
          .positive()
          .describe("1-based candidate the thread is on, as read_feedback reported it."),
        commentId: z.string().min(1).describe("The thread's comment id, from read_feedback."),
        text: z.string().min(1).describe("What to say back to the user, in plain text."),
      },
    },
    async ({ proposalId, slideIndex, commentId, text }, extra) => {
      const loaded = await resolveCandidateEnvironment({
        resolveEnvironment,
        resolveFeedbackEnvironment,
        authInfo: extra.authInfo,
      });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await replyToCandidateComment({
        env: loaded.env,
        proposalId,
        slideIndex,
        commentId,
        text,
      });
      return toCallToolResult(replyFeedbackPayload({ outcome, tool: "reply_feedback" }));
    },
  );

  server.registerTool(
    "resolve_feedback",
    {
      title: "Close a comment thread on a candidate",
      description:
        "Mark one of the user's comment threads on a candidate resolved, the same state the " +
        "Resolve button in Google's comment UI produces - which is also where the unresolved " +
        "count on that slide comes from. Google implements this as a reply carrying a resolve " +
        "action, so a short note is posted with it; pass `text` to choose that note. The " +
        "thread is read back afterwards, so the reported `resolved` is observed, not assumed, " +
        "and comment-resolved is appended to the session log.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        slideIndex: z
          .number()
          .int()
          .positive()
          .describe("1-based candidate the thread is on, as read_feedback reported it."),
        commentId: z.string().min(1).describe("The thread's comment id, from read_feedback."),
        text: z
          .string()
          .optional()
          .describe(`The note to close the thread with. Defaults to "${DEFAULT_RESOLVE_NOTE}".`),
      },
    },
    async ({ proposalId, slideIndex, commentId, text }, extra) => {
      const loaded = await resolveCandidateEnvironment({
        resolveEnvironment,
        resolveFeedbackEnvironment,
        authInfo: extra.authInfo,
      });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await resolveCandidateComment({
        env: loaded.env,
        proposalId,
        slideIndex,
        commentId,
        text: text ?? null,
      });
      return toCallToolResult(replyFeedbackPayload({ outcome, tool: "resolve_feedback" }));
    },
  );

  server.registerTool(
    "await_feedback",
    {
      title: "Wait for the user's next comment on a candidate",
      description:
        "Block until the user posts a NEW comment or reply on one candidate, polling Drive " +
        "with backoff - the same way await_pick blocks on a pick. Posts the agent itself " +
        "wrote never end the wait, so reply_feedback followed by await_feedback waits for the " +
        "user rather than returning the agent's own words. Pass the `cursor` from a previous " +
        "read_feedback or await_feedback as `since`; omit it to wait only for activity from " +
        "now on. A timeout is returned as status 'timeout' with no posts, never an exception.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        slideIndex: z
          .number()
          .int()
          .positive()
          .describe("1-based candidate to watch. A cursor is a position in ONE candidate's threads."),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(3_600_000)
          .default(DEFAULT_FEEDBACK_TIMEOUT_MS)
          .describe("How long to wait before giving up, in milliseconds. Default 300000 (5 min)."),
        since: z
          .object({
            modifiedTime: z.string().min(1).describe("The cursor's RFC3339 watermark."),
            seenPostIds: z
              .array(z.string())
              .describe("Post ids already seen at that watermark; required for exactly-once."),
          })
          .optional()
          .describe("The `cursor` from a previous read_feedback or await_feedback. Pass it back verbatim."),
      },
    },
    async ({ proposalId, slideIndex, timeoutMs, since }, extra) => {
      const loaded = await resolveCandidateEnvironment({
        resolveEnvironment,
        resolveFeedbackEnvironment,
        authInfo: extra.authInfo,
      });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await awaitCandidateFeedback({
        env: loaded.env,
        proposalId,
        slideIndex,
        since:
          since === undefined
            ? null
            : { modifiedTime: since.modifiedTime, seenPostIds: since.seenPostIds },
        timeoutMs,
        // This is what makes a multi-minute wait survive the client's own request timeout,
        // and it doubles as the honest "still watching" signal the user asked for.
        onPoll: pollProgressReporter({
          extra,
          timeoutMs,
          describe: ({ polls, elapsedMs }) =>
            `watching candidate ${String(slideIndex)} of ${proposalId} for comments: ` +
            `${String(polls)} polls, ${String(Math.round(elapsedMs / 1000))}s elapsed`,
          warn: serverWarn,
        }),
      });
      return toCallToolResult(awaitFeedbackPayload(outcome));
    },
  );

  server.registerTool(
    "revise_slide",
    {
      title: "Replace a candidate in place",
      description:
        "Overwrite one candidate's HTML with a new version, given as `path` or `html` exactly as " +
        "for propose_slides (`html` when the connector is remote). The Drive file " +
        "id does not change, so the user's comment threads stay attached to the slide they " +
        "are about; that is why this exists instead of staging a second proposal. Appends " +
        "slide-revised naming the comment ids it answers, then bumps manifest.revision last, " +
        "which is the signal the interface polls to re-read. Answer the comments with " +
        "reply_feedback and close them with resolve_feedback - an answered comment with a " +
        "revised slide beneath it is the completion signal.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        slideIndex: z.number().int().positive().describe("1-based candidate to replace."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Local connector only: absolute path to the new self-contained 1280x720 HTML slide."),
        html: z
          .string()
          .min(1)
          .optional()
          .describe("Remote connector: the complete new 1280x720 HTML document. Give path or html, not both."),
        label: z
          .string()
          .optional()
          .describe("New short caption for the picker. Omit to keep the existing one."),
        answeredCommentIds: z
          .array(z.string().min(1))
          .optional()
          .describe("The comment ids this revision answers, from read_feedback. Omit if it answers none."),
      },
    },
    async ({ proposalId, slideIndex, path, html, label, answeredCommentIds }, extra) => {
      const parsed = slideSourcesFrom({ slides: [{ path, html, label }], remote });
      if (parsed.kind === "error") return errorResult(parsed.message);
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const [source] = parsed.sources;
      if (source === undefined) return errorResult("give the slide as path or html");
      const outcome = await reviseSlide({
        env: loaded.env,
        proposalId,
        slideIndex,
        ...("path" in source ? { htmlPath: source.path } : { html: source.html }),
        label: label ?? null,
        answeredCommentIds: answeredCommentIds ?? [],
      });
      return toCallToolResult(reviseSlidePayload(outcome));
    },
  );

  server.registerTool(
    "clear_slides",
    {
      title: "Discard the uninserted candidates",
      description:
        "Delete the candidates of a proposal that have NOT been inserted into the deck, and " +
        "append slides-cleared to the session log. Never silent: an uninserted set that " +
        "vanishes without a line in the log is indistinguishable from a bug. Candidates the " +
        "log or PICK says are already in the user's deck are kept. The count is taken before " +
        "and re-listed after, and a mismatch is reported rather than ignored.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
        reason: z
          .string()
          .optional()
          .describe("One line the user will read in the conversation, e.g. 'starting over on the layout'."),
      },
    },
    async ({ proposalId, reason }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const outcome = await clearSlides({ env: loaded.env, proposalId, reason: reason ?? null });
      return toCallToolResult(clearSlidesPayload(outcome));
    },
  );

  server.registerTool(
    "session_events",
    {
      title: "Replay the session log",
      description:
        "Read a proposal's session log back in order: what was staged, what the user " +
        "commented on, what was answered, revised, resolved, cleared and inserted. The log " +
        "is append-only and one file per event, so this is the whole conversation and " +
        "replaying it reconstructs the session. An event written by a NEWER build is " +
        "reported as kind 'opaque' with what it said, never dropped - so a short history is " +
        "always a real history. Returns the manifest revision it was read at.",
      inputSchema: {
        proposalId: z.string().min(1).describe("The proposalId returned by propose_slides."),
      },
    },
    async ({ proposalId }, extra) => {
      const loaded = await resolveEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      return toCallToolResult(sessionEventsPayload(await readProposalLog({ env: loaded.env, proposalId })));
    },
  );

  server.registerTool(
    "slide_structure",
    {
      title: "Read an existing slide's elements",
      description:
        "List every element on ONE existing slide -- object id, kind, a text excerpt, its box in px " +
        "on the 1280x720 frame candidate HTML is drawn on, and its z-order (0 is rearmost). Read this " +
        "before a merge proposal (propose_slides with `merge`): the ids are what `remove` names, and " +
        "the boxes are where the kept content sits. Give the slide as slideObjectId or slideNumber.",
      inputSchema: {
        presentationId: z.string().min(1).describe("The deck id (from its URL)."),
        slideObjectId: z.string().min(1).optional().describe("The slide's page object id."),
        slideNumber: z.number().int().min(1).optional().describe("Or its 1-based position in the filmstrip."),
      },
    },
    async ({ presentationId, slideObjectId, slideNumber }, extra) => {
      const slide = slideSelectorFrom({ slideObjectId, slideNumber });
      if (slide.kind === "error") return errorResult(slide.message);
      const loaded = await resolveFeedbackEnvironment({ authInfo: extra.authInfo });
      if (loaded.kind === "auth-failed") return errorResult(loaded.message);
      const read = await loaded.env.channel.readSlide({ presentationId, slide: slide.selector });
      return toCallToolResult(slideStructurePayload({ presentationId, read }));
    },
  );

  return server;
}

/** Exactly one of the two ways to name a slide. */
export function slideSelectorFrom(
  options: Readonly<{ slideObjectId: string | undefined; slideNumber: number | undefined }>,
): Readonly<{ kind: "ok"; selector: SlideSelector }> | Readonly<{ kind: "error"; message: string }> {
  const { slideObjectId, slideNumber } = options;
  if (slideObjectId !== undefined && slideNumber !== undefined) {
    return { kind: "error", message: "slide_structure: give slideObjectId or slideNumber, not both" };
  }
  if (slideObjectId !== undefined) return { kind: "ok", selector: { kind: "object-id", objectId: slideObjectId } };
  if (slideNumber !== undefined) return { kind: "ok", selector: { kind: "number", number: slideNumber } };
  return { kind: "error", message: "slide_structure: give the slide as slideObjectId or slideNumber" };
}

export function slideStructurePayload(
  options: Readonly<{ presentationId: string; read: SlideRead }>,
): ToolOutcome<SlideStructure> {
  const { presentationId, read } = options;
  switch (read.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: slideStructureOf({
          presentationId,
          slideObjectId: read.slideObjectId,
          slideNumber: read.slideNumber,
          pageSize: read.pageSize,
          page: read.page,
        }),
      };
    case "not-found":
      return { kind: "error", message: `slide_structure: ${read.reason}` };
    case "unavailable":
      return {
        kind: "error",
        message:
          `slide_structure: Google Slides would not return that slide: ${read.reason}. The connector ` +
          "reads decks with your own grant, so check the deck id and that your account can open it.",
      };
    default:
      return assertNever(read);
  }
}

export const DEFAULT_PICK_TIMEOUT_SECONDS = 300;
/**
 * ONE CONSTANT, READ BY BOTH SURFACES. This poll length and the add-on's "nobody is listening"
 * threshold are the same fact -- a connected client reads a comment well inside one poll -- so the
 * add-on imports `feedback-delivery.ts` rather than carrying a second five that can drift.
 */
export const DEFAULT_FEEDBACK_TIMEOUT_MS = FEEDBACK_DELIVERY_THRESHOLD_MS;

export type ProposeSlidesPayload = Readonly<{
  proposalId: string;
  count: number;
  /** The manifest revision this staging produced; `session_events` and the UI poll it. */
  revision: number;
  slides: readonly Readonly<{ index: number; fileId: string; name: string }>[];
}>;

export function proposeSlidesPayload(outcome: CreateProposalOutcome): ToolOutcome<ProposeSlidesPayload> {
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          proposalId: outcome.proposalId,
          count: outcome.count,
          revision: outcome.revision,
          slides: outcome.slides.map((slide) => ({
            index: slide.index,
            fileId: slide.fileId,
            name: slide.name,
          })),
        },
      };
    case "invalid-input":
      return { kind: "error", message: `propose_slides: ${outcome.reason}` };
    case "drive-failed":
      return {
        kind: "error",
        message:
          `propose_slides: Drive could not be reached: ${outcome.reason}. No READY was written, ` +
          "so nothing can pick this folder; staging again is safe.",
      };
    default:
      return assertNever(outcome);
  }
}

export type AwaitPickPayload = Readonly<{
  status: "picked" | "dismissed" | "timeout" | "unsupported-protocol-version";
  picked: number | null;
  anomalies: readonly PickAnomaly[];
  insertedObjectIds: readonly string[];
  decidedAt: string | null;
  note: string | null;
}>;

export function awaitPickPayload(outcome: PickOutcome): ToolOutcome<AwaitPickPayload> {
  switch (outcome.kind) {
    case "decided":
      return {
        kind: "payload",
        payload: {
          status: outcome.pick.picked === null ? "dismissed" : "picked",
          picked: outcome.pick.picked,
          anomalies: outcome.pick.anomalies,
          insertedObjectIds: outcome.pick.insertedObjectIds,
          decidedAt: outcome.pick.decidedAt,
          note: outcome.pick.picked === null ? "the user dismissed the picker without choosing" : null,
        },
      };
    case "timeout":
      return {
        kind: "payload",
        payload: {
          status: "timeout",
          picked: null,
          anomalies: [],
          insertedObjectIds: [],
          decidedAt: null,
          note: `no PICK after ${String(outcome.waitedSeconds)}s (${String(outcome.polls)} polls); the proposal is still staged, so await_pick can be called again`,
        },
      };
    case "unsupported-version":
      return {
        kind: "payload",
        payload: {
          status: "unsupported-protocol-version",
          picked: null,
          anomalies: [],
          insertedObjectIds: [],
          decidedAt: null,
          note: `the add-on wrote a PICK with protocolVersion ${String(outcome.version)}; this server only reads version 1 and will not guess at it`,
        },
      };
    case "unknown-proposal":
      return { kind: "error", message: "await_pick: no such proposal (it may have been cleaned up)" };
    case "unreadable":
      return { kind: "error", message: `await_pick: PICK could not be parsed: ${outcome.reason}` };
    default:
      return assertNever(outcome);
  }
}

export type SlideImagesPayload = Readonly<{
  status: "ok" | "unavailable";
  files: readonly Readonly<{ index: number; path: string }>[];
  note: string | null;
}>;

export function slideImagesPayload(outcome: SlideImagesOutcome): ToolOutcome<SlideImagesPayload> {
  switch (outcome.kind) {
    case "ok":
      return { kind: "payload", payload: { status: "ok", files: outcome.files, note: null } };
    case "unavailable":
      return { kind: "payload", payload: { status: "unavailable", files: [], note: outcome.reason } };
    case "unknown-proposal":
      return { kind: "error", message: "slide_images: no such proposal (it may have been cleaned up)" };
    default:
      return assertNever(outcome);
  }
}

export type ProposalStatePayload = Readonly<{
  proposalId: string;
  exists: boolean;
  ready: boolean;
  pick: boolean;
  count: number | null;
  slideFileCount: number;
  manifestStatus: "ok" | "absent" | "unreadable" | "unsupported-protocol-version";
  manifest: ManifestSummary | null;
  note: string | null;
}>;

export type ManifestSummary = Readonly<{
  protocolVersion: number;
  createdAt: string;
  presentationId: string | null;
  count: number;
  /** Moves on every change to the candidate set. Re-read the proposal when it does. */
  revision: number;
  slides: readonly ManifestSlide[];
}>;

/**
 * WHAT IS WAITING, in the words a model acts on.
 *
 * `note` is the only prose: it names what to do next, because the whole point of this tool is
 * that nobody typed an id and the session has to decide where to go. An EMPTY list is a real
 * answer and says so -- a session told nothing is staged must stop, not invent an id.
 */
export function openWorkPayload(work: ListOpenWorkOutcome): ToolOutcome<OpenWorkPayload> {
  switch (work.kind) {
    case "drive-failed":
      return { kind: "error", message: `open_work: Drive would not answer: ${work.reason}` };
    case "ok": {
      const waiting = work.items.filter((item) => item.unresolved > 0);
      const first = work.items[0];
      return {
        kind: "payload",
        payload: {
          status: work.items.length === 0 ? "nothing-staged" : "ok",
          count: work.items.length,
          items: work.items,
          note:
            first === undefined
              ? "nothing is staged for this account; propose_slides stages a proposal"
              : waiting.length === 0
                ? `nothing is unanswered; the newest proposal is ${first.proposalId}`
                : `answer ${first.proposalId} first: ${String(first.unresolved)} unresolved comment(s). ` +
                  "Use read_feedback on it, then reply_feedback and revise_slide.",
        },
      };
    }
    default:
      return assertNever(work);
  }
}

export type OpenWorkPayload = Readonly<{
  status: "ok" | "nothing-staged";
  count: number;
  items: readonly OpenWorkItem[];
  note: string;
  /** Comments on the decks this account watches (`watch_comments`) that wait for an answer. */
  commentTasks?: readonly CommentTaskPayload[];
}>;

/** open_work with the caller's comment tasks attached; unchanged when there are none. */
export function withCommentTasks(
  options: Readonly<{ outcome: ToolOutcome<OpenWorkPayload>; commentTasks: readonly CommentTaskPayload[] }>,
): ToolOutcome<OpenWorkPayload> {
  const { outcome, commentTasks } = options;
  if (outcome.kind === "error" || commentTasks.length === 0) return outcome;
  return {
    kind: "payload",
    payload: {
      ...outcome.payload,
      commentTasks,
      note: `${String(commentTasks.length)} comment task(s) wait on watched decks: answer them with reply_comment_task. ${outcome.payload.note}`,
    },
  };
}

export function proposalStatePayload(state: ProposalState): ToolOutcome<ProposalStatePayload> {
  const common = {
    proposalId: state.proposalId,
    exists: state.found,
    ready: state.ready,
    pick: state.picked,
    slideFileCount: state.slideFileCount,
  } as const;
  const manifest = state.manifest;
  switch (manifest.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          ...common,
          count: manifest.manifest.count,
          manifestStatus: "ok",
          manifest: {
            protocolVersion: manifest.manifest.protocolVersion,
            createdAt: manifest.manifest.createdAt,
            presentationId: manifest.manifest.presentationId,
            count: manifest.manifest.count,
            revision: manifest.manifest.revision,
            slides: manifest.manifest.slides,
          },
          note: state.ready ? null : "READY is absent: staging is incomplete, do not pick from this yet",
        },
      };
    case "absent":
      return {
        kind: "payload",
        payload: {
          ...common,
          count: null,
          manifestStatus: "absent",
          manifest: null,
          note: state.found
            ? "the proposal folder exists but holds no manifest yet"
            : "no files are tagged with this proposalId",
        },
      };
    case "unreadable":
      return {
        kind: "payload",
        payload: {
          ...common,
          count: null,
          manifestStatus: "unreadable",
          manifest: null,
          note: `manifest.json could not be parsed: ${manifest.reason}`,
        },
      };
    case "unsupported-version":
      return {
        kind: "payload",
        payload: {
          ...common,
          count: null,
          manifestStatus: "unsupported-protocol-version",
          manifest: null,
          note: `manifest.json declares protocolVersion ${String(manifest.version)}; this server only reads version 1`,
        },
      };
    default:
      return assertNever(manifest);
  }
}

/**
 * One thread, flattened for the wire. The raw anchor is reported *next to* its reading, so
 * the agent can see exactly what Google stored even when we decline to interpret it — the
 * anchor format is Google's, undocumented, and may change. A comment on a candidate has no
 * anchor at all (Drive-API comments never do), and does not need one: the file it is on names
 * the slide.
 */
export type FeedbackThreadPayload = Readonly<{
  commentId: string;
  author: string;
  text: string;
  createdTime: string;
  modifiedTime: string;
  resolved: boolean;
  slideNumber: number | null;
  pageObjectId: string | null;
  slide: string;
  elementObjectIds: readonly string[];
  anchorRaw: string | null;
  anchor: string;
  quotedText: string | null;
  /** The sidebar's dragged box, fractional (0-1), when the note came from the add-on. */
  region: Readonly<{ x: number; y: number; w: number; h: number }> | null;
  noteId: string | null;
  replies: readonly Readonly<{
    replyId: string;
    author: string;
    text: string;
    createdTime: string;
    action: string;
    authoredByAgent: boolean;
  }>[];
}>;

export type ReadFeedbackPayload = Readonly<{
  proposalId: string;
  /** Null when every candidate was read. */
  slideIndex: number | null;
  threadCount: number;
  threads: readonly FeedbackThreadPayload[];
  /**
   * Per candidate, the number of OPEN threads — the same number the grid puts on the cell.
   * `unresolved` is null, never 0, when it could not be read.
   */
  unresolved: readonly UnresolvedSlideCount[];
  /** Where to resume. Meaningful for a single candidate; see `unresolved[].cursor` otherwise. */
  cursor: FeedbackCursor;
  slideCount: number | null;
  note: string | null;
  /**
   * Whether the `feedback-delivered` receipt for this hand-over reached Drive. False means the user's
   * add-on cannot see that you read them, and will say nobody is listening while you are.
   */
  deliveryLogged: boolean;
}>;

export function readFeedbackPayload(
  outcome: ReadCandidateFeedbackOutcome,
): ToolOutcome<ReadFeedbackPayload> {
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          proposalId: outcome.proposalId,
          slideIndex: outcome.slideIndex,
          threadCount: outcome.outcome.threads.length,
          threads: outcome.outcome.threads.map(feedbackThreadPayload),
          unresolved: outcome.unresolved,
          cursor: outcome.outcome.cursor,
          slideCount: slideCountOf(outcome.outcome.slideNumbering),
          note: noteWithDelivery({ note: readFeedbackNote(outcome.outcome), delivery: outcome.delivery }),
          deliveryLogged: deliveryWasLogged(outcome.delivery),
        },
      };
    case "failed":
      return {
        kind: "error",
        message: `read_feedback: ${describeCandidateAddressFailure(outcome.failure)}`,
      };
    default:
      return assertNever(outcome);
  }
}

export type ReplyFeedbackPayload = Readonly<{
  status: "posted";
  slideIndex: number;
  replyId: string;
  createdTime: string;
  resolved: boolean;
  /** False when the reply posted but its session-log event did not. Never hidden. */
  logged: boolean;
  note: string | null;
}>;

export function replyFeedbackPayload(
  options: Readonly<{ outcome: CandidateReplyOutcome; tool: string }>,
): ToolOutcome<ReplyFeedbackPayload> {
  const { outcome, tool } = options;
  switch (outcome.kind) {
    case "failed":
      return { kind: "error", message: `${tool}: ${describeCandidateAddressFailure(outcome.failure)}` };
    case "ok":
      break;
    default:
      return assertNever(outcome);
  }
  const posted = outcome.outcome;
  switch (posted.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          status: "posted",
          slideIndex: outcome.slideIndex,
          replyId: posted.replyId,
          createdTime: posted.createdTime,
          resolved: posted.resolved,
          logged: outcome.logged,
          note:
            outcome.logged || outcome.logFailure === null
              ? null
              : `the reply posted, but the session log entry could not be written (${outcome.logFailure}), ` +
                "so the conversation will not show this answer until the log is readable again",
        },
      };
    case "unknown-comment":
      return {
        kind: "error",
        message: `${tool}: no open comment thread with that id on candidate ${String(outcome.slideIndex)} (it may have been deleted)`,
      };
    case "invalid-input":
      return { kind: "error", message: `${tool}: ${posted.reason}` };
    default:
      return assertNever(posted);
  }
}

export type AwaitFeedbackPayload = Readonly<{
  status: "arrived" | "timeout";
  /** The candidate that was watched. A cursor is a position in ONE candidate's threads. */
  slideIndex: number;
  posts: readonly FeedbackPostPayload[];
  cursor: FeedbackCursor;
  note: string | null;
  /** As on read_feedback: whether the delivery receipt reached Drive. */
  deliveryLogged: boolean;
}>;

export type FeedbackPostPayload = Readonly<{
  kind: "comment" | "reply";
  postId: string;
  commentId: string;
  author: string;
  text: string;
  postedAt: string;
  action: string;
  slideNumber: number | null;
  pageObjectId: string | null;
  slide: string;
}>;

export function awaitFeedbackPayload(
  outcome: AwaitCandidateFeedbackOutcome,
): ToolOutcome<AwaitFeedbackPayload> {
  switch (outcome.kind) {
    case "failed":
      return {
        kind: "error",
        message: `await_feedback: ${describeCandidateAddressFailure(outcome.failure)}`,
      };
    case "ok":
      break;
    default:
      return assertNever(outcome);
  }
  const waited = outcome.outcome;
  switch (waited.kind) {
    case "arrived":
      return {
        kind: "payload",
        payload: {
          status: "arrived",
          slideIndex: outcome.slideIndex,
          posts: waited.posts.map(feedbackPostPayload),
          cursor: waited.cursor,
          note: noteWithDelivery({
            note: `${String(waited.posts.length)} new post(s) after ${String(waited.polls)} poll(s); answer with reply_feedback and act with revise_slide`,
            delivery: outcome.delivery,
          }),
          deliveryLogged: deliveryWasLogged(outcome.delivery),
        },
      };
    case "timeout":
      return {
        kind: "payload",
        payload: {
          status: "timeout",
          slideIndex: outcome.slideIndex,
          posts: [],
          cursor: waited.cursor,
          note:
            `no new comment or reply from the user after ${String(Math.round(waited.waitedMs / 100) / 10)}s ` +
            `(${String(waited.polls)} polls); the cursor is unchanged, so await_feedback can be called again ` +
            "with it and nothing will be missed",
          deliveryLogged: deliveryWasLogged(outcome.delivery),
        },
      };
    default:
      return assertNever(waited);
  }
}

export type ReviseSlidePayload = Readonly<{
  status: "revised";
  slideIndex: number;
  /** Unchanged by the revision: the comment threads hang off this id. */
  fileId: string;
  name: string;
  revision: number;
  answeredCommentIds: readonly string[];
  note: string | null;
}>;

export function reviseSlidePayload(outcome: ReviseSlideOutcome): ToolOutcome<ReviseSlidePayload> {
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          status: "revised",
          slideIndex: outcome.slideIndex,
          fileId: outcome.fileId,
          name: outcome.name,
          revision: outcome.revision,
          answeredCommentIds: outcome.answeredCommentIds,
          note:
            outcome.answeredCommentIds.length === 0
              ? "nothing was named as answered; if this revision addresses a comment, answer it with reply_feedback so the user sees the round trip close"
              : null,
        },
      };
    case "invalid-input":
      return { kind: "error", message: `revise_slide: ${outcome.reason}` };
    case "unknown-proposal":
      return { kind: "error", message: "revise_slide: no such proposal (it may have been cleaned up)" };
    case "unknown-slide":
      return {
        kind: "error",
        message: `revise_slide: no candidate with that index; the proposal holds ${outcome.available.length === 0 ? "none" : outcome.available.join(", ")}`,
      };
    case "manifest-unusable":
      return {
        kind: "error",
        message:
          `revise_slide: the revision could not be recorded because ${outcome.reason}. ` +
          "manifest.revision is what the interface polls, so nothing was changed.",
      };
    case "drive-failed":
      return {
        kind: "error",
        message: `revise_slide: Drive could not be reached at the ${outcome.stage} step: ${outcome.reason}${driveStageHint(outcome.stage)}`,
      };
    default:
      return assertNever(outcome);
  }
}

export type ClearSlidesPayload = Readonly<{
  status: "cleared";
  cleared: readonly Readonly<{ index: number; fileId: string; name: string }>[];
  keptSlideIndices: readonly number[];
  countBefore: number;
  countAfter: number;
  revision: number;
  note: string | null;
}>;

export function clearSlidesPayload(outcome: ClearSlidesOutcome): ToolOutcome<ClearSlidesPayload> {
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          status: "cleared",
          cleared: outcome.cleared.map((candidate) => ({
            index: candidate.index,
            fileId: candidate.fileId,
            name: candidate.name,
          })),
          keptSlideIndices: outcome.kept.map((candidate) => candidate.index),
          countBefore: outcome.countBefore,
          countAfter: outcome.countAfter,
          revision: outcome.revision,
          note:
            outcome.cleared.length === 0
              ? "nothing was uninserted, so nothing was deleted; slides-cleared was still logged so the conversation says so"
              : `${String(outcome.cleared.length)} candidate(s) deleted, ${String(outcome.kept.length)} kept because they are already in the deck`,
        },
      };
    case "unknown-proposal":
      return { kind: "error", message: "clear_slides: no such proposal (it may have been cleaned up)" };
    case "manifest-unusable":
      return {
        kind: "error",
        message: `clear_slides: nothing was deleted because ${outcome.reason}`,
      };
    case "verification-failed":
      return {
        kind: "error",
        message:
          "clear_slides: the re-count after deleting did not match the plan - expected candidates " +
          `[${outcome.expected.join(", ")}] to remain but found [${outcome.found.join(", ")}]. ` +
          "Check the proposal folder before clearing again.",
      };
    case "drive-failed":
      return {
        kind: "error",
        message: `clear_slides: Drive could not be reached at the ${outcome.stage} step: ${outcome.reason}`,
      };
    default:
      return assertNever(outcome);
  }
}

export type SessionEventsPayload = Readonly<{
  status: "ok" | "no-log";
  /** Null when there is no usable manifest; never a made-up number. */
  revision: number | null;
  eventCount: number;
  events: readonly SessionEventPayload[];
  /** Entries in `events/` that are not readable events, named rather than hidden. */
  unreadable: readonly string[];
  note: string | null;
}>;

export type SessionEventPayload = Readonly<{
  /** `<epochMillis>-<suffix>-<kind>`, which is also the total order. */
  eventId: string;
  kind: string;
  at: string | null;
  /** One line a conversation can render, including for an event a newer build wrote. */
  summary: string;
  /** The event body as written, so a newer kind's fields are not lost in translation. */
  fields: Readonly<Record<string, unknown>>;
}>;

export function sessionEventsPayload(outcome: ProposalLogOutcome): ToolOutcome<SessionEventsPayload> {
  switch (outcome.kind) {
    case "unknown-proposal":
      return { kind: "error", message: "session_events: no such proposal (it may have been cleaned up)" };
    case "drive-failed":
      return { kind: "error", message: `session_events: Drive could not be reached: ${outcome.reason}` };
    case "ok":
      return sessionLogPayload({ revision: outcome.revision, log: outcome.log });
    default:
      return assertNever(outcome);
  }
}

export function toCallToolResult<TPayload>(outcome: ToolOutcome<TPayload>): CallToolResult {
  switch (outcome.kind) {
    case "payload":
      return { content: [{ type: "text", text: JSON.stringify(outcome.payload, null, 2) }] };
    case "error":
      return errorResult(outcome.message);
    default:
      return assertNever(outcome);
  }
}

/** The production environment: real Drive, real clock, real filesystem probe. */
export function liveEnvironment(options: Readonly<{ drive: ProposalEnvironment["drive"] }>): ProposalEnvironment {
  return {
    drive: options.drive,
    now: () => new Date(),
    randomSuffix,
    sleep: ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    statFile: (path) => {
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats !== undefined && stats.isFile() ? { bytes: stats.size } : null;
    },
    // stdout is the MCP transport; a warning written there would corrupt the framing.
    warn: (message) => void process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
  };
}

/**
 * stdio/dev: one `ProposalEnvironment` for the single token in `.auth/tokens.json`,
 * whoever that is. `authInfo` is ignored because stdio carries no per-caller identity —
 * which is precisely why this mode cannot be the deployed one.
 *
 * Loads credentials on first use and caches the success. A failure is not cached: the user
 * may be creating `.auth/google_oauth.json` right now, and the next call should see it.
 */
export function singleTokenEnvironmentResolver(): ResolveEnvironment {
  let cached: ProposalEnvironment | null = null;
  return async () => {
    if (cached !== null) return { kind: "ok", env: cached };
    const auth = await loadOAuthClient();
    if (auth.kind !== "ok") return { kind: "auth-failed", message: describeAuthFailure(auth) };
    cached = liveEnvironment({ drive: googleDriveChannel({ auth: auth.auth }) });
    return { kind: "ok", env: cached };
  };
}

/** The production feedback environment: real Drive comments, real clock. */
export function liveFeedbackEnvironment(
  options: Readonly<{ channel: FeedbackChannel }>,
): FeedbackEnvironment {
  return {
    channel: options.channel,
    now: () => new Date(),
    sleep: ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    // stdout is the MCP transport; a warning written there would corrupt the framing.
    warn: (message) => void process.stderr.write(`[${SERVER_NAME}] ${message}\n`),
  };
}

/** stdio/dev: the comment channel for the single token in `.auth/tokens.json`. */
export function singleTokenFeedbackEnvironmentResolver(): ResolveFeedbackEnvironment {
  let cached: FeedbackEnvironment | null = null;
  return async () => {
    if (cached !== null) return { kind: "ok", env: cached };
    const auth = await loadOAuthClient();
    if (auth.kind !== "ok") return { kind: "auth-failed", message: describeAuthFailure(auth) };
    cached = liveFeedbackEnvironment({ channel: googleFeedbackChannel({ auth: auth.auth }) });
    return { kind: "ok", env: cached };
  };
}

/**
 * HTTP/per-user: **not wired yet, and explicit about it.**
 *
 * The comment channel needs the caller's own `OAuth2Client`, and `http/user-drive.ts`'s
 * `UserDriveFactory` hands out a `DriveChannel` only — it closes over the client and does not
 * expose it. Rather than reach around that seam (or, far worse, fall back to the developer
 * token in `.auth/tokens.json` and write into one person's Drive on every caller's behalf),
 * this resolver declines with the exact change that would enable it. `http/**
 * HTTP/per-user: the comment channel for the caller's OWN Google account.
 *
 * Same rule as `brokeredEnvironmentResolver` and for the same reason: an unidentified caller
 * is a tool error, never a fallback to a shared token. A bearer that names no Google subject
 * must not be able to read one developer's comment threads.
 */
export function brokeredFeedbackEnvironmentResolver(
  options: Readonly<{ userDrive: UserDriveFactory }>,
): ResolveFeedbackEnvironment {
  return async ({ authInfo }) => {
    const subject = googleSubjectOf({ authInfo });
    if (subject === null) {
      return {
        kind: "auth-failed",
        message:
          "this request carries no verified Google identity. Reconnect the sasha-slides " +
          "connector so Claude can obtain an access token for your Google account.",
      };
    }
    const resolved = await options.userDrive.feedbackForGoogleSubject({ subject });
    switch (resolved.kind) {
      case "ok":
        return { kind: "ok", env: liveFeedbackEnvironment({ channel: resolved.feedback }) };
      case "unavailable":
        return { kind: "auth-failed", message: resolved.message };
      default:
        return assertNever(resolved);
    }
  };
}

/**
 * HTTP/per-user: the caller's verified bearer names exactly one Google subject, and the
 * Drive this resolves is built from *that* user's stored refresh token. Nothing falls back
 * to a shared token — an unidentified caller is a tool error, not a different user's
 * Drive. That is the property `test/oauth.test.ts` asserts by staging a proposal with
 * user A's token and finding user B's Drive empty.
 */
export function brokeredEnvironmentResolver(
  options: Readonly<{
    userDrive: UserDriveFactory;
    environmentFor: (options: Readonly<{ drive: DriveChannel }>) => ProposalEnvironment;
  }>,
): ResolveEnvironment {
  return async ({ authInfo }) => {
    const subject = googleSubjectOf({ authInfo });
    if (subject === null) {
      return {
        kind: "auth-failed",
        message:
          "this request carries no verified Google identity. Reconnect the sasha-slides " +
          "connector so Claude can obtain an access token for your Google account.",
      };
    }
    const resolved = await options.userDrive.forGoogleSubject({ subject });
    switch (resolved.kind) {
      case "ok":
        return { kind: "ok", env: options.environmentFor({ drive: resolved.drive }) };
      case "unavailable":
        return { kind: "auth-failed", message: resolved.message };
      default:
        return assertNever(resolved);
    }
  };
}

/**
 * The CLI. A mode flag is required: starting a server that silently picks stdio (and so
 * silently serves one developer's Drive to whoever connects) is the failure this
 * restructure exists to remove.
 */
export type ServerMode =
  | Readonly<{
      kind: "stdio";
      frameLogPath: string | null;
      /** Null looks for the skill markdown next to the server; a path overrides it. */
      skillFilePath: string | null;
      /** How many characters of `instructions` the client will keep. 0 means "no limit". */
      instructionsBudget: number;
    }>
  | Readonly<{
      kind: "http";
      publicUrl: string;
      host: string;
      port: number;
      /** Null keeps grants in memory; a path persists them for dev. */
      storePath: string | null;
      /** The per-account data keys, in a file of their own. Given exactly when `storePath` is. */
      keyStorePath: string | null;
      /** Null derives Google's redirect from publicUrl; a URL keeps it elsewhere (e.g. loopback). */
      googleCallbackUrl: string | null;
      /** The Google OAuth client file: a Web client in production, the Desktop one by default. */
      googleClientPath: string;
      /** Null offers the /account portal's sign-in with Google alone; a path lists the providers. */
      identityProvidersPath: string | null;
      /** Null leaves email and password sign-in off; a path is the Gmail API sender's JSON file. */
      mailSenderPath: string | null;
      /** Comma-separated proxy addresses or subnets whose X-Real-IP is believed; null is loopback alone. */
      trustedProxies: string | null;
      /** Null disables frame recording; a path appends one JSON line per JSON-RPC frame. */
      frameLogPath: string | null;
      /** Null looks for the skill markdown next to the server; a path overrides it. */
      skillFilePath: string | null;
      /** How many characters of `instructions` the client will keep. 0 means "no limit". */
      instructionsBudget: number;
      /** Where `decks/` and `deck-profiles/` live; null is beside `--store`, or in memory without it. */
      deckDataDirectory: string | null;
      /** The built web application (`engine/dist/web`); null is the one beside this server. */
      webBuildDirectory: string | null;
    }>
  | Readonly<{ kind: "usage"; reason: string | null }>;

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export function parseServerMode(args: readonly string[]): ServerMode {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let position = 0; position < args.length; position += 1) {
    const argument = args[position];
    if (argument === undefined) continue;
    if (VALUE_FLAGS.includes(argument)) {
      const value = args[position + 1];
      if (value === undefined) return { kind: "usage", reason: `${argument} needs a value` };
      values.set(argument, value);
      position += 1;
      continue;
    }
    if (!BARE_FLAGS.includes(argument)) return { kind: "usage", reason: `unknown argument ${argument}` };
    flags.add(argument);
  }
  if (flags.has("--help") || flags.has("-h")) return { kind: "usage", reason: null };

  const wantsStdio = flags.has("--stdio");
  const wantsHttp = flags.has("--http");
  if (wantsStdio && wantsHttp) return { kind: "usage", reason: "--stdio and --http are exclusive" };
  const frameLogPath = values.get("--frame-log") ?? null;
  const skillFilePath = values.get("--skill-file") ?? null;
  const instructionsBudget = parseInstructionsBudget(values.get("--instructions-budget"));
  if (instructionsBudget === null) {
    return { kind: "usage", reason: "--instructions-budget must be a non-negative integer (0 = no limit)" };
  }
  if (wantsStdio) {
    return { kind: "stdio", frameLogPath, skillFilePath, instructionsBudget };
  }
  if (!wantsHttp) return { kind: "usage", reason: "a mode is required: --http or --stdio" };

  const publicUrl = values.get("--public-url");
  if (publicUrl === undefined) {
    return { kind: "usage", reason: "--http needs --public-url (the URL Claude will reach this server on)" };
  }
  const port = parsePort(values.get("--port"));
  if (port === null) return { kind: "usage", reason: "--port must be an integer between 1 and 65535" };
  // Kept as a known flag only to refuse it by name: a silent no-op would hide a stale deploy.
  if (values.has("--comment-bot")) return { kind: "usage", reason: COMMENT_BOT_FLAG_REMOVED };
  const storePath = values.get("--store") ?? null;
  const keyStorePath = values.get("--key-store") ?? null;
  if ((storePath === null) !== (keyStorePath === null)) {
    return {
      kind: "usage",
      reason: "--store and --key-store go together: sealed grants in one file are useless without the keys in the other",
    };
  }
  return {
    kind: "http",
    publicUrl,
    host: values.get("--host") ?? DEFAULT_HTTP_HOST,
    port,
    storePath,
    keyStorePath,
    googleCallbackUrl: values.get("--google-callback-url") ?? null,
    googleClientPath: values.get("--google-client") ?? CLIENT_PATH,
    identityProvidersPath: values.get("--identity-providers") ?? null,
    mailSenderPath: values.get("--mail-sender") ?? null,
    trustedProxies: values.get("--trusted-proxy") ?? null,
    frameLogPath,
    skillFilePath,
    instructionsBudget,
    deckDataDirectory: values.get("--deck-data") ?? null,
    webBuildDirectory: values.get("--web-build") ?? null,
  };
}

export const USAGE = `sasha-slides MCP server

  npx tsx mcp/sasha-slides/server.ts --http --public-url <url> [--port ${String(DEFAULT_HTTP_PORT)}] [--host ${DEFAULT_HTTP_HOST}] [--store <path> --key-store <path>] [--identity-providers <path>] [--mail-sender <path> [--trusted-proxy <subnets>]] [--google-client <path>] [--deck-data <directory>] [--web-build <directory>]
  npx tsx mcp/sasha-slides/server.ts --stdio

  --http         Remote Streamable HTTP server with per-user brokered Google OAuth.
                 Each connecting user signs in with their own Google account and the
                 server acts as them. --public-url must be the exact URL Claude is
                 given; it becomes the OAuth "resource" identifier and must be HTTPS
                 for any non-loopback deployment.
  --store        File to persist client registrations and per-user Google grants in.
                 Omit to keep them in memory (a restart then forces re-consent).
                 Each user's Google tokens and email are sealed in it with that
                 user's own account key.
  --key-store    File to persist the per-account data keys in, wrapped under the
                 master key from the SASHA_MASTER_KEY environment variable (64 hex
                 characters). Required together with --store, and the server refuses
                 to start without SASHA_MASTER_KEY then. Generate a master key with
                   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                 Keep it, and this file, out of the --store file's backups: destroying
                 an account's key here is what makes its data unreadable everywhere.
  --identity-providers  JSON file of the sign-in providers offered at <public-url>/account,
                 where people delete their data: {"providers": [{"name": "github",
                 "clientId": "...", "clientSecret": "..."}, ...]}. Presets: google,
                 github, apple; any other name needs "displayName" and an OpenID Connect
                 "issuer". google may omit credentials to reuse the connector's client.
                 apple takes "clientId" (the Services ID), "teamId", "keyId" and
                 "privateKeyPath" (the .p8 key, relative to this file) instead of a secret.
                 Without this flag the portal offers Google alone. The portal signs its
                 session cookie with SASHA_SESSION_SECRET (32+ characters), which this flag
                 requires; with neither, /account is off.
  --mail-sender  JSON file that turns on email and password sign-in at <public-url>/account,
                 mailing confirmation and reset links through the Gmail API as one Google
                 account: {"clientId": "...", "clientSecret": "...", "refreshToken": "...",
                 "from": "Sasha Slides <address>"}. Mint it with
                   npx tsx mcp/sasha-slides/e2e/gmail-sender-token.ts <file>
                 (scope gmail.send only). Needs SASHA_SESSION_SECRET, like the flag above.
  Comments     watch_comments and the other comment tools are always on with --http: each
                 watch reads and answers comments as the user who started it, with their own
                 Google grant (drive.file), and every line starts with "Sasha: ". Google pushes
                 Drive changes to <public-url>/hooks/drive, so that path must reach this server
                 over HTTPS; --store keeps watches across restarts. The first time for a deck the
                 user chooses it once on <public-url>/comments/allow, which opens the Google
                 Picker and needs SASHA_PICKER_API_KEY (an API key of the OAuth client's
                 project, Google Picker API enabled). (--comment-bot, a shared bot account,
                 was removed and is refused.)
  --trusted-proxy  Comma-separated addresses or CIDR subnets of the reverse proxy, whose
                 X-Real-IP header is believed when limiting sign-in attempts and mail per
                 client. Loopback is always trusted. Behind Docker's published port the
                 connection comes from the bridge gateway, e.g. --trusted-proxy 172.16.0.0/12.
  --deck-data    Directory for the deck server's files: decks/ (every record sealed with the
                 owner's account key) and deck-profiles/. Defaults to the directory of --store
                 (/data in production); without --store, decks live in memory. Decks need the
                 account portal (SASHA_SESSION_SECRET), where people sign in to them.
  --web-build    The built deck web application (manifest.json and its files). Defaults to
                 engine/dist/web next to this server; without a build, /decks answers 503.
  --google-callback-url  TESTING. Where Google returns the user, instead of
                 <public-url>/oauth/google/callback. A Desktop OAuth client only accepts
                 http://127.0.0.1 redirects, so behind a tunnel this keeps Google's leg on
                 loopback -- which only works for a browser on the server's own machine.
  --stdio        DEV ONLY. Serves over stdio using the single token in
                 .auth/tokens.json. No per-user identity exists on this transport.
  --skill-file   The workflow guide returned to the client as the MCP "instructions"
                 string. Defaults to ${SKILL_RELATIVE_PATH} next to the server. If it
                 cannot be read the server still starts and serves a terse built-in
                 fallback, so a deployment that ships without it is degraded, not broken.
  --instructions-budget
                 How many characters of the "instructions" string the client will keep.
                 Default ${String(CLAUDE_CODE_INSTRUCTIONS_BUDGET)}, which is where Claude Code 2.1.285 was measured to cut
                 it (and then append "... [truncated]"). The server drops whole low-priority
                 sections to fit, rather than letting the client cut one mid-sentence. Pass 0
                 for a client with no such limit.
  --frame-log    File to append one JSON line per JSON-RPC frame to, in both directions -
                 which is how "did the client ask for prompts/list?" and "did it read the
                 instructions we returned?" are answered by measurement. Diagnostics only.
`;

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Both halves of a candidate comment, resolved from the SAME caller.
 *
 * Addressing a comment by `(proposalId, slideIndex)` needs Drive (to find `NN.html`) and the
 * comment channel (to read its threads), and in HTTP mode both must be that one caller's. The
 * two resolvers are called separately rather than merged so neither can quietly fall back to
 * the other's identity; the first failure is the message, because a half-resolved environment
 * is not usable for anything.
 */
async function resolveCandidateEnvironment(
  options: Readonly<{
    resolveEnvironment: ResolveEnvironment;
    resolveFeedbackEnvironment: ResolveFeedbackEnvironment;
    authInfo: AuthInfo | undefined;
  }>,
): Promise<CandidateEnvironmentLoad> {
  const { resolveEnvironment, resolveFeedbackEnvironment, authInfo } = options;
  const proposal = await resolveEnvironment({ authInfo });
  if (proposal.kind === "auth-failed") return { kind: "auth-failed", message: proposal.message };
  const feedback = await resolveFeedbackEnvironment({ authInfo });
  if (feedback.kind === "auth-failed") return { kind: "auth-failed", message: feedback.message };
  return { kind: "ok", env: { proposal: proposal.env, feedback: feedback.env } };
}

type CandidateEnvironmentLoad =
  | Readonly<{ kind: "ok"; env: CandidateFeedbackEnvironment }>
  | Readonly<{ kind: "auth-failed"; message: string }>;

/**
 * What a half-finished revision left behind, so a caller knows what a retry repeats.
 *
 * Exhaustive: a new stage in `reviseSlide` must come with its own sentence here rather than
 * silently reporting a bare Drive error with no idea what state the proposal is in.
 */
function driveStageHint(stage: ReviseStage): string {
  switch (stage) {
    case "locate":
      return " - nothing was changed.";
    case "upload":
      return " - the candidate was not replaced, so nothing changed.";
    case "event":
      return (
        " - the HTML was replaced but neither the log nor manifest.revision moved, so no " +
        "reader has seen it; call revise_slide again."
      );
    case "manifest":
      return (
        " - the HTML and the log entry are in place but manifest.revision did NOT move, so " +
        "the interface will not re-read it; call revise_slide again."
      );
    default:
      return assertNever(stage);
  }
}

/** The log, shaped for the wire. An opaque event keeps its own kind, not ours. */
function sessionLogPayload(
  options: Readonly<{ revision: number | null; log: ReadSessionEventsOutcome }>,
): ToolOutcome<SessionEventsPayload> {
  const { revision, log } = options;
  switch (log.kind) {
    case "ok":
      return {
        kind: "payload",
        payload: {
          status: "ok",
          revision,
          eventCount: log.records.length,
          events: log.records.map(sessionEventPayload),
          unreadable: log.unreadable,
          note:
            log.records.length === 0
              ? "the log is empty; this proposal has an events folder but nothing has happened in it yet"
              : null,
        },
      };
    case "no-log":
      return {
        kind: "payload",
        payload: {
          status: "no-log",
          revision,
          eventCount: 0,
          events: [],
          unreadable: [],
          note:
            "this proposal has no events folder, so it was staged before the session log existed. " +
            "That is not an error and not an empty history - it is an unknown one.",
        },
      };
    case "drive-failed":
      return { kind: "error", message: `session_events: the log could not be listed: ${log.reason}` };
    default:
      return assertNever(log);
  }
}

function sessionEventPayload(record: SessionEventRecord): SessionEventPayload {
  const { event } = record;
  return {
    eventId: record.eventId,
    // An unknown kind reports what its WRITER called it, so a reader is not told "opaque"
    // when the file says "slide-anonymised".
    kind: event.kind === "opaque" ? event.rawKind : event.kind,
    at: event.at,
    summary: describeSessionEvent(event),
    fields: sessionEventBody(event),
  };
}

function feedbackThreadPayload(thread: FeedbackThread): FeedbackThreadPayload {
  const placement = slidePlacement(thread.slide);
  return {
    commentId: thread.commentId,
    author: thread.author,
    text: thread.text,
    createdTime: thread.createdTime,
    modifiedTime: thread.modifiedTime,
    resolved: thread.resolved,
    slideNumber: placement.slideNumber,
    pageObjectId: placement.pageObjectId,
    slide: placement.description,
    elementObjectIds: placement.elementObjectIds,
    anchorRaw: thread.anchorRaw,
    anchor: describeCommentAnchor(thread.anchor),
    quotedText: thread.quotedText,
    region: thread.sentinel?.region ?? null,
    noteId: thread.sentinel?.noteId ?? null,
    replies: thread.replies.map((reply) => ({
      replyId: reply.replyId,
      author: reply.author,
      text: reply.text,
      createdTime: reply.createdTime,
      action: reply.action,
      authoredByAgent: reply.authoredByAgent,
    })),
  };
}

function feedbackPostPayload(post: FeedbackPost): FeedbackPostPayload {
  const placement = slidePlacement(post.slide);
  return {
    kind: post.kind,
    postId: post.postId,
    commentId: post.commentId,
    author: post.author,
    text: post.text,
    postedAt: post.postedAt,
    action: post.action,
    slideNumber: placement.slideNumber,
    pageObjectId: placement.pageObjectId,
    slide: placement.description,
  };
}

/** The reason the deck could not be read, or null when it could. One exhaustive switch. */
function slideNumberingFailure(numbering: SlideNumbering): string | null {
  switch (numbering.kind) {
    case "ok":
    // A candidate needs no deck read, so there is nothing that could have failed.
    case "candidate":
      return null;
    case "unavailable":
      return numbering.reason;
    default:
      return assertNever(numbering);
  }
}

function slideCountOf(numbering: SlideNumbering): number | null {
  switch (numbering.kind) {
    case "ok":
      return numbering.slideCount;
    case "unavailable":
    // Not "0 slides": a candidate is one HTML document, not a deck with a page count.
    case "candidate":
      return null;
    default:
      return assertNever(numbering);
  }
}

/** Says why slide numbers are missing, and why a thread may have no slide at all. */
function readFeedbackNote(outcome: ReadFeedbackOutcome): string | null {
  const unreadableDeck = slideNumberingFailure(outcome.slideNumbering);
  if (unreadableDeck !== null) {
    return `the deck's slide order could not be read (${unreadableDeck}), so slideNumber is null throughout`;
  }
  if (outcome.threads.length === 0) return "no open comment threads on these candidates";
  const unlocated = outcome.threads.filter((thread) => !slidePlacement(thread.slide).located).length;
  if (unlocated === 0) return null;
  return (
    `${String(unlocated)} of ${String(outcome.threads.length)} thread(s) could not be placed on a slide. ` +
    "Google only records an anchor for comments made in the Slides UI; a comment created " +
    "through the API is unanchored. Ask the user which slide, or have them re-file it from " +
    "the Slides comment UI."
  );
}

/**
 * WHETHER THE RECEIPT LANDED, through an exhaustive switch so a fourth `DeliveryReceipt` arm has to
 * decide. Note that `nothing-delivered` reports FALSE: nothing was handed over, so nothing was
 * logged, and the field means exactly what it says rather than "all is well".
 */
function deliveryWasLogged(delivery: DeliveryReceipt): boolean {
  switch (delivery.kind) {
    case "logged":
      return true;
    case "nothing-delivered":
    case "log-failed":
      return false;
    default:
      return assertNever(delivery);
  }
}

/**
 * The tool note, plus the consequence of a receipt that did not reach Drive -- which is a USER-side
 * consequence the agent cannot otherwise guess: their add-on will tell them nobody is listening
 * while this session is reading them. Only `log-failed` says anything; the other two are ordinary.
 */
function noteWithDelivery(
  options: Readonly<{ note: string | null; delivery: DeliveryReceipt }>,
): string | null {
  const { note, delivery } = options;
  switch (delivery.kind) {
    case "logged":
    case "nothing-delivered":
      return note;
    case "log-failed": {
      const warning =
        `the comments were delivered but the feedback-delivered receipt could not be written ` +
        `(${delivery.reason}), so the user's add-on cannot see that you read them and will say ` +
        "nobody is listening until the log is writable again";
      return note === null ? warning : `${note}. ${warning}`;
    }
    default:
      return assertNever(delivery);
  }
}

/** 6 base36 characters, as PROTOCOL.md specifies for the proposalId suffix. */
function randomSuffix(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(-6);
}

/** Why `--comment-bot` is refused: the shared Sasha Google account it configured is gone. */
export const COMMENT_BOT_FLAG_REMOVED =
  "--comment-bot was removed: the comment bot now acts as each signed-in user with their own Google grant, so there is " +
  "no bot account to configure. Drop the flag (and its secret file); see mcp/sasha-slides/CONNECT.md, \"Answering comments\".";

const VALUE_FLAGS: readonly string[] = [
  "--public-url",
  "--skill-file",
  "--instructions-budget",
  "--port",
  "--host",
  "--store",
  "--key-store",
  "--google-callback-url",
  "--identity-providers",
  "--mail-sender",
  "--comment-bot",
  "--trusted-proxy",
  "--google-client",
  "--frame-log",
  "--deck-data",
  "--web-build",
];
const BARE_FLAGS: readonly string[] = ["--http", "--stdio", "--help", "-h"];

/** Null is "not a budget"; `undefined` is "not given", which takes the measured default. */
function parseInstructionsBudget(value: string | undefined): number | null {
  if (value === undefined) return CLAUDE_CODE_INSTRUCTIONS_BUDGET;
  const budget = Number.parseInt(value, 10);
  return Number.isSafeInteger(budget) && budget >= 0 ? budget : null;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_HTTP_PORT;
  const port = Number.parseInt(value, 10);
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : null;
}

async function main(): Promise<void> {
  const mode = parseServerMode(process.argv.slice(2));
  switch (mode.kind) {
    case "stdio":
      await serveStdio(mode);
      return;
    case "http":
      await serveHttp(mode);
      return;
    case "usage":
      process.stderr.write(USAGE);
      if (mode.reason !== null) {
        process.stderr.write(`\nerror: ${mode.reason}\n`);
        process.exitCode = 2;
      }
      return;
    default:
      return assertNever(mode);
  }
}

async function serveStdio(
  mode: Readonly<{
    frameLogPath: string | null;
    skillFilePath: string | null;
    instructionsBudget: number;
  }>,
): Promise<void> {
  const instructions = workflowInstructionsFromDisk({
    cwd: process.cwd(),
    override: mode.skillFilePath,
    budget: mode.instructionsBudget,
  });
  const server = createSashaSlidesServer({
    resolveEnvironment: singleTokenEnvironmentResolver(),
    resolveFeedbackEnvironment: singleTokenFeedbackEnvironmentResolver(),
    instructions: instructions.text,
    remote: false,
  });
  await server.connect(
    instrumentedTransport({
      inner: new StdioServerTransport(),
      frameLogPath: mode.frameLogPath,
    }),
  );
  process.stderr.write(
    `[${SERVER_NAME}] ready on stdio (dev mode: single .auth/tokens.json identity)\n`,
  );
  process.stderr.write(`[${SERVER_NAME}] ${describeInstructions(instructions)}\n`);
}

/**
 * The composition root's one decision about observability: without `--frame-log` the transport
 * is handed over untouched, so the logging path cannot affect a real deployment.
 */
function instrumentedTransport(options: Readonly<{ inner: Transport; frameLogPath: string | null }>): Transport {
  const { inner, frameLogPath } = options;
  if (frameLogPath === null) return inner;
  return new RecordingTransport({
    inner,
    endpoint: "server",
    now: () => new Date(),
    record: (frame) => appendFileSync(frameLogPath, formatFrameLine(frame), "utf8"),
  });
}

function serveHttp(
  mode: Extract<ServerMode, Readonly<{ kind: "http" }>>,
): Promise<void> {
  const warn = (message: string): void => void process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  const loaded = loadBrokeredStack({
    publicUrl: mode.publicUrl,
    storePath: mode.storePath,
    keyStorePath: mode.keyStorePath,
    env: process.env,
    googleCallbackUrl: mode.googleCallbackUrl,
    googleClientPath: mode.googleClientPath,
    warn,
  });
  if (loaded.kind === "failed") {
    process.stderr.write(`[${SERVER_NAME}] cannot start: ${loaded.message}\n`);
    process.exitCode = 1;
    return Promise.resolve();
  }
  const { stack } = loaded;
  const decks = loadDeckServer({ mode, stack, warn });
  if (decks.kind === "failed") {
    process.stderr.write(`[${SERVER_NAME}] cannot start: ${decks.message}\n`);
    process.exitCode = 1;
    return Promise.resolve();
  }
  const deckServer = decks.kind === "ok" ? decks.server : null;
  const portal = loadAccountPortal({
    publicUrl: mode.publicUrl,
    identityProvidersPath: mode.identityProvidersPath,
    mailSenderPath: mode.mailSenderPath,
    trustedProxies: mode.trustedProxies,
    googleClientPath: mode.googleClientPath,
    sessionSecret: process.env.SASHA_SESSION_SECRET,
    store: stack.store,
    vault: stack.vault,
    eraser: deckServer === null ? stack.eraser : withDeckErasure({ eraser: stack.eraser, eraseDecks: deckServer.eraseAccount }),
    deckSessionStart: deckServer === null ? null : deckServer.deckSessionStart,
    warn,
  });
  if (portal.kind === "failed") {
    process.stderr.write(`[${SERVER_NAME}] cannot start: ${portal.message}\n`);
    process.exitCode = 1;
    return Promise.resolve();
  }
  const commentBot = loadCommentBot({
    publicUrl: mode.publicUrl,
    googleCallbackUrl: stack.endpoints.googleCallbackUrl,
    googleClient: stack.googleClient,
    pickerApiKey: process.env.SASHA_PICKER_API_KEY,
    store: stack.store,
    warn,
  });
  const bot = commentBot.bot;
  const instructions = workflowInstructionsFromDisk({
    cwd: process.cwd(),
    override: mode.skillFilePath,
    budget: mode.instructionsBudget,
  });
  // Each tool call resolves the caller's own Drive; there is no shared Drive client here.
  const resolveEnvironment = brokeredEnvironmentResolver({
    userDrive: stack.userDrive,
    environmentFor: ({ drive }) => liveEnvironment({ drive }),
  });
  const httpServer = createSashaSlidesHttpServer({
    authorizationServer: stack.authorizationServer,
    createMcpServer: () =>
      createSashaSlidesServer({
        resolveEnvironment,
        resolveFeedbackEnvironment: brokeredFeedbackEnvironmentResolver({ userDrive: stack.userDrive }),
        instructions: instructions.text,
        remote: true,
        commentBot: bot,
        ...(deckServer === null ? {} : { decks: { deckService: deckServer.deckService, callerFor: deckServer.callerFor, publicUrl: mode.publicUrl } }),
      }),
    instrumentTransport: (inner) =>
      instrumentedTransport({
        inner,
        frameLogPath: mode.frameLogPath,
      }),
    warn,
    ...(portal.kind === "ok" ? { accountPortal: portal.portal } : {}),
    driveHook: driveHookFor(bot),
    commentAccess: commentBot.accessPage,
    ...(deckServer === null ? {} : { decks: deckServer }),
  });
  if (deckServer !== null) shutDownOnTerminate({ deckServer, httpServer, warn });
  return new Promise<void>((resolve) => {
    httpServer.listen(mode.port, mode.host, () => {
      for (const line of startupBanner({
        endpoints: stack.endpoints,
        mode,
        store: stack.storeDescription,
        keyStore: stack.keyStoreDescription,
        instructions,
      })) {
        process.stderr.write(`[${SERVER_NAME}] ${line}\n`);
      }
      for (const line of portal.banner) process.stderr.write(`[${SERVER_NAME}] ${line}\n`);
      for (const line of commentBot.banner) process.stderr.write(`[${SERVER_NAME}] ${line}\n`);
      for (const line of decks.banner) process.stderr.write(`[${SERVER_NAME}] ${line}\n`);
      void bot.start().catch((cause: unknown) => warn(`comment bot: start failed: ${String(cause)}`));
      resolve();
    });
  });
}

type DeckServerLoad =
  | Readonly<{ kind: "ok"; server: DeckServer; banner: readonly string[] }>
  | Readonly<{ kind: "off"; banner: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * The deck server (decks/deck-stack.ts) when the account portal can sign people in to it: it needs
 * SASHA_SESSION_SECRET for its cookie. Files go beside `--store` (or `--deck-data`), else memory.
 */
function loadDeckServer(
  options: Readonly<{
    mode: Extract<ServerMode, Readonly<{ kind: "http" }>>;
    stack: Pick<BrokeredStack, "store" | "vault">;
    warn: (message: string) => void;
  }>,
): DeckServerLoad {
  const { mode, stack, warn } = options;
  const secretText = process.env.SASHA_SESSION_SECRET;
  if (secretText === undefined || secretText === "") return { kind: "off", banner: ["decks: off (they sign in through /account; set SASHA_SESSION_SECRET)"] };
  const secret = parseSessionSecret(secretText);
  if (secret.kind === "error") return { kind: "failed", message: secret.message };
  const credentials = loadClientCredentials({ path: mode.googleClientPath });
  if (credentials.kind !== "ok") return { kind: "failed", message: describeAuthFailure(credentials) };
  const dataDirectory = mode.deckDataDirectory ?? (mode.storePath === null ? null : dirname(mode.storePath));
  let storage: DeckStorage;
  if (dataDirectory === null) storage = memoryDeckStorage();
  else {
    const opened = openFileDeckStorage({ decksDirectory: join(dataDirectory, "decks"), profilesDirectory: join(dataDirectory, "deck-profiles"), vault: stack.vault, warn });
    if (opened.kind === "failed") return opened;
    storage = opened.storage;
  }
  const webBuildDirectory = mode.webBuildDirectory ?? join(__dirname, "engine", "dist", "web");
  const server = createDeckServer({
    publicUrl: mode.publicUrl,
    storage,
    store: stack.store,
    vault: stack.vault,
    directory: storeAccountDirectory({ store: stack.store, vault: stack.vault, now: () => new Date(), newAccountId: randomAccountId }),
    sessionSecret: secret.secret,
    webDistributionDirectory: webBuildDirectory,
    googleClient: credentials.credentials,
    createGoogleSlidesInterchange,
    timers: REAL_TIMERS,
    now: () => Date.now(),
    random: Math.random,
    randomBytes: cryptoRandom,
    randomToken: randomUrlSafeToken,
    fetch,
    warn,
  });
  return {
    kind: "ok",
    server,
    banner: [`decks: ${mode.publicUrl.replace(/\/+$/, "")}/decks (files: ${storage.description}; web build: ${webBuildDirectory})`],
  };
}

/**
 * SIGTERM (Docker stop, a deploy): every deck socket closes `serverShuttingDown` (4013) so clients
 * reconnect with backoff, every room flushes its last 250 milliseconds, then the process exits.
 */
function shutDownOnTerminate(options: Readonly<{ deckServer: DeckServer; httpServer: ListeningServer; warn: (message: string) => void }>): void {
  process.once("SIGTERM", () => {
    options.deckServer
      .shutdown()
      .catch((cause: unknown) => options.warn(`decks: shutdown failed: ${String(cause)}`))
      .finally(() => {
        options.httpServer.close();
        process.exit(0);
      });
  });
}

/** Drive push → HTTP status: 200 for our channel, 403 for anything that is not. */
function driveHookFor(bot: CommentBot): (options: Readonly<{ headers: IncomingHttpHeaders }>) => Promise<number> {
  return async ({ headers }) => {
    const outcome = await bot.handlePush({ headers });
    switch (outcome.kind) {
      case "accepted":
      case "sync-message":
        return 200;
      case "ignored":
        return 403;
      default:
        return assertNever(outcome);
    }
  };
}

function startupBanner(
  options: Readonly<{
    endpoints: Endpoints;
    mode: Readonly<{ host: string; port: number }>;
    store: string;
    keyStore: string;
    instructions: WorkflowInstructions;
  }>,
): readonly string[] {
  const { endpoints, mode, store, keyStore, instructions } = options;
  const lines = [
    describeInstructions(instructions),
    `listening on http://${mode.host}:${String(mode.port)}`,
    `MCP endpoint (the OAuth "resource"): ${endpoints.mcpUrl}`,
    `protected resource metadata: ${endpoints.protectedResourceMetadataUrl}`,
    `register this Google redirect URI: ${endpoints.googleCallbackUrl}`,
    `per-user Google grants: ${store}`,
    `per-account data keys: ${keyStore}`,
  ];
  if (!endpoints.publicUrl.startsWith("https://")) {
    lines.push(
      "WARNING: --public-url is not https. Claude will only connect to a remote MCP server over HTTPS; " +
        "put this behind a TLS terminator (or a tunnel) and pass its public URL.",
    );
  }
  return lines;
}

/**
 * One banner line saying where the client's `instructions` string came from. A connector that
 * silently served the degraded fallback would look identical to a healthy one from the
 * outside, which is exactly the failure this line exists to make visible.
 */
function describeInstructions(instructions: WorkflowInstructions): string {
  return `${instructionsHeadline(instructions.source)}: ${instructions.detail}`;
}

function instructionsHeadline(source: WorkflowInstructionsSource): string {
  switch (source) {
    case "skill-file":
      return "client instructions from the workflow skill";
    case "fallback":
      return "WARNING: workflow skill unreadable, serving the terse built-in instructions";
    default:
      return assertNever(source);
  }
}

/**
 * tsx emits CommonJS here (the root package.json has no "type": "module"), so top-level
 * await is unavailable and `main` is wrapped. The guard keeps importing this module from a
 * test from starting a server on the test runner's stdio.
 */
function invokedAsEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && /[\\/]server\.(?:ts|js|mjs|cjs)$/.test(entry);
}

if (invokedAsEntryPoint()) void main();
