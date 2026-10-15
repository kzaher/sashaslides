// Acceptance 10 and 11 (SPEC.md 21.9): the editor honours the deck role, the connection and the
// server's notices. The role table runs the same two actions -- a document edit and a comment --
// for every role, and the rows differ only in the role; the connection rows differ only in the
// connection. Agent edits and their revert run through the real editor system over a fake session.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCAL_COLLABORATION_STATUS,
  mintId,
  type CollaborationStatus,
  type DeckRole,
  type DocumentSnapshot,
  type EditorEvent,
  type EditorState,
  type TransitionScriptRecord,
} from "../../contracts/index.ts";
import { editorStateFor, personId, shape, slide, slideId, testDocument } from "../testing/document-fixtures.ts";
import { flushPromises, createEditorHarness } from "../testing/editor-harness.ts";
import { createFakeCollaborationSession } from "../testing/fake-collaboration.ts";
import { CLOSED_MESSAGE } from "./access.ts";
import { reduceEditor } from "./reduce-editor.ts";

const box = shape({ id: "shape_box", x: 100, y: 100, width: 200, height: 100 });
const document = testDocument({ slides: [slide({ id: "slide_one", elements: [box] })] });
const SLIDE = slideId("slide_one");
const FIXTURE_SEED = { sessionPrefix: "Collab00", counter: 0 };
const THREAD = mintId({ seed: FIXTURE_SEED, kind: "thread" }).id;
const SCRIPT = mintId({ seed: FIXTURE_SEED, kind: "transitionScript" }).id;

function stateAs(collaboration: CollaborationStatus): EditorState {
  return { ...editorStateFor(document), collaboration, selection: { kind: "elements", slideId: SLIDE, elementIds: [box.id] } };
}

function withRole(role: DeckRole): CollaborationStatus {
  return { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "online" }, role };
}

const EDIT: EditorEvent = { kind: "elementPatchRequested", patch: { opacity: 0.5 } };
const COMMENT: EditorEvent = { kind: "threadReplied", threadId: THREAD, body: "Looks good", mentions: [] };

describe("roles decide what the editor queues", () => {
  const rows: readonly Readonly<{ role: DeckRole; edits: boolean; comments: boolean; notice: string | null }>[] = [
    { role: "viewer", edits: false, comments: false, notice: "You can view this deck, but not edit it." },
    { role: "commenter", edits: false, comments: true, notice: "You can comment on this deck, but not edit it." },
    { role: "editor", edits: true, comments: true, notice: null },
    { role: "owner", edits: true, comments: true, notice: null },
  ];
  for (const row of rows) {
    it(`${row.role}: a document edit is ${row.edits ? "queued" : "refused"}`, () => {
      const next = reduceEditor(stateAs(withRole(row.role)), EDIT);
      assert.equal(next.pendingEdits.length, row.edits ? 1 : 0);
      assert.deepEqual(next.notices.map((notice) => notice.message), row.notice === null ? [] : [row.notice]);
    });
    it(`${row.role}: a comment is ${row.comments ? "queued" : "refused"}`, () => {
      const next = reduceEditor(stateAs(withRole(row.role)), COMMENT);
      assert.equal(next.pendingDiscussion.length, row.comments ? 1 : 0);
      assert.deepEqual(next.notices.map((notice) => notice.message), row.comments ? [] : ["You can view this deck, but not comment on it."]);
    });
  }

  it("a refusal already showing is not repeated by the next keystroke", () => {
    const once = reduceEditor(stateAs(withRole("viewer")), EDIT);
    const twice = reduceEditor(once, EDIT);
    assert.equal(twice.notices.length, 1);
  });

  it("a viewer's drag on an element previews nothing and says why", () => {
    const sample = (x: number) => ({ slidePoint: { x, y: 150 }, clientPoint: { x, y: 150 } });
    const modifiers = { shift: false, alt: false, primary: false };
    const pressed = reduceEditor(stateAs(withRole("viewer")), { kind: "canvasPointerDown", sample: sample(150), target: { kind: "element", elementPath: [box.id] }, modifiers, button: "primary", clickCount: 1 });
    const dragged = reduceEditor(pressed, { kind: "canvasPointerMove", sample: sample(200), modifiers });
    assert.equal(dragged.gesture.kind, "idle");
    assert.deepEqual(dragged.notices.map((notice) => notice.message), ["You can view this deck, but not edit it."]);
  });
});

describe("the connection decides what the editor queues", () => {
  const rows: readonly Readonly<{ name: string; connection: CollaborationStatus["connection"]; edits: boolean; notice: string | null }>[] = [
    { name: "online: edits are queued", connection: { kind: "online" }, edits: true, notice: null },
    { name: "offline: edits are still queued (the replica keeps them)", connection: { kind: "offline", reason: "networkLost", attempt: 2, retryInMilliseconds: 8000 }, edits: true, notice: null },
    { name: "closed, access revoked: read-only with the reason", connection: { kind: "closed", reason: "accessRevoked" }, edits: false, notice: CLOSED_MESSAGE.accessRevoked },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const next = reduceEditor(stateAs({ ...withRole("editor"), connection: row.connection }), EDIT);
      assert.equal(next.pendingEdits.length, row.edits ? 1 : 0);
      assert.deepEqual(next.notices.map((notice) => notice.message), row.notice === null ? [] : [row.notice]);
    });
  }

  it("Try now: reconnectRequested calls the session's reconnectNow once", () => {
    const offline: CollaborationStatus = { ...withRole("editor"), connection: { kind: "offline", reason: "networkLost", attempt: 2, retryInMilliseconds: 8000 } };
    const session = createFakeCollaborationSession({ initial: offline, revertOutcome: { kind: "nothingToRevert", skippedSteps: 0 } });
    using harness = createEditorHarness({ document, collaboration: session });
    assert.equal(harness.state().collaboration.connection.kind, "offline");
    harness.dispatch({ kind: "reconnectRequested" });
    assert.equal(session.reconnectCalls(), 1);
    assert.equal(harness.state().collaboration.connection.kind, "connecting");
  });

  it("control: Try now while online calls nothing", () => {
    const session = createFakeCollaborationSession({ initial: withRole("editor"), revertOutcome: { kind: "nothingToRevert", skippedSteps: 0 } });
    using harness = createEditorHarness({ document, collaboration: session });
    harness.dispatch({ kind: "reconnectRequested" });
    assert.equal(session.reconnectCalls(), 0);
  });

  it("a status from the session reaches the state, and a role change is announced", () => {
    const session = createFakeCollaborationSession({ initial: withRole("editor"), revertOutcome: { kind: "nothingToRevert", skippedSteps: 0 } });
    using harness = createEditorHarness({ document, collaboration: session });
    session.emitStatus(withRole("commenter"));
    assert.equal(harness.state().collaboration.role, "commenter");
    assert.deepEqual(harness.state().notices.map((notice) => notice.message), ["You can comment on this deck now, but not edit it."]);
  });
});

describe("Claude's edits", () => {
  it("Undo Claude's edit: the revert runs once and its result becomes a notice", async () => {
    const session = createFakeCollaborationSession({ initial: withRole("editor"), revertOutcome: { kind: "reverted", stepsReverted: 3, skippedSteps: 1 } });
    using harness = createEditorHarness({ document, collaboration: session });
    session.emitNotice({ kind: "agentEdit", agentSessionId: "agent_session_1", agentName: "Claude", summary: "rewrote the title" });
    const offered = harness.state().notices.find((notice) => notice.action?.kind === "undoAgentEdits");
    assert.ok(offered !== undefined);
    assert.equal(offered.message, "Claude edited the deck: rewrote the title");
    harness.dispatch({ kind: "noticeActionChosen", noticeId: offered.id });
    assert.deepEqual(harness.state().pendingAgentReverts, ["agent_session_1"]);
    await flushPromises();
    assert.deepEqual(session.revertCalls(), ["agent_session_1"]);
    assert.deepEqual(harness.state().pendingAgentReverts, []);
    assert.deepEqual(harness.state().notices.map((notice) => notice.message), ["Claude's edit was undone (3 steps); 1 step stayed because a collaborator changed it since."]);
  });

  it("the reducer alone: undoAgentEdits queues the session, agentRevertSettled removes it with a notice", () => {
    const offered = reduceEditor(stateAs(withRole("editor")), { kind: "agentEditObserved", agentSessionId: "agent_session_2", agentName: "Claude", summary: "added a slide" });
    const noticeId = offered.notices[0]?.id;
    assert.ok(noticeId !== undefined);
    const requested = reduceEditor(offered, { kind: "noticeActionChosen", noticeId });
    assert.deepEqual(requested.pendingAgentReverts, ["agent_session_2"]);
    const settled = reduceEditor(requested, { kind: "agentRevertSettled", agentSessionId: "agent_session_2", outcome: { kind: "nothingToRevert", skippedSteps: 2 } });
    assert.deepEqual(settled.pendingAgentReverts, []);
    assert.deepEqual(settled.notices.map((notice) => notice.message), ["Nothing was undone: collaborators changed everything Claude's edit touched since."]);
  });

  it("control: a commenter cannot queue a revert", () => {
    const offered = reduceEditor(stateAs(withRole("commenter")), { kind: "agentEditObserved", agentSessionId: "agent_session_3", agentName: "Claude", summary: "added a slide" });
    const noticeId = offered.notices[0]?.id;
    assert.ok(noticeId !== undefined);
    const requested = reduceEditor(offered, { kind: "noticeActionChosen", noticeId });
    assert.deepEqual(requested.pendingAgentReverts, []);
  });

  it("a correction from the server says the approval was removed, and why", () => {
    const corrected = reduceEditor(stateAs(withRole("editor")), {
      kind: "collaborationNoticeReceived",
      notice: { kind: "correction", correction: { kind: "approvalRevoked", scriptId: SCRIPT, reason: "fingerprintMismatch" } },
    });
    assert.deepEqual(corrected.notices.map((notice) => notice.message), ["Your approval was removed: the script changed after it was approved; approve the new text."]);
  });

  const agentScript: TransitionScriptRecord = {
    id: SCRIPT,
    name: "Ink wipe",
    description: "",
    author: { kind: "agent", name: "Claude", agentSessionId: "agent_session_4" },
    script: "sashaTransition.define({})",
    stylesheet: "",
    markup: "",
    defaultParameters: {},
    approval: { kind: "unapproved" },
    updatedAt: 1,
  };
  const scriptRows: readonly Readonly<{ name: string; before: readonly TransitionScriptRecord[]; after: readonly TransitionScriptRecord[]; announced: boolean }>[] = [
    { name: "a new unapproved agent script is announced for review", before: [], after: [agentScript], announced: true },
    { name: "an agent rewrite of an approved script is announced again", before: [{ ...agentScript, approval: { kind: "approved", approvedBy: personId("person_me"), fingerprint: "f" } }], after: [{ ...agentScript, script: "sashaTransition.define({ v: 2 })" }], announced: true },
    { name: "control: the same unapproved script again is not", before: [agentScript], after: [{ ...agentScript, updatedAt: 2 }], announced: false },
    { name: "control: a person's unapproved script is not", before: [], after: [{ ...agentScript, author: { kind: "person", personId: personId("person_me") } }], announced: false },
  ];
  for (const row of scriptRows) {
    it(row.name, () => {
      const before: DocumentSnapshot = { ...document, transitionScripts: row.before };
      const after: DocumentSnapshot = { ...document, revision: 2, transitionScripts: row.after };
      const changed = reduceEditor(editorStateFor(before), {
        kind: "documentChanged",
        change: { snapshot: after, origin: { kind: "remote" }, changedSlideIds: [], deckLevelChanged: true, textChanges: new Map(), history: { canUndo: false, canRedo: false } },
      });
      const notice = changed.notices.find((candidate) => candidate.message === "Claude wrote a transition: review it");
      assert.equal(notice !== undefined, row.announced);
      if (notice !== undefined) assert.deepEqual(notice.action, { kind: "reviewTransitionScript", scriptId: agentScript.id });
    });
  }
});

describe("a comment the server did not take says so", () => {
  const queued = (): EditorState => reduceEditor(stateAs(withRole("commenter")), COMMENT);

  it("limitReached: the notice carries the server's sentence", () => {
    const state = queued();
    const request = state.pendingDiscussion[0];
    assert.ok(request !== undefined);
    const message = "a thread holds at most 500 messages";
    const next = reduceEditor(state, { kind: "discussionSettled", outcome: { kind: "rejected", requestId: request.requestId, reason: "limitReached", message } });
    assert.deepEqual(next.notices.map((notice) => notice.message), [`The comment was not saved: ${message}`]);
    assert.equal(next.pendingDiscussion.length, 0);
  });

  it("rateLimited: the notice offers to send it again, and choosing that queues the same comment", () => {
    const state = queued();
    const request = state.pendingDiscussion[0];
    assert.ok(request !== undefined);
    const next = reduceEditor(state, { kind: "discussionSettled", outcome: { kind: "rejected", requestId: request.requestId, reason: "rateLimited", message: "too many messages at once" } });
    const notice = next.notices[0];
    assert.ok(notice !== undefined);
    assert.equal(notice.message, "The comment was not sent: the server is busy. Send it again in a moment.");
    assert.deepEqual(notice.action, { kind: "retryDiscussion", command: request.command });
    assert.equal(next.pendingDiscussion.length, 0, "nothing retries by itself");
    const retried = reduceEditor(next, { kind: "noticeActionChosen", noticeId: notice.id });
    assert.deepEqual(retried.pendingDiscussion.map((pending) => pending.command), [request.command]);
    assert.equal(retried.notices.length, 0);
  });
});
