/**
 * Claude's deck tools end to end over MCP, against the REAL engine model (fake-deck-service.ts):
 * acceptance 2 to 11 of the assistant deck tools module.
 *
 *   cd mcp/sasha-slides && npx tsx --test deck-tools/model-tests/*.test.ts
 *   npx tsc -p mcp/sasha-slides/deck-tools/model-tests      (the model needs the DOM library)
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AnimationStep } from "../../engine/src/contracts/animations.ts";
import type { AssistantEditOutcome, AssistantThread, DeckOutline } from "../../engine/src/contracts/assistant-deck-tools.ts";
import type { DeckCaller } from "../../deck-contracts/deck-service-contract.ts";
import type { DiscussionSnapshot } from "../../engine/src/contracts/discussion.ts";
import type { DocumentSnapshot, ElementSnapshot, ShapeElement, SlideSnapshot, TextBody } from "../../engine/src/contracts/document.ts";
import { parseDeckId, parseElementId, parseSlideId, type DeckId, type ElementId, type MessageId, type SlideId, type ThreadId } from "../../engine/src/contracts/ids.ts";
import { PARAGRAPH_ATTRIBUTE_NAMES } from "../../engine/src/contracts/yjs-schema.ts";
import { connectAssistant, TEST_PUBLIC_URL, type AssistantConnection } from "../assistant-harness.ts";
import type { CreatedIds } from "../edit-expansion.ts";
import { createFakeDeckService, fakeCaller, type FakeDeckService } from "./fake-deck-service.ts";

const OWNER = fakeCaller({ accountId: "account-owner", displayName: "Ada", colourIndex: 1 });
const COLLEAGUE = fakeCaller({ accountId: "account-colleague", displayName: "Grace", colourIndex: 2 });
const COMMENTER = fakeCaller({ accountId: "account-commenter", displayName: "Barbara", colourIndex: 3 });
const VIEWER = fakeCaller({ accountId: "account-viewer", displayName: "Edsger", colourIndex: 4 });

let service: FakeDeckService;
const connections: AssistantConnection[] = [];

beforeEach(() => {
  service = createFakeDeckService({ now: Date.now });
});

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  assert.equal(service.openLeases(), 0, "every tool call released its deck lease");
});

async function connect(options: Readonly<{ sessionId: string; caller: DeckCaller; fetch?: typeof fetch }>): Promise<AssistantConnection> {
  const connection = await connectAssistant({ service, sessionId: options.sessionId, caller: options.caller, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  connections.push(connection);
  return connection;
}

async function createDeck(connection: AssistantConnection): Promise<Readonly<{ deckId: DeckId; address: string }>> {
  const created = (await connection.read("deck_create", { title: "Launch plan" })) as Readonly<{ deckId: string; address: string }>;
  return { deckId: deckId(created.deckId), address: created.address };
}

describe("deck_create and deck_read (acceptance 2)", () => {
  test("a new deck has one slide whose title placeholder is empty, at the public address", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const created = await createDeck(assistant);
    assert.equal(created.address, `${TEST_PUBLIC_URL}/deck/${created.deckId}`);
    const outline = (await assistant.read("deck_read", { deckId: created.deckId, detail: "outline" })) as DeckOutline;
    assert.equal(outline.address, `${TEST_PUBLIC_URL}/deck/${created.deckId}`);
    assert.equal(outline.title, "Launch plan");
    assert.equal(outline.role, "owner");
    assert.equal(outline.slides.length, 1);
    const title = outline.slides[0]?.elements.find((element) => element.placeholder === "centredTitle" || element.placeholder === "title");
    assert.ok(title !== undefined, "the slide has a title placeholder");
    assert.equal(title.text, "");
    assert.deepEqual(outline.fullSlides, [], "an outline carries no full slide values");
    const listed = (await assistant.read("deck_list", {})) as Readonly<{ decks: readonly Readonly<{ deckId: string; address: string; role: string }>[] }>;
    assert.deepEqual(listed.decks.map((deck) => [deck.deckId, deck.address, deck.role]), [[created.deckId, created.address, "owner"]]);
  });

  test("detail full returns the complete values of the slides asked for", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const outline = (await assistant.read("deck_read", { deckId, detail: "full" })) as DeckOutline;
    assert.equal(outline.fullSlides.length, 1);
    assert.equal(outline.fullSlides[0]?.id, outline.slides[0]?.slideId);
  });
});

describe("deck_edit: one envelope, one undo step, attributed to the agent session (acceptance 3)", () => {
  const pricingEdits = [
    { kind: "addSlide", id: "sl_pricing01", placeholderText: { title: ["Pricing"] } },
    { kind: "addShape", id: "el_proCard01", slideId: "sl_pricing01", preset: "roundedRectangle", frame: { x: 100, y: 200, width: 320, height: 200 }, text: ["Pro plan: 20 a month"] },
    { kind: "styleText", slideId: "sl_pricing01", elementId: "el_proCard01", find: "Pro", run: { fontWeight: 700 } },
  ];

  test("adds the slide, the shape and the bold word, returning the ids per edit", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const store = service.store(deckId);
    const before = store.snapshot();
    const envelopesBefore = service.envelopes(deckId).length;
    const outcome = (await assistant.read("deck_edit", { deckId, summary: "added a pricing slide", edits: pricingEdits })) as AssistantEditOutcome;
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    if (outcome.kind !== "applied") return;
    const after = store.snapshot();
    const pricing = slideById(after, "sl_pricing01");
    assert.deepEqual(outcome.created, [
      { editIndex: 0, slideId: "sl_pricing01", elementIds: pricing.elements.filter((element) => element.placeholder !== null).map((element) => element.id), animationStepIds: [] },
      { editIndex: 1, slideId: null, elementIds: ["el_proCard01"], animationStepIds: [] },
    ]);
    assert.deepEqual(after.slides.map((slide) => slide.id), [...before.slides.map((slide) => slide.id), "sl_pricing01"], "added at the end");
    const title = pricing.elements.find((element) => element.placeholder?.role === "title");
    assert.equal(plain(shapeOf(title).text), "Pricing");
    const card = shapeOf(pricing.elements.find((element) => element.id === "el_proCard01"));
    assert.equal(card.preset, "roundedRectangle");
    assert.deepEqual(card.text.paragraphs[0]?.runs, [
      { kind: "text", text: "Pro", style: { fontWeight: 700 } },
      { kind: "text", text: " plan: 20 a month", style: {} },
    ]);
    assert.equal(card.box.fill.kind, "solid", "a drawn shape takes the theme's accent fill");

    const recorded = service.envelopes(deckId).slice(envelopesBefore);
    assert.equal(recorded.length, 1, "one envelope for the whole call");
    assert.equal(recorded[0]?.envelope.author.kind, "agent");
    assert.deepEqual(service.agentNotices(deckId).at(-1), { agentSessionId: agentSessionOf("session-A"), agentName: "Claude", summary: "added a pricing slide" });

    const undone = store.undo();
    assert.equal(undone.kind, "applied");
    assert.deepEqual(store.snapshot().slides, before.slides, "ONE undo takes the whole call back");
  });

  // Parametric over the MCP session: the agent session follows it, and only it.
  for (const row of [
    { name: "two calls in the same session", sessions: ["session-A", "session-A"], sameAgentSession: true },
    { name: "two calls in different sessions", sessions: ["session-A", "session-B"], sameAgentSession: false },
  ] as const) {
    test(`${row.name} -> ${row.sameAgentSession ? "the same" : "different"} agent session ids`, async () => {
      const first = await connect({ sessionId: row.sessions[0], caller: OWNER });
      const { deckId } = await createDeck(first);
      const second = row.sessions[1] === row.sessions[0] ? first : await connect({ sessionId: row.sessions[1], caller: OWNER });
      const ids: string[] = [];
      for (const [index, connection] of [first, second].entries()) {
        const outcome = (await connection.read("deck_edit", { deckId, summary: "retitled", edits: [{ kind: "setTitle", title: `Title ${String(index)}` }] })) as AssistantEditOutcome;
        assert.equal(outcome.kind, "applied");
        if (outcome.kind !== "applied") return;
        assert.equal(outcome.agentSessionId, agentSessionOf(row.sessions[index] ?? ""), "as_ + SHA-256 of the MCP session id");
        const author = service.envelopes(deckId).at(-1)?.envelope.author;
        assert.deepEqual(author, { kind: "agent", name: "Claude", agentSessionId: outcome.agentSessionId });
        ids.push(outcome.agentSessionId);
      }
      assert.equal(ids[0] === ids[1], row.sameAgentSession);
    });
  }

  test("ids not chosen by the model are minted, reported, and exist in the deck", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const firstSlide = service.store(deckId).snapshot().slides[0]?.id ?? "";
    const outcome = (await assistant.read("deck_edit", { deckId, summary: "added a note", edits: [{ kind: "addShape", slideId: firstSlide, text: ["Draft"] }] })) as AssistantEditOutcome;
    assert.equal(outcome.kind, "applied");
    if (outcome.kind !== "applied") return;
    const minted = outcome.created[0]?.elementIds[0] ?? "";
    assert.match(minted, /^el_/u);
    const shape = shapeOf(slideById(service.store(deckId).snapshot(), firstSlide).elements.find((element) => element.id === minted));
    assert.equal(shape.preset, "textBox");
    assert.equal(shape.textBox.autofit, "resizeShape", "a new text box grows with its text, as in the editor");
  });
});

describe("deck_edit is all or nothing (acceptance 4)", () => {
  // The second edit names a missing element in two ways: one the expansion finds while computing,
  // one only the model's validation finds. Both must name edit 1 and write nothing.
  for (const row of [
    { name: "found by the model's validation", second: { kind: "deleteElements", elementIds: ["el_missing001"] } },
    { name: "found while expanding", second: { kind: "restyleElements", elementIds: ["el_missing001"], patch: { opacity: 0.5 } } },
  ] as const) {
    test(`${row.name}: rejected at edit 1 with the model's reason, the deck unchanged`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId } = await createDeck(assistant);
      const before = service.store(deckId).snapshot();
      const slideId = before.slides[0]?.id ?? "";
      const answer = await assistant.call("deck_edit", {
        deckId,
        summary: "two edits",
        edits: [
          { kind: "addShape", slideId, text: ["valid on its own"] },
          { ...row.second, slideId },
        ],
      });
      assert.equal(answer.isError, true);
      const outcome = JSON.parse(answer.text) as AssistantEditOutcome;
      assert.equal(outcome.kind, "rejected");
      if (outcome.kind !== "rejected") return;
      assert.equal(outcome.editIndex, 1);
      assert.match(outcome.reason, /^elementMissing: .*el_missing001/u);
      assert.deepEqual(service.store(deckId).snapshot(), before, "nothing was written");
    });
  }
});

describe("restyleElements merges per element (acceptance 5)", () => {
  const RED = { kind: "literal", hexadecimal: "#ff0000", alpha: 1 } as const;
  const BLUE = { kind: "literal", hexadecimal: "#0000ff", alpha: 1 } as const;
  for (const row of [
    { name: "a red and a blue shape", colours: [RED, BLUE] },
    { name: "control: a single red shape", colours: [RED] },
  ] as const) {
    test(`${row.name}: border width 4 keeps each element's own colour, in one envelope`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId } = await createDeck(assistant);
      const slideId = service.store(deckId).snapshot().slides[0]?.id ?? "";
      const ids = row.colours.map((_, index) => `el_bordered${String(index).padStart(2, "0")}`);
      const added = (await assistant.read("deck_edit", {
        deckId,
        summary: "added cards",
        edits: row.colours.map((colour, index) => ({ kind: "addShape", id: ids[index], slideId, preset: "rectangle", style: { border: { kind: "uniform", stroke: { width: 1, colour, dash: "dot" } } } })),
      })) as AssistantEditOutcome;
      assert.equal(added.kind, "applied", JSON.stringify(added));
      const envelopesBefore = service.envelopes(deckId).length;
      const restyled = (await assistant.read("deck_edit", { deckId, summary: "thicker borders", edits: [{ kind: "restyleElements", slideId, elementIds: ids, patch: { border: { stroke: { width: 4 } } } }] })) as AssistantEditOutcome;
      assert.equal(restyled.kind, "applied", JSON.stringify(restyled));
      assert.equal(service.envelopes(deckId).length - envelopesBefore, 1, "one envelope");
      const slide = slideById(service.store(deckId).snapshot(), slideId);
      const borders = ids.map((id) => shapeOf(slide.elements.find((element) => element.id === id)).box.border);
      assert.deepEqual(
        borders,
        row.colours.map((colour) => ({ kind: "uniform", stroke: { width: 4, colour, dash: "dot" } })),
      );
    });
  }
});

describe("text edits follow the yjs-schema text rules (acceptance 6)", () => {
  test("setText on a placeholder writes exactly the paragraphs: no paragraph attribute in runs, none left over", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const added = (await assistant.read("deck_edit", { deckId, summary: "a slide", edits: [{ kind: "addSlide", id: "sl_text0001", placeholderText: { title: [{ text: "Old", style: { alignment: "end", lineSpacing: 2 } }] } }] })) as AssistantEditOutcome;
    assert.equal(added.kind, "applied", JSON.stringify(added));
    const titleId = placeholderId(service.store(deckId).snapshot(), "sl_text0001", "title");
    const outcome = (await assistant.read("deck_edit", {
      deckId,
      summary: "retitled",
      edits: [
        {
          kind: "setText",
          slideId: "sl_text0001",
          elementId: titleId,
          paragraphs: [
            { text: "Alpha", style: {} },
            { text: "Beta", style: { alignment: "centre" }, runs: [{ start: 0, end: 2, style: { fontStyle: "italic" } }] },
          ],
        },
        // Same body, same call: the bold must land on the text the setText above wrote.
        { kind: "styleText", slideId: "sl_text0001", elementId: titleId, find: "ta", run: { fontWeight: 700 } },
      ],
    })) as AssistantEditOutcome;
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    const title = shapeOf(slideById(service.store(deckId).snapshot(), "sl_text0001").elements.find((element) => element.id === titleId));
    assert.deepEqual(title.text, {
      paragraphs: [
        { style: {}, runs: [{ kind: "text", text: "Alpha", style: {} }] },
        {
          style: { alignment: "centre" },
          runs: [
            { kind: "text", text: "Be", style: { fontStyle: "italic" } },
            { kind: "text", text: "ta", style: { fontWeight: 700 } },
          ],
        },
      ],
    });
    for (const paragraph of title.text.paragraphs) {
      for (const run of paragraph.runs) {
        for (const name of PARAGRAPH_ATTRIBUTE_NAMES) assert.ok(!(name in run.style), `no paragraph attribute ${name} in a run`);
      }
    }
  });

  test("replaceText with all replaces every occurrence and keeps each found text's run style", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = service.store(deckId).snapshot().slides[0]?.id ?? "";
    const text = "Basic and Basic plus";
    await assistant.read("deck_edit", {
      deckId,
      summary: "plans",
      edits: [{ kind: "addShape", id: "el_plans0001", slideId, text: [{ text, runs: [{ start: 0, end: 5, style: { fontWeight: 700 } }, { start: 10, end: 15, style: { fontStyle: "italic" } }] }] }],
    });
    const outcome = (await assistant.read("deck_edit", { deckId, summary: "renamed", edits: [{ kind: "replaceText", slideId, elementId: "el_plans0001", find: "Basic", replaceWith: "Starter", all: true }] })) as AssistantEditOutcome;
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    const shape = shapeOf(slideById(service.store(deckId).snapshot(), slideId).elements.find((element) => element.id === "el_plans0001"));
    assert.deepEqual(shape.text.paragraphs[0]?.runs, [
      { kind: "text", text: "Starter", style: { fontWeight: 700 } },
      { kind: "text", text: " and ", style: {} },
      { kind: "text", text: "Starter", style: { fontStyle: "italic" } },
      { kind: "text", text: " plus", style: {} },
    ]);
  });

  test("styleText of text that is not there is rejected with a reason naming the text", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = service.store(deckId).snapshot().slides[0]?.id ?? "";
    await assistant.read("deck_edit", { deckId, summary: "plans", edits: [{ kind: "addShape", id: "el_plans0001", slideId, text: ["Pro and Team"] }] });
    const answer = await assistant.call("deck_edit", { deckId, summary: "bold", edits: [{ kind: "styleText", slideId, elementId: "el_plans0001", find: "Enterprise", run: { fontWeight: 700 } }] });
    assert.equal(answer.isError, true);
    const outcome = JSON.parse(answer.text) as AssistantEditOutcome;
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") return;
    assert.equal(outcome.editIndex, 0);
    assert.match(outcome.reason, /"Enterprise"/u);
  });
});

describe("addImage (acceptance 7)", () => {
  const PNG = pngHeader({ width: 4, height: 3 });
  const LIMIT = 25 * 1024 * 1024;
  for (const row of [
    { name: "http is refused", source: "http://images.example/logo.png", body: PNG, declared: "image/png", expected: { kind: "rejected", reason: /https only/u } },
    { name: "25 megabytes and one byte is refused", source: "https://images.example/huge.png", body: withPngHeader(LIMIT + 1), declared: "image/png", expected: { kind: "rejected", reason: /larger than 25 megabytes/u } },
    { name: "control: exactly 25 megabytes is stored", source: "https://images.example/large.png", body: withPngHeader(LIMIT), declared: "image/png", expected: { kind: "applied", mediaType: "image/png" } },
    { name: "PNG bytes declared as JPEG are stored as PNG", source: "https://images.example/logo.jpg", body: PNG, declared: "image/jpeg", expected: { kind: "applied", mediaType: "image/png" } },
    { name: "a page that is not an image is refused", source: "https://images.example/page", body: new TextEncoder().encode("<html>no</html>"), declared: "image/png", expected: { kind: "rejected", reason: /did not return a PNG/u } },
  ] as const) {
    test(row.name, async () => {
      const requested: string[] = [];
      const fakeFetch: typeof fetch = (input) => {
        requested.push(String(input));
        return Promise.resolve(new Response(new Uint8Array(row.body), { headers: { "content-type": row.declared } }));
      };
      const assistant = await connect({ sessionId: "session-A", caller: OWNER, fetch: fakeFetch });
      const { deckId } = await createDeck(assistant);
      const slideId = service.store(deckId).snapshot().slides[0]?.id ?? "";
      const answer = await assistant.call("deck_edit", { deckId, summary: "added the logo", edits: [{ kind: "addImage", id: "el_logo00001", slideId, source: row.source, description: "Logo" }] });
      const outcome = JSON.parse(answer.text) as AssistantEditOutcome;
      if (row.expected.kind === "rejected") {
        assert.equal(outcome.kind, "rejected");
        if (outcome.kind !== "rejected") return;
        assert.equal(outcome.editIndex, 0);
        assert.match(outcome.reason, row.expected.reason);
        assert.equal(service.store(deckId).snapshot().assets.length, 0);
        if (row.source.startsWith("http:")) assert.deepEqual(requested, [], "nothing is fetched over http");
        return;
      }
      assert.equal(outcome.kind, "applied", answer.text);
      const assetId = createHash("sha256").update(row.body).digest("hex");
      const record = service.store(deckId).snapshot().assets.find((asset) => asset.id === assetId);
      assert.ok(record !== undefined, "the asset is registered in the document");
      assert.equal(record.mediaType, row.expected.mediaType);
      assert.deepEqual([record.pixelWidth, record.pixelHeight], [4, 3]);
      assert.equal(service.storedAsset({ deckId, assetId: record.id })?.mediaType, row.expected.mediaType, "stored through putAsset with the sniffed type");
      const image = slideById(service.store(deckId).snapshot(), slideId).elements.find((element) => element.id === "el_logo00001");
      assert.equal(image?.kind, "image");
      assert.equal(image?.description, "Logo");
    });
  }
});

describe("deck_write_transition (acceptance 8)", () => {
  for (const row of [
    { name: "a script at the limit, by the deck owner's account", bytes: 256 * 1024, accepted: true },
    { name: "a script one byte over the limit", bytes: 256 * 1024 + 1, accepted: false },
  ] as const) {
    test(`${row.name}: ${row.accepted ? "stored unapproved, authored by the agent, assigned" : "rejected, nothing written"}`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId, address } = await createDeck(assistant);
      const before = service.store(deckId).snapshot();
      const slideId = before.slides[0]?.id ?? "";
      const prefix = "sashaTransition.define({});//";
      const answer = await assistant.call("deck_write_transition", {
        deckId,
        name: "Ink wipe",
        script: prefix + "x".repeat(row.bytes - prefix.length),
        assignTo: [{ slideId, durationMilliseconds: 1200 }],
      });
      if (!row.accepted) {
        assert.equal(answer.isError, true);
        assert.match(answer.text, /^tooLarge: the script is 262145 bytes/u);
        assert.deepEqual(service.store(deckId).snapshot(), before);
        return;
      }
      assert.equal(answer.isError, false, answer.text);
      const result = JSON.parse(answer.text) as Readonly<{ scriptId: string; approved: boolean; reviewAddress: string }>;
      assert.equal(result.approved, false);
      assert.equal(result.reviewAddress, `${address}?reviewTransitionScript=${result.scriptId}`);
      const after = service.store(deckId).snapshot();
      const script = after.transitionScripts.find((candidate) => candidate.id === result.scriptId);
      assert.ok(script !== undefined);
      assert.deepEqual(script.approval, { kind: "unapproved" }, "unapproved even for the owner's account");
      assert.deepEqual(script.author, { kind: "agent", name: "Claude", agentSessionId: agentSessionOf("session-A") });
      assert.deepEqual(slideById(after, slideId).transition, { kind: "scripted", scriptId: result.scriptId, durationMilliseconds: 1200, parameters: {} });
      assert.equal(service.envelopes(deckId).length, 1, "the save and the assignment are one envelope");
    });
  }
});

describe("builds through deck_edit (addAnimations, updateAnimations, moveAnimations, removeAnimations)", () => {
  const fade = { kind: "fadeIn" } as const;

  test("steps added in the call that adds their elements, with the defaults, their minted ids reported; then moved, updated and removed", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = firstSlide(deckId);
    const added = (await assistant.read("deck_edit", {
      deckId,
      summary: "added two cards that fly in",
      edits: [
        { kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" },
        { kind: "addShape", id: "el_buildCard2", slideId, preset: "ellipse" },
        {
          kind: "addAnimations",
          slideId,
          steps: [
            { elementId: "el_buildCard1", effect: { kind: "flyIn", from: "bottom" } },
            { elementId: "el_buildCard2", effect: { kind: "spin" }, trigger: "withPrevious", durationMilliseconds: 800 },
          ],
        },
      ],
    })) as DeckEditApplied;
    assert.equal(added.kind, "applied", JSON.stringify(added));
    const minted = added.created[2]?.animationStepIds ?? [];
    assert.equal(minted.length, 2);
    assert.deepEqual(added.created.slice(0, 2).map((entry) => entry.animationStepIds), [[], []], "an edit that adds no step reports none");
    const [first, second] = minted;
    assert.ok(first !== undefined && second !== undefined);
    assert.deepEqual(stepsOf(deckId, slideId), [
      { id: first, elementId: "el_buildCard1", effect: { kind: "flyIn", from: "bottom" }, trigger: "onClick", durationMilliseconds: 500, delayMilliseconds: 0, easing: "easeOut", unsupportedKeys: [] },
      { id: second, elementId: "el_buildCard2", effect: { kind: "spin", degrees: 360 }, trigger: "withPrevious", durationMilliseconds: 800, delayMilliseconds: 0, easing: "easeOut", unsupportedKeys: [] },
    ]);

    const appended = (await assistant.read("deck_edit", { deckId, summary: "and a pulse", edits: [{ kind: "addAnimations", slideId, steps: [{ elementId: "el_buildCard1", effect: { kind: "pulse" } }] }] })) as DeckEditApplied;
    assert.equal(appended.kind, "applied", JSON.stringify(appended));
    const third = appended.created[0]?.animationStepIds[0] ?? "";
    assert.deepEqual(stepIdsOf(deckId, slideId), [first, second, third], "after null appends at the END of the sequence");

    const reordered = (await assistant.read("deck_edit", {
      deckId,
      summary: "pulse first, slower spin",
      edits: [
        { kind: "moveAnimations", slideId, stepIds: [third], after: null },
        { kind: "updateAnimations", slideId, stepIds: [second], patch: { durationMilliseconds: 1500, trigger: "afterPrevious" } },
      ],
    })) as DeckEditApplied;
    assert.equal(reordered.kind, "applied", JSON.stringify(reordered));
    assert.deepEqual(stepIdsOf(deckId, slideId), [third, first, second], "moveAnimations after null moves to the start");
    const spin = stepsOf(deckId, slideId)[2];
    assert.deepEqual([spin?.durationMilliseconds, spin?.trigger, spin?.effect], [1500, "afterPrevious", { kind: "spin", degrees: 360 }], "an update keeps every field it does not name");

    const removed = (await assistant.read("deck_edit", { deckId, summary: "no pulse", edits: [{ kind: "removeAnimations", slideId, stepIds: [third] }] })) as DeckEditApplied;
    assert.equal(removed.kind, "applied", JSON.stringify(removed));
    assert.deepEqual(stepIdsOf(deckId, slideId), [first, second]);

    const outline = (await assistant.read("deck_read", { deckId })) as DeckOutline;
    assert.deepEqual(outline.slides[0]?.animations.map((step) => step.id), [first, second], "deck_read lists the sequence in play order");
  });

  // Parametric over where the new step goes: `after` names a step, or is null (the end); the
  // control adds to a slide without steps.
  for (const row of [
    { name: "after the first step", existing: 2, afterIndex: 0, expectedIndex: 1 },
    { name: "after null: at the end", existing: 2, afterIndex: null, expectedIndex: 2 },
    { name: "control: a slide without steps", existing: 0, afterIndex: null, expectedIndex: 0 },
  ] as const) {
    test(`addAnimations ${row.name} -> position ${String(row.expectedIndex)}`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId } = await createDeck(assistant);
      const slideId = firstSlide(deckId);
      const seeded = (await assistant.read("deck_edit", {
        deckId,
        summary: "a card",
        edits: [
          { kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" },
          ...(row.existing === 0 ? [] : [{ kind: "addAnimations", slideId, steps: Array.from({ length: row.existing }, () => ({ elementId: "el_buildCard1", effect: fade })) }]),
        ],
      })) as DeckEditApplied;
      assert.equal(seeded.kind, "applied", JSON.stringify(seeded));
      const before = stepIdsOf(deckId, slideId);
      const after = row.afterIndex === null ? null : before[row.afterIndex];
      const added = (await assistant.read("deck_edit", { deckId, summary: "one more", edits: [{ kind: "addAnimations", slideId, after, steps: [{ elementId: "el_buildCard1", effect: { kind: "zoomIn" } }] }] })) as DeckEditApplied;
      assert.equal(added.kind, "applied", JSON.stringify(added));
      const stepId = added.created[0]?.animationStepIds[0];
      assert.equal(stepIdsOf(deckId, slideId).indexOf(stepId ?? ""), row.expectedIndex);
      assert.equal(stepIdsOf(deckId, slideId).length, row.existing + 1);
    });
  }

  // Each refusal names the edit and writes nothing; the control row is the same call made valid.
  for (const row of [
    { name: "a step on an element not on the slide", edit: { kind: "addAnimations", steps: [{ elementId: "el_missing001", effect: fade }] }, reason: /^elementMissing: .*el_missing001/u },
    { name: "an update of a step that is not there", edit: { kind: "updateAnimations", stepIds: ["an_missing001"], patch: { durationMilliseconds: 900 } }, reason: /^animationStepMissing: .*an_missing001/u },
    { name: "a move after a step that is not there", edit: { kind: "moveAnimations", stepIds: ["an_missing001"], after: null }, reason: /^animationStepMissing: .*an_missing001/u },
    { name: "control: a valid step", edit: { kind: "addAnimations", steps: [{ elementId: "el_buildCard1", effect: fade }] }, reason: null },
  ] as const) {
    test(`${row.name}: ${row.reason === null ? "applied" : "rejected at edit 1, nothing written"}`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId } = await createDeck(assistant);
      const before = service.store(deckId).snapshot();
      const slideId = firstSlide(deckId);
      const answer = await assistant.call("deck_edit", { deckId, summary: "a built card", edits: [{ kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" }, { ...row.edit, slideId }] });
      const outcome = JSON.parse(answer.text) as AssistantEditOutcome;
      if (row.reason === null) {
        assert.equal(outcome.kind, "applied", answer.text);
        assert.equal(stepIdsOf(deckId, slideId).length, 1);
        return;
      }
      assert.equal(answer.isError, true);
      assert.equal(outcome.kind, "rejected");
      if (outcome.kind !== "rejected") return;
      assert.equal(outcome.editIndex, 1);
      assert.match(outcome.reason, row.reason);
      assert.deepEqual(service.store(deckId).snapshot(), before, "nothing was written");
    });
  }

  // The input schema holds every effect option to ANIMATION_LIMITS; the control is at the limit.
  for (const row of [
    { name: "growShrink scale 10 (the limit)", effect: { kind: "growShrink", scale: 10 }, accepted: true },
    { name: "growShrink scale 10.5", effect: { kind: "growShrink", scale: 10.5 }, accepted: false },
    { name: "spin 3601 degrees", effect: { kind: "spin", degrees: 3601 }, accepted: false },
    { name: "a motion path 6401 units away", effect: { kind: "motionPath", offsetX: 6401, offsetY: 0 }, accepted: false },
    { name: "an effect kind that does not exist", effect: { kind: "explode" }, accepted: false },
  ] as const) {
    test(`${row.name}: ${row.accepted ? "accepted" : "refused by the input schema"}`, async () => {
      const assistant = await connect({ sessionId: "session-A", caller: OWNER });
      const { deckId } = await createDeck(assistant);
      const slideId = firstSlide(deckId);
      const answer = await assistant.call("deck_edit", {
        deckId,
        summary: "an effect",
        edits: [
          { kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" },
          { kind: "addAnimations", slideId, steps: [{ elementId: "el_buildCard1", effect: row.effect }] },
        ],
      });
      assert.equal(answer.isError === true, !row.accepted, answer.text);
      assert.equal(stepIdsOf(deckId, slideId).length, row.accepted ? 1 : 0);
    });
  }

  test("deleting an element in a later edit of the call drops its steps from the working copy too: a step added after the delete appends correctly", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = firstSlide(deckId);
    const outcome = (await assistant.read("deck_edit", {
      deckId,
      summary: "built, then rebuilt",
      edits: [
        { kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" },
        { kind: "addShape", id: "el_buildCard2", slideId, preset: "rectangle" },
        { kind: "addAnimations", slideId, steps: [{ elementId: "el_buildCard2", effect: fade }, { elementId: "el_buildCard1", effect: fade }] },
        { kind: "deleteElements", slideId, elementIds: ["el_buildCard1"] },
        { kind: "addAnimations", slideId, steps: [{ elementId: "el_buildCard2", effect: { kind: "fadeOut" } }] },
      ],
    })) as DeckEditApplied;
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    // `created` lists only the edits that added something, each with its edit index.
    const stepsOfEdit = (editIndex: number): readonly string[] => outcome.created.find((entry) => entry.editIndex === editIndex)?.animationStepIds ?? [];
    const kept = stepsOfEdit(2)[0];
    const appended = stepsOfEdit(4)[0];
    assert.deepEqual(stepIdsOf(deckId, slideId), [kept, appended], "the deleted card's step went with it; the new step follows the kept one");
  });

  test("an agent's step is undone with the call in ONE undo step", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = firstSlide(deckId);
    const before = service.store(deckId).snapshot();
    const outcome = (await assistant.read("deck_edit", {
      deckId,
      summary: "a built card",
      edits: [{ kind: "addShape", id: "el_buildCard1", slideId, preset: "rectangle" }, { kind: "addAnimations", slideId, steps: [{ elementId: "el_buildCard1", effect: fade }] }],
    })) as DeckEditApplied;
    assert.equal(outcome.kind, "applied");
    assert.equal(service.store(deckId).undo().kind, "applied");
    assert.deepEqual(service.store(deckId).snapshot().slides, before.slides);
  });
});

describe("morph through deck_edit", () => {
  test("setSlide sets a morph transition and restyleElements a shared morph key; deck_read shows both", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const firstId = firstSlide(deckId);
    const outcome = (await assistant.read("deck_edit", {
      deckId,
      summary: "the logo glides to the corner",
      edits: [
        { kind: "addShape", id: "el_logoBig001", slideId: firstId, preset: "ellipse", frame: { x: 440, y: 160, width: 400, height: 400 } },
        { kind: "addSlide", id: "sl_morphNext1", placeholderText: { title: ["Next"] } },
        { kind: "addShape", id: "el_logoSmall1", slideId: "sl_morphNext1", preset: "ellipse", frame: { x: 1120, y: 40, width: 120, height: 120 } },
        { kind: "restyleElements", slideId: firstId, elementIds: ["el_logoBig001"], patch: { morphKey: "logo" } },
        { kind: "restyleElements", slideId: "sl_morphNext1", elementIds: ["el_logoSmall1"], patch: { morphKey: "logo" } },
        { kind: "setSlide", slideId: "sl_morphNext1", patch: { transition: { kind: "builtin", effect: { effect: "morph" }, durationMilliseconds: 900 } } },
      ],
    })) as DeckEditApplied;
    assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    const snapshot = service.store(deckId).snapshot();
    assert.deepEqual(slideById(snapshot, "sl_morphNext1").transition, { kind: "builtin", effect: { effect: "morph" }, durationMilliseconds: 900, easing: "easeInOut" });
    assert.equal(slideById(snapshot, firstId).transition, null, "control: the slide it leaves keeps its own transition");
    const outline = (await assistant.read("deck_read", { deckId })) as DeckOutline;
    const keys = outline.slides.flatMap((slide) => slide.elements.filter((element) => element.elementId === "el_logoBig001" || element.elementId === "el_logoSmall1").map((element) => element.morphKey));
    assert.deepEqual(keys, ["logo", "logo"]);
    assert.equal(outline.slides[1]?.transition, "morph 900 ms");
    const untouched = outline.slides[1]?.elements.find((element) => element.placeholder === "title");
    assert.equal(untouched?.morphKey, untouched?.elementId, "control: an element nobody keyed morphs by its own id");
  });
});

describe("deck_write_animation and deck_write_transition keep their purposes apart", () => {
  test("an animation script is saved with purpose animation and steps; deck_write_transition refuses to replace it", async () => {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slideId = firstSlide(deckId);
    const titleId = slideById(service.store(deckId).snapshot(), slideId).elements.find((element) => element.placeholder !== null)?.id ?? elementId("el_noTitle0001");
    const written = (await assistant.read("deck_write_animation", {
      deckId,
      name: "Rise",
      script: "sashaTransition.define({ name: 'Rise', async run(context) {} });",
      assignTo: [{ slideId, elementId: titleId, category: "entrance" }],
    })) as Readonly<{ scriptId: string; approved: boolean; animationStepIds: readonly string[] }>;
    assert.equal(written.approved, false);
    const snapshot = service.store(deckId).snapshot();
    assert.equal(snapshot.transitionScripts.find((script) => script.id === written.scriptId)?.purpose, "animation");
    assert.deepEqual(stepsOf(deckId, slideId).map((step) => [step.id, step.elementId, step.effect, step.durationMilliseconds]), [
      [written.animationStepIds[0], titleId, { kind: "scripted", scriptId: written.scriptId, category: "entrance", parameters: {} }, 1000],
    ]);
    const replaced = await assistant.call("deck_write_transition", { deckId, scriptId: written.scriptId, name: "Rise", script: "sashaTransition.define({});" });
    assert.equal(replaced.isError, true);
    assert.match(replaced.text, /^invalidValue: script .* is an animation script; replace it with deck_write_animation/u);
    assert.deepEqual(service.store(deckId).snapshot(), snapshot, "nothing was written");
  });
});

describe("deck_revert (acceptance 9)", () => {
  test("reverting session A keeps session B's edits and the person's", async () => {
    const sessionA = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(sessionA);
    service.setRole({ deckId, caller: COLLEAGUE, role: "editor" });
    const sessionB = await connect({ sessionId: "session-B", caller: COLLEAGUE });
    const slideId = service.store(deckId).snapshot().slides[0]?.id ?? "";
    for (const [connection, id] of [[sessionA, "el_fromSessionA"], [sessionB, "el_fromSessionB"]] as const) {
      const outcome = (await connection.read("deck_edit", { deckId, summary: "a note", edits: [{ kind: "addShape", id, slideId, text: [id] }] })) as AssistantEditOutcome;
      assert.equal(outcome.kind, "applied");
    }
    const personEdit = service.personEdit({ deckId, caller: OWNER, commands: [{ kind: "setTitle", title: "The person's title" }] });
    assert.equal(personEdit.kind, "applied");
    const reverted = (await sessionA.read("deck_revert", { deckId })) as Readonly<{ kind: string; stepsReverted: number; agentSessionId: string }>;
    assert.equal(reverted.kind, "reverted");
    assert.equal(reverted.stepsReverted, 1);
    assert.equal(reverted.agentSessionId, agentSessionOf("session-A"), "defaults to this session");
    const after = service.store(deckId).snapshot();
    const ids = slideById(after, slideId).elements.map((element) => element.id);
    assert.ok(!ids.includes(elementId("el_fromSessionA")), "session A's shape is gone");
    assert.ok(ids.includes(elementId("el_fromSessionB")), "session B's shape stays");
    assert.equal(after.title, "The person's title", "the person's edit stays");
  });
});

describe("comments (acceptance 10)", () => {
  async function deckWithThreads(): Promise<Readonly<{ assistant: AssistantConnection; deckId: DeckId; slideId: SlideId; drawn: ThreadId; quoted: ThreadId }>> {
    const assistant = await connect({ sessionId: "session-A", caller: OWNER });
    const { deckId } = await createDeck(assistant);
    const slide = service.store(deckId).snapshot().slides[0];
    const slideId = slide?.id ?? slideIdOf("sl_none00000");
    const titleId = slide?.elements[0]?.id ?? elementId("el_none00000");
    const drawn = threadId("th_drawn00001");
    const quoted = threadId("th_quoted0001");
    const created = await Promise.all([
      service.personDiscussion({
        deckId,
        caller: OWNER,
        command: {
          kind: "createThread",
          threadId: drawn,
          anchor: { slideId, target: { kind: "slide" }, region: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }, elementFrameAtCreation: null },
          markings: [{ kind: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }], colour: "#e11d48", width: 3 }],
          messageId: messageId("ms_drawn00001"),
          body: "This corner is cramped",
          mentions: [],
        },
      }),
      service.personDiscussion({
        deckId,
        caller: OWNER,
        command: {
          kind: "createThread",
          threadId: quoted,
          anchor: { slideId, target: { kind: "text", elementId: titleId, anchor: { target: { kind: "element", slideId, elementId: titleId }, start: "AA", end: "AQ" }, quotedText: "Launch" }, region: null, elementFrameAtCreation: null },
          markings: [],
          messageId: messageId("ms_quoted0001"),
          body: "Say 'Release' instead",
          mentions: [],
        },
      }),
    ]);
    for (const outcome of created) assert.equal(outcome.kind, "applied");
    return { assistant, deckId, slideId, drawn, quoted };
  }

  test("deck_read_comments flattens threads: marking kinds, quoted text, slide number", async () => {
    const { assistant, deckId, drawn, quoted } = await deckWithThreads();
    const read = (await assistant.read("deck_read_comments", { deckId })) as Readonly<{ sequence: number; threads: readonly AssistantThread[] }>;
    assert.equal(read.sequence, 2);
    const byId = new Map(read.threads.map((thread) => [thread.threadId, thread]));
    assert.deepEqual(byId.get(drawn)?.markingKinds, ["pen"]);
    assert.equal(byId.get(drawn)?.quotedText, null);
    assert.equal(byId.get(quoted)?.target, "text");
    assert.equal(byId.get(quoted)?.quotedText, "Launch");
    assert.deepEqual(byId.get(quoted)?.markingKinds, []);
    assert.equal(byId.get(drawn)?.slideNumber, 1);
    assert.deepEqual(byId.get(drawn)?.messages.map((message) => [message.authorName, message.authorKind, message.body]), [["Ada", "person", "This corner is cramped"]]);
  });

  test("deck_reply_comment posts as the account's agent person", async () => {
    const { assistant, deckId, drawn } = await deckWithThreads();
    const answer = await assistant.call("deck_reply_comment", { deckId, threadId: drawn, body: "Moved it right" });
    assert.equal(answer.isError, false, answer.text);
    const thread = (await discussionOf(deckId)).threads.find((candidate) => candidate.id === drawn);
    const reply = thread?.messages.at(-1);
    assert.equal(reply?.body, "Moved it right");
    assert.deepEqual(reply?.author, OWNER.agent);
    assert.equal(reply?.author.kind, "agent");
  });

  test("deck_resolve_comment with a note posts the note, then resolves", async () => {
    const { assistant, deckId, drawn } = await deckWithThreads();
    const answer = await assistant.call("deck_resolve_comment", { deckId, threadId: drawn, note: "Fixed: more padding" });
    assert.equal(answer.isError, false, answer.text);
    const discussion = await discussionOf(deckId);
    const thread = discussion.threads.find((candidate) => candidate.id === drawn);
    assert.equal(thread?.messages.at(-1)?.body, "Fixed: more padding");
    assert.equal(thread?.status.kind, "resolved");
    assert.equal(discussion.sequence, 4, "two entries: the note, then the resolve");
  });

  test("deck_await_comments returns a colleague's new message, sending progress while it waits", async () => {
    const { assistant, deckId, drawn } = await deckWithThreads();
    const progress: number[] = [];
    const waiting = assistant.call("deck_await_comments", { deckId, afterSequence: 2, timeoutSeconds: 10 }, (update) => progress.push(update.progress));
    await delay(400);
    await service.personDiscussion({ deckId, caller: OWNER, command: { kind: "reply", threadId: drawn, messageId: messageId("ms_later00001"), body: "Any news?", mentions: [] } });
    const answer = await waiting;
    const result = JSON.parse(answer.text) as Readonly<{ sequence: number; timedOut: boolean; changes: readonly Readonly<{ change: string; newMessageIds: readonly string[]; thread: AssistantThread }>[] }>;
    assert.equal(result.timedOut, false);
    assert.equal(result.sequence, 3);
    assert.deepEqual(result.changes.map((change) => [change.change, change.thread.threadId, change.newMessageIds]), [["newMessages", drawn, ["ms_later00001"]]]);
    assert.ok(progress.length >= 1, "a progress notification was sent while waiting");
  });

  test("deck_await_comments answers empty when the time passes, and the agent's own reply does not wake it", async () => {
    const { assistant, deckId, drawn } = await deckWithThreads();
    const progress: number[] = [];
    const startedAt = Date.now();
    const waiting = assistant.call("deck_await_comments", { deckId, afterSequence: 2, timeoutSeconds: 1 }, (update) => progress.push(update.progress));
    await delay(200);
    const other = await connect({ sessionId: "session-A2", caller: OWNER });
    await other.call("deck_reply_comment", { deckId, threadId: drawn, body: "Working on it" });
    const result = JSON.parse((await waiting).text) as Readonly<{ timedOut: boolean; changes: readonly unknown[]; sequence: number }>;
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.changes, []);
    assert.equal(result.sequence, 3, "it saw the agent's reply, and kept waiting");
    assert.ok(Date.now() - startedAt >= 950, "it waited the whole second");
    assert.ok(progress.length >= 3, `progress was reported repeatedly (${String(progress.length)})`);
  });
});

describe("permissions (acceptance 11)", () => {
  for (const row of [
    { name: "a viewer", caller: VIEWER, role: "viewer", canEdit: false, canReply: false },
    { name: "a commenter", caller: COMMENTER, role: "commenter", canEdit: false, canReply: true },
    { name: "control: an editor", caller: COLLEAGUE, role: "editor", canEdit: true, canReply: true },
  ] as const) {
    test(`${row.name}: edit ${row.canEdit ? "applied" : "refused"}, reply ${row.canReply ? "posted" : "refused"}`, async () => {
      const owner = await connect({ sessionId: "session-owner", caller: OWNER });
      const { deckId } = await createDeck(owner);
      const created = await service.personDiscussion({
        deckId,
        caller: OWNER,
        command: { kind: "createThread", threadId: threadId("th_question01"), anchor: { slideId: firstSlide(deckId), target: { kind: "slide" }, region: null, elementFrameAtCreation: null }, markings: [], messageId: messageId("ms_question01"), body: "Thoughts?", mentions: [] },
      });
      assert.equal(created.kind, "applied");
      service.setRole({ deckId, caller: row.caller, role: row.role });
      const member = await connect({ sessionId: `session-${row.role}`, caller: row.caller });
      const before = service.store(deckId).snapshot();
      const edit = await member.call("deck_edit", { deckId, summary: "retitled", edits: [{ kind: "setTitle", title: "Mine now" }] });
      assert.equal(edit.isError, !row.canEdit, edit.text);
      if (!row.canEdit) {
        assert.match(edit.text, new RegExp(`^notPermitted: your role on deck ${deckId} is ${row.role}`, "u"));
        assert.deepEqual(service.store(deckId).snapshot(), before);
      }
      const reply = await member.call("deck_reply_comment", { deckId, threadId: "th_question01", body: "Looks good" });
      assert.equal(reply.isError, !row.canReply, reply.text);
      if (!row.canReply) assert.match(reply.text, /^notPermitted: /u);
    });
  }

  test("someone who is not a member is told the deck is not there", async () => {
    const owner = await connect({ sessionId: "session-owner", caller: OWNER });
    const { deckId } = await createDeck(owner);
    const stranger = await connect({ sessionId: "session-stranger", caller: VIEWER });
    const answer = await stranger.call("deck_read", { deckId });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /^notFound: /u);
  });
});

// --- helpers ------------------------------------------------------------------------------------

function agentSessionOf(sessionId: string): string {
  return `as_${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

function slideById(snapshot: DocumentSnapshot, slideId: string): SlideSnapshot {
  const slide = snapshot.slides.find((candidate) => candidate.id === slideId);
  if (slide === undefined) throw new Error(`no slide ${slideId}`);
  return slide;
}

/** deck_edit's applied answer, whose created entries carry the minted build step ids. */
type DeckEditApplied = Readonly<{ kind: "applied" | "rejected"; created: readonly CreatedIds[] }>;

function stepsOf(deckId: DeckId, slideId: string): readonly AnimationStep[] {
  return slideById(service.store(deckId).snapshot(), slideId).animations;
}

function stepIdsOf(deckId: DeckId, slideId: string): readonly string[] {
  return stepsOf(deckId, slideId).map((step) => step.id);
}

function firstSlide(deckId: DeckId): SlideId {
  return slideById(service.store(deckId).snapshot(), service.store(deckId).snapshot().slides[0]?.id ?? "").id;
}

function shapeOf(element: ElementSnapshot | undefined): ShapeElement {
  if (element === undefined || element.kind !== "shape") throw new Error(`not a shape: ${JSON.stringify(element)}`);
  return element;
}

function placeholderId(snapshot: DocumentSnapshot, slideId: string, role: string): ElementId {
  const element = slideById(snapshot, slideId).elements.find((candidate) => candidate.placeholder?.role === role);
  if (element === undefined) throw new Error(`no ${role} placeholder on ${slideId}`);
  return element.id;
}

function plain(body: TextBody): string {
  return body.paragraphs.map((paragraph) => paragraph.runs.map((run) => (run.kind === "text" ? run.text : "#")).join("")).join("\n");
}

async function discussionOf(deckId: DeckId): Promise<DiscussionSnapshot> {
  const opened = await service.openDeck({ caller: OWNER, deckId });
  if (opened.kind !== "opened") throw new Error("the owner can open the deck");
  await using deck = opened.deck;
  return deck.discussion();
}

/** PNG signature and IHDR chunk: enough for the magic bytes and the size. */
function pngHeader(size: Readonly<{ width: number; height: number }>): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, size.width);
  view.setUint32(20, size.height);
  return bytes;
}

function withPngHeader(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set(pngHeader({ width: 4, height: 3 }));
  return bytes;
}

function deckId(text: string): DeckId {
  const parsed = parseDeckId(text);
  if (parsed === null) throw new Error(`not a deck id: ${text}`);
  return parsed;
}

function elementId(text: string): ElementId {
  const parsed = parseElementId(text);
  if (parsed === null) throw new Error(`not an element id: ${text}`);
  return parsed;
}

function slideIdOf(text: string): SlideId {
  const parsed = parseSlideId(text);
  if (parsed === null) throw new Error(`not a slide id: ${text}`);
  return parsed;
}

function threadId(text: string): ThreadId {
  // A literal matching ids.ts OBJECT_ID_PATTERN; ids.ts has no parse function for thread ids.
  return text as ThreadId;
}

function messageId(text: string): MessageId {
  // A literal matching ids.ts OBJECT_ID_PATTERN; ids.ts has no parse function for message ids.
  return text as MessageId;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
