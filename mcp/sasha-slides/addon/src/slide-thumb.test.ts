// THE THUMBNAILS ON SCREEN: in the candidates card, and at the foot of every comment about a
// candidate. Rendered with react-dom/server, so every arm is asserted without a browser.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProposalMark } from "./bridge.ts";
import { ConversationPanel } from "./Conversation.tsx";
import {
  INITIAL_CONVERSATION,
  reduceConversation,
  type Conversation,
  type ConversationEvent,
} from "./conversation-state.ts";
import { INERT_CONVERSATION_ACTIONS } from "./inert-actions.ts";
import type { Manifest } from "./protocol.ts";
import {
  sessionEventsOf,
  type SessionEventFile,
  type SlideCommentsLoad,
} from "./session-log.ts";
import { NO_PREVIEWS, nextPreviewToLoad, reducePreviews, type SlidePreviews } from "./slide-previews.ts";
import { SlideThumb } from "./slide-thumb.tsx";

const AT = "2026-10-04T12:00:00.000Z";
const PROPOSAL = "p_1733219000000_a1b2c3";

const manifest: Manifest = {
  protocolVersion: 1,
  proposalId: PROPOSAL,
  createdAt: AT,
  presentationId: "deck_0123456789",
  count: 2,
  slides: [
    { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
    { index: 2, fileId: "html_2", name: "02.html", label: "option 2" },
  ],
  revision: 1,
};

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
};

// --- SlideThumb ----------------------------------------------------------------

test("a ready thumbnail is the candidate's own HTML in the strict sandbox, never a screenshot", () => {
  const markup = renderToStaticMarkup(
    createElement(SlideThumb, { preview: { kind: "ready", html: "<p>hello</p>" }, title: "candidate 1" }),
  );
  assert.match(markup, /class="sasha-stage sasha-thumb"/);
  assert.match(markup, /<iframe[^>]*sandbox=""/);
  assert.match(markup, /srcDoc="&lt;p&gt;hello&lt;\/p&gt;"|srcdoc="&lt;p&gt;hello&lt;\/p&gt;"/i);
});

test("a loading thumbnail is an empty box of the same size, so the row does not jump", () => {
  const markup = renderToStaticMarkup(createElement(SlideThumb, { preview: { kind: "loading" }, title: "candidate 1" }));
  assert.match(markup, /class="sasha-stage sasha-thumb sasha-thumb-wait"/);
  assert.doesNotMatch(markup, /<iframe/);
});

test("an unavailable thumbnail says why on hover, rather than spinning for ever", () => {
  const markup = renderToStaticMarkup(
    createElement(SlideThumb, { preview: { kind: "unavailable", message: "Drive HTTP 500" }, title: "candidate 1" }),
  );
  assert.match(markup, /title="no preview: Drive HTTP 500"/);
  assert.doesNotMatch(markup, /<iframe/);
});

// --- in the panel --------------------------------------------------------------

test("every candidate in the set card carries its thumbnail", () => {
  const conversation = withComments();
  const markup = markupOf({ conversation, previews: loadedPreviews(conversation) });
  const stack = markup.slice(markup.indexOf('class="sasha-stack"'), markup.indexOf("Open artifacts"));
  assert.equal((stack.match(/class="sasha-stage sasha-thumb"/g) ?? []).length, 2, "one per candidate");
  assert.match(stack, /srcDoc="&lt;p&gt;slide 1&lt;\/p&gt;"|srcdoc="&lt;p&gt;slide 1&lt;\/p&gt;"/i);
});

test("an open comment ends with the thumbnail and the number of the candidate it is about", () => {
  const conversation = withComments();
  const markup = markupOf({ conversation, previews: loadedPreviews(conversation) });
  const foot = markup.slice(markup.indexOf('class="sasha-c-context"'));
  assert.match(foot, /class="sasha-c-thumb"/, "the thumbnail opens the slide too");
  assert.match(foot, /srcDoc="&lt;p&gt;slide 2&lt;\/p&gt;"|srcdoc="&lt;p&gt;slide 2&lt;\/p&gt;"/i);
  assert.match(foot, /Candidate 2 · option 2/);
});

// --- helpers --------------------------------------------------------------------

function markupOf({ conversation, previews }: { conversation: Conversation; previews: SlidePreviews }): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, { conversation, previews, actions: INERT_CONVERSATION_ACTIONS }),
  );
}

function replay(events: readonly ConversationEvent[]): Conversation {
  let conversation = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [], readAt: AT });
  for (const event of events) conversation = reduceConversation(conversation, event);
  return conversation;
}

function withComments(): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([commentOpened(2)]), readAt: AT },
    { kind: "comments-arrived", comments: openOnSlideTwo() },
  ]);
}

function loadedPreviews(conversation: Conversation): SlidePreviews {
  let previews = NO_PREVIEWS;
  for (let guard = 0; guard < 10; guard += 1) {
    const next = nextPreviewToLoad({ conversation, previews });
    if (next === null) return previews;
    previews = reducePreviews(previews, { kind: "preview-requested", key: next.key });
    previews = reducePreviews(previews, {
      kind: "preview-arrived",
      key: next.key,
      html: `<p>slide ${next.slideIndex}</p>`,
    });
  }
  return previews;
}

function openOnSlideTwo(): SlideCommentsLoad {
  return {
    kind: "loaded",
    readAt: AT,
    slides: [
      {
        proposalId: PROPOSAL,
        slideIndex: 2,
        threads: {
          kind: "read",
          threads: [
            {
              commentId: "cc_open",
              text: "the gridlines are gone",
              author: "Ante M",
              at: "2026-10-04T12:06:00.000Z",
              resolved: false,
              region: null,
              replies: [],
            },
          ],
        },
      },
    ],
  };
}

function eventsOf(files: readonly Readonly<{ name: string; text: string }>[]) {
  return sessionEventsOf({
    files: files.map(
      (file): SessionEventFile => ({ proposalId: PROPOSAL, fileId: `drive_${file.name}`, name: file.name, text: file.text }),
    ),
  });
}

function commentOpened(slideIndex: number): Readonly<{ name: string; text: string }> {
  return {
    name: "1791115560000-bbbbbb-comment-opened.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:06:00.000Z",
      kind: "comment-opened",
      commentId: "cc_open",
      slideIndex,
      text: "the gridlines are gone",
      region: null,
    }),
  };
}
