/**
 * `deck_write_transition` AS COMMANDS. A scripted transition is arbitrary code a model wrote from a
 * prompt someone else may control, so it is saved UNAPPROVED whoever's account the agent acts for
 * -- the deck owner's included -- and runs only after a person approves that exact text in the
 * editor (document.ts `TransitionApproval`, collaboration.ts header). The save and the slides that
 * should use it travel in ONE envelope: one undo step, and the slides never point at a script that
 * is not there.
 *
 * Sizes are checked here, before anything is sent, against the runner's limits
 * (transition-limits.ts): a script the presenter would refuse to load is not worth storing.
 */
import type { AssistantTransitionScript } from "../engine/src/contracts/assistant-deck-tools.ts";
import type { DocumentCommand } from "../engine/src/contracts/commands.ts";
import type { DocumentSnapshot } from "../engine/src/contracts/document.ts";
import { mintId, type IdSeed, type TransitionScriptId } from "../engine/src/contracts/ids.ts";
import { SCRIPT_LIMITS } from "./transition-limits.ts";

export type TransitionScriptExpansion =
  | Readonly<{ kind: "expanded"; scriptId: TransitionScriptId; commands: readonly DocumentCommand[]; seed: IdSeed }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export function expandTransitionScript(
  options: Readonly<{ snapshot: DocumentSnapshot; request: AssistantTransitionScript; seed: IdSeed }>,
): TransitionScriptExpansion {
  const { snapshot, request } = options;
  const tooLarge = sizeProblem(request);
  if (tooLarge !== null) return { kind: "rejected", reason: tooLarge };
  const existing = request.scriptId === null ? null : (snapshot.transitionScripts.find((script) => script.id === request.scriptId) ?? null);
  if (request.scriptId !== null && existing === null) {
    return { kind: "rejected", reason: `transitionScriptMissing: there is no transition script ${request.scriptId} in this deck; pass scriptId null to write a new one` };
  }
  const slideIds = new Set(snapshot.slides.map((slide) => slide.id));
  const missingSlide = request.assignTo.find((assignment) => !slideIds.has(assignment.slideId));
  if (missingSlide !== undefined) return { kind: "rejected", reason: `slideMissing: there is no slide ${missingSlide.slideId} in this deck` };
  const minted = request.scriptId === null ? mintId({ seed: options.seed, kind: "transitionScript" }) : { id: request.scriptId, seed: options.seed };
  const scriptId = minted.id;
  const commands: DocumentCommand[] = [
    {
      kind: "upsertTransitionScript",
      script: {
        id: scriptId,
        name: request.name,
        description: request.description,
        script: request.script,
        stylesheet: request.stylesheet,
        markup: request.markup,
        defaultParameters: request.defaultParameters,
      },
      basedOnUpdatedAt: existing?.updatedAt ?? null,
      approval: "unapproved",
    },
    ...request.assignTo.map(
      (assignment): DocumentCommand => ({
        kind: "setSlideProperties",
        slideId: assignment.slideId,
        patch: { transition: { kind: "scripted", scriptId, durationMilliseconds: assignment.durationMilliseconds, parameters: {} } },
      }),
    ),
  ];
  return { kind: "expanded", scriptId, commands, seed: minted.seed };
}

function sizeProblem(request: AssistantTransitionScript): string | null {
  const checks = [
    { field: "script", text: request.script, limit: SCRIPT_LIMITS.maximumScriptBytes },
    { field: "stylesheet", text: request.stylesheet, limit: SCRIPT_LIMITS.maximumStylesheetBytes },
    { field: "markup", text: request.markup, limit: SCRIPT_LIMITS.maximumOverlayMarkupBytes },
  ] as const;
  for (const check of checks) {
    const bytes = Buffer.byteLength(check.text, "utf8");
    if (bytes > check.limit) {
      return `tooLarge: the ${check.field} is ${String(bytes)} bytes; the presenter runs at most ${String(check.limit)} (${String(check.limit / 1024)} kilobytes)`;
    }
  }
  return null;
}
