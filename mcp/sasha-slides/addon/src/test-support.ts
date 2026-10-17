// TEST-ONLY helpers shared by the unit tests: folding events through a reducer, rendering the two
// React trees with no ports, and a synchronous stand-in for the converter. Excluded from
// tsconfig.json (the shipped-sources gate) like inert-actions.ts and fake-drive.ts: nothing that
// ships imports it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationPanel } from "./Conversation.tsx";
import type { ConversionResult } from "./converter-contract.ts";
import { INERT_CONVERSATION_ACTIONS, INERT_PICKER_ACTIONS, UNCONFIGURED_SETUP } from "./inert-actions.ts";
import { Picker } from "./Picker.tsx";
import type { Conversation } from "./conversation-state.ts";
import type { PickerState } from "./picker-state.ts";
import { WHOLE_SLIDE } from "./protocol.ts";
import { NO_PREVIEWS, type SlidePreviews } from "./slide-previews.ts";

/** `events` folded through `reduce`, starting from `initial`. */
export function replay<State, Event>(
  reduce: (state: State, event: Event) => State,
  initial: State,
  events: readonly Event[],
): State {
  return events.reduce(reduce, initial);
}

/** The slides window's tree for `state`, with actions that do nothing. */
export function pickerMarkupOf(state: PickerState): string {
  // Without the shell's <style>: its rules name every class (`.sasha-mark-converter`), so a test
  // asking whether the VIEW drew one would otherwise always find it. It used to be dropped by the
  // renderer itself, which leaves a <style> with several children empty on the server.
  return renderToStaticMarkup(createElement(Picker, { state, actions: INERT_PICKER_ACTIONS })).replace(
    /<style>[^<]*<\/style>/,
    "",
  );
}

/** Ask Sasha's tree for `conversation`, with no hosted connector and actions that do nothing. */
export function conversationMarkupOf(conversation: Conversation, previews: SlidePreviews = NO_PREVIEWS): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, {
      conversation,
      previews,
      commentAccess: null,
      setup: UNCONFIGURED_SETUP,
      actions: INERT_CONVERSATION_ACTIONS,
    }),
  );
}

/** A synchronous converter, for the reducer tests. Never wired into a surface. */
export type SyncSlideConverter = (
  spec: Readonly<{ html: string; presentationId: string; pageObjectId: string }>,
) => ConversionResult;

/**
 * TEST FIXTURE. It produces ONE full-slide text box plus one unsupported entry, which is what lets
 * the reducer tests assert "a converter loss becomes an anomaly the user can comment on" and "the
 * converted view draws one box per request" without staging an iframe. The real converter is async
 * and needs a DOM, so it cannot stand in here.
 */
export function stubConvertHtmlToSlideRequests(): SyncSlideConverter {
  return ({ html, pageObjectId }) => {
    const textBoxId = `${pageObjectId}_stub`;
    return {
      requests: [
        {
          createShape: {
            objectId: textBoxId,
            shapeType: "TEXT_BOX",
            elementProperties: {
              pageObjectId,
              size: { width: { magnitude: 1280, unit: "PT" }, height: { magnitude: 720, unit: "PT" } },
              transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "PT" },
            },
          },
        },
        {
          insertText: {
            objectId: textBoxId,
            text: `sasha-slides: converter not wired yet (${html.length} bytes of HTML)`,
          },
        },
      ],
      unsupported: [
        {
          feature: "stub-converter",
          note: "a test fixture stood in for mcp/sasha-slides/converter/; nothing was really converted.",
          region: WHOLE_SLIDE,
        },
      ],
    };
  };
}
