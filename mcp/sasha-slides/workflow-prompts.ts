/**
 * The connector's prompt templates: the second way the workflow travels with the connector.
 *
 * The `instructions` string (the skill body, see `workflow-instructions.ts`) teaches the
 * agent the rules; these teach the *user* the entry points. Claude Code surfaces a server's prompts as slash commands named
 * `/mcp__<server>__<prompt>`, so registering `new_deck` here is what makes
 * `/mcp__sasha-slides__new_deck` appear in the user's slash-command list the moment the
 * connector is added - no skill to install, no long prompt to type. Measured against real
 * Claude Code 2.1.285 in `e2e/connector-guidance-probe.ts`.
 *
 * A prompt is a *user* message, not a system one: `prompts/get` returns the text and the
 * client submits it as the user's turn. So each builder below reads as something the user
 * would have said, and restates only the steps that particular entry point needs - the rules
 * themselves are already in the instructions, and repeating them here would pay for them
 * twice and give them a second place to drift. Nothing below may contradict the skill: in
 * particular only ONE proposal is outstanding at a time, so a second wave follows a resolved
 * `await_pick` and is never staged alongside the first.
 *
 * The builders are pure and exported separately from `registerWorkflowPrompts` so the text
 * can be asserted from a unit test with no server and no transport.
 *
 * **Each prompt declares exactly ONE argument, and that is a measurement, not a style.**
 * `e2e/connector-guidance-probe.ts` ran a server declaring prompts with one, two and no
 * arguments against real Claude Code 2.1.285 and read the `prompts/get` params off the wire:
 * the client **splits the slash-command text on whitespace and binds the words positionally
 * to the declared arguments, discarding the rest**. `/mcp__argprobe__two_args our Q3
 * retention numbers` arrived as `{first:"our", second:"Q3"}`. So a second declared argument
 * does not merely fail to help - it actively corrupts the expansion, which is how
 * `/mcp__sasha-slides__new_deck our Q3 retention numbers` once produced "Audience: Q3. Aim
 * for retention slides. Insert the picks into the existing deck numbers."
 *
 * Nothing the user typed is lost from the model's view, which is why one argument is enough:
 * the same probe showed the expanded user turn carries `<command-args>` with the RAW text in
 * full, followed by the template this file returns. `new_deck` therefore takes one free-text
 * argument and says so in the template; the other two take an id, which is a single token and
 * binds exactly.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Every prompt name this server registers, in the order a user meets them. */
export const WORKFLOW_PROMPT_NAMES: readonly string[] = ["new_deck", "revise_from_feedback", "second_wave"];

export function registerWorkflowPrompts(options: Readonly<{ server: McpServer }>): void {
  const { server } = options;

  server.registerPrompt(
    "new_deck",
    {
      title: "Make candidate slides about a topic",
      description:
        "Start a deck the sasha-slides way: several candidate slides written to HTML files, " +
        "staged for the user to pick from in Google Slides, drafted fast so there is something " +
        "to react to within seconds.",
      argsSchema: {
        request: z.string().min(1).describe("What you want slides about, in your own words."),
      },
    },
    (args) => newDeckPrompt({ request: args.request }),
  );

  server.registerPrompt(
    "revise_from_feedback",
    {
      title: "Revise a deck from the user's comments",
      description:
        "Read the native Google Slides comments the user left on a deck and turn each one " +
        "into fresh candidate slides, answering in the thread the comment came from.",
      argsSchema: {
        presentationId: z.string().min(1).describe("The Google Slides file id to read comments from."),
      },
    },
    (args) => reviseFromFeedbackPrompt({ presentationId: args.presentationId }),
  );

  server.registerPrompt(
    "second_wave",
    {
      title: "Send a considered second wave",
      description:
        "Follow a deliberately fast first wave with a better-considered set of candidates, " +
        "staged as a new proposal, using the pick and the anomalies as the brief.",
      argsSchema: {
        proposalId: z.string().min(1).describe("The proposalId of the first wave, from propose_slides."),
      },
    },
    (args) => secondWavePrompt({ proposalId: args.proposalId }),
  );
}

export function newDeckPrompt(options: Readonly<{ request: string }>): GetPromptResult {
  const { request } = options;
  const lines = [
    `Make candidate slides for: ${request}`,
    "",
    "(If that line holds only the first word of what I asked for, my full request is in the message this arrived with - work from that.)",
    "",
    "Work it the sasha-slides way:",
    "1. Write each candidate to its own self-contained 1280x720 HTML file on disk. Markup never goes into a tool argument and a candidate is never read back.",
    "2. Call propose_slides with the file PATHS and one short label each - a fast first wave, four genuinely different layouts, published as soon as they are plausible rather than when they are perfect.",
    "3. Call await_pick with the returned proposalId and wait for me.",
    "4. Use the 1-based picked index and any anomalies I marked as the brief for the next wave: another propose_slides call, once this one is answered.",
  ];
  return {
    description: `Candidate slides for "${request}", drafted fast then refined`,
    messages: [userMessage({ text: lines.join("\n") })],
  };
}

export function reviseFromFeedbackPrompt(options: Readonly<{ presentationId: string }>): GetPromptResult {
  const { presentationId } = options;
  const lines = [
    `Revise the deck ${presentationId} from the comments I left on it.`,
    "",
    "(If I narrowed the pass in the message this arrived with - a slide range, only the charts - honour that and leave the rest alone.)",
    "",
    "1. read_feedback on that presentationId - my open threads, verbatim, with the slide each sits on.",
    "2. For each thread, write revised candidates to HTML files and stage them with propose_slides (paths only, one short label each), then await_pick.",
    "3. reply_feedback in the thread the comment came from, saying what changed, and resolve_feedback once it is actually addressed.",
    "4. await_feedback with the cursor you were handed, so you catch my next round instead of asking me whether I am done.",
  ];
  return {
    description: `Revise ${presentationId} from its open comment threads`,
    messages: [userMessage({ text: lines.join("\n") })],
  };
}

export function secondWavePrompt(options: Readonly<{ proposalId: string }>): GetPromptResult {
  const { proposalId } = options;
  const lines = [
    `Send a considered second wave of candidates for proposal ${proposalId}.`,
    "",
    "The first wave was deliberately fast; this one does not have to be. Wave one is answered, so a new proposal is now the right move.",
    "1. If you no longer have the pick and the anomalies, call proposal_state on that proposalId.",
    "2. Write a fresh set of HTML candidate files that answer what the pick and the anomalies told you.",
    "3. Stage them as a NEW proposal with propose_slides - paths only - and await_pick on the new proposalId.",
    "Keep every index 1-based so \"option 3\" still means the same slide to both of us.",
  ];
  return {
    description: `Second wave of candidates for ${proposalId}`,
    messages: [userMessage({ text: lines.join("\n") })],
  };
}

/**
 * A prompt's content is submitted as the user's own turn, so "user" is the only role these
 * templates ever produce - an assistant-role message here would be words the model never
 * said.
 */
function userMessage(options: Readonly<{ text: string }>): GetPromptResult["messages"][number] {
  return { role: "user", content: { type: "text", text: options.text } };
}
