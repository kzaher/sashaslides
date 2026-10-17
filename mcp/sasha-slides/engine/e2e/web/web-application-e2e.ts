// ACCEPTANCE 14, END TO END IN CHROME: two people, each in a browser context of their own, sign in
// through the test identity provider, Ada lands on /decks and makes a New deck, the editor opens;
// Grace (invited by email) opens the same deck and sees Ada's cursor and her edit within a second;
// the server stops and Ada's editor goes offline while she keeps typing; the server restarts, the
// editor reconnects by itself and the offline edit arrives -- at Grace's and on the server.
//
//   npx tsx e2e/web/web-application-e2e.ts [screenshot directory]
//
// It builds dist/web, serves it from e2e/web/fake-deck-site.ts (the deck server's contracts over
// the real wire protocol, until the collaboration server module's routes land) on 127.0.0.1:8795,
// and drives Chrome on 127.0.0.1:9223, closing every tab and context it opened. Screenshots: the
// list page, the editor with two people, and the offline state. Whole run: under 90 seconds.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWeb, DEFAULT_WEB_OUTPUT_DIRECTORY } from "../../build-web.ts";
import { parseDeckId } from "../../src/contracts/ids.ts";
import { connectBrowser, type Tab } from "../shared/chrome-session.ts";
import { startFakeDeckSite } from "./fake-deck-site.ts";

const output = process.argv[2] ?? join(tmpdir(), "sasha-web-end-to-end");
const SITE_PORT = 8795;
const VIEWPORT = { width: 1440, height: 900 } as const;
const CONNECTION = (kind: string): string => `document.querySelector('[data-sasha-connection="${kind}"]') !== null`;
const ENTER = { key: "Enter", code: "Enter", keyCode: 13 } as const;
const ESCAPE = { key: "Escape", code: "Escape", keyCode: 27 } as const;

const runStarted = Date.now();
/** Progress on standard error, so a slow step shows where the run is. */
const step = (label: string): void => console.error(`[${((Date.now() - runStarted) / 1000).toFixed(1)} s] ${label}`);

await mkdir(output, { recursive: true });
await buildWeb({ outputDirectory: DEFAULT_WEB_OUTPUT_DIRECTORY, minify: true, now: () => new Date() });
step("built dist/web");
await using site = await startFakeDeckSite({ port: SITE_PORT, webDirectory: DEFAULT_WEB_OUTPUT_DIRECTORY });
step(`fake deck site on ${site.address}`);
await using browser = await connectBrowser();
step("connected to Chrome");

const facts: Record<string, unknown> = {};
const failures: string[] = [];
const check = (condition: boolean, failure: string): void => {
  if (!condition) failures.push(failure);
};

// --- Ada: sign in, the list page, New deck -------------------------------------------------------
step("Ada: opening /decks");
const ada = await browser.openTab(VIEWPORT);
await ada.navigate(`${site.address}/decks`);
await ada.waitFor(`document.getElementById("name") !== null`, 5_000);
facts["signedOutWentToSignIn"] = await ada.evaluate("location.pathname");
step("Ada: signing in");
await signIn({ tab: ada, name: "Ada Lovelace", email: "ada@example.com" });
await ada.waitFor(`document.body.innerText.includes("Make your first deck")`, 8_000);
await waitForFonts(ada);
await ada.screenshot(join(output, "01-list-empty.png"));
facts["listPageHasRealLogo"] = await ada.evaluate(`document.querySelector(".sasha-web-logo svg path") !== null`);
facts["listPageHasLivelyShapes"] = await ada.evaluate(`document.querySelector(".sasha-lively-ground") !== null`);

step("Ada: New deck");
await ada.click(await centreOf({ tab: ada, selector: `[...document.querySelectorAll("button")].find((button) => button.textContent === "New deck")` }));
const opening = await ada.waitFor(`location.pathname.startsWith("/deck/")`, 5_000);
const editorOpenedIn = await ada.waitFor(`${CONNECTION("online")} && document.querySelector(".sasha-view-canvas-area .sasha-slide-root") !== null`, 15_000);
const deckPath = String(await ada.evaluate("location.pathname"));
const deckId = parseDeckId(deckPath.slice("/deck/".length));
if (deckId === null) throw new Error(`not a deck address: ${deckPath}`);
facts["newDeckOpenedEditorInMilliseconds"] = opening + editorOpenedIn;
facts["pageTitle"] = await ada.evaluate("document.title");

// Ada invites Grace through the deck API, with her session's CSRF token.
facts["invite"] = await ada.evaluate(`(async () => {
  const session = await (await fetch("/deck-api/session")).json();
  const answer = await fetch("/deck-api/decks/${deckId}/members", { method: "POST", headers: { "Content-Type": "application/json", "X-Sasha-Csrf": session.csrfToken }, body: JSON.stringify({ email: "grace@example.com", role: "editor" }) });
  return (await answer.json()).outcome;
})()`);

// --- Grace: the same deck in her own browser context ------------------------------------------------
step("Grace: opening the deck");
const grace = await browser.openTab(VIEWPORT);
await grace.navigate(`${site.address}${deckPath}`);
await grace.waitFor(`document.getElementById("name") !== null`, 8_000);
await signIn({ tab: grace, name: "Grace Hopper", email: "grace@example.com" });
await grace.waitFor(`${CONNECTION("online")} && document.querySelector(".sasha-view-canvas-area [data-sasha-element-id]") !== null`, 15_000);
await waitForFonts(grace);

step("presence");
// Ada drags a marquee on the canvas (the editor publishes its pointer while a gesture lasts).
await ada.bringToFront();
const slide = await rectangleOf({ tab: ada, selector: `document.querySelector(".sasha-view-canvas-area .sasha-slide-root")` });
const cursorStarted = Date.now();
const corner = { x: slide.left + 30, y: slide.bottom - 30 };
await sendMouse({ tab: ada, type: "pressed", point: corner });
for (let step = 1; step <= 6; step += 1) await sendMouse({ tab: ada, type: "dragged", point: { x: corner.x + step * 12, y: corner.y - step * 8 } });
await grace.waitFor(`document.querySelector(".sasha-view-peer-cursor") !== null`, 3_000).catch(() => -1);
facts["cursorVisibleAtGraceInMilliseconds"] = Date.now() - cursorStarted;
await sendMouse({ tab: ada, type: "released", point: { x: corner.x + 72, y: corner.y - 48 } });

step("typing");
// Ada selects the first text element and types into it.
const element = await centreOf({ tab: ada, selector: `document.querySelector(".sasha-view-canvas-area .sasha-slide-root [data-sasha-element-id]")` });
const selectionStarted = Date.now();
await ada.click(element);
facts["selectionVisibleAtGraceInMilliseconds"] = await grace.waitFor(`document.querySelector(".sasha-view-peer-selection") !== null`, 2_000).then(() => Date.now() - selectionStarted, () => -1);
await ada.press(ENTER);
const editStarted = Date.now();
await ada.insertText("Hello from Ada");
const editSeen = await grace.waitFor(`document.querySelector(".sasha-view-canvas-area").innerText.includes("Hello from Ada")`, 3_000).then(() => true, () => false);
facts["editVisibleAtGraceInMilliseconds"] = editSeen ? Date.now() - editStarted : null;
await grace.screenshot(join(output, "02-editor-two-people-grace.png"));
await ada.screenshot(join(output, "03-editor-two-people-ada.png"));

// --- the server stops: offline, and an edit made meanwhile -----------------------------------------
step("stopping the server");
await site.stop();
const offlineIn = await ada.waitFor(`${CONNECTION("offline")} || ${CONNECTION("connecting")}`, 8_000).catch(() => -1);
facts["offlineShownInMilliseconds"] = offlineIn;
await ada.insertText(" and while offline");
await ada.waitFor(`document.querySelector('[data-sasha-unsent="true"]') !== null`, 3_000).catch(() => -1);
facts["unsentWhileOffline"] = await ada.evaluate(`document.querySelector("[data-sasha-unsent]")?.getAttribute("data-sasha-unsent")`);
facts["offlineConnection"] = await ada.evaluate(`document.querySelector("[data-sasha-connection]")?.getAttribute("data-sasha-connection")`);
await ada.screenshot(join(output, "04-editor-offline.png"));

// --- the server restarts: both reconnect, the offline edit arrives ---------------------------------
step("restarting the server");
await site.start();
facts["adaReconnectedInMilliseconds"] = await ada.waitFor(`${CONNECTION("online")} && document.querySelector('[data-sasha-unsent="false"]') !== null`, 40_000).catch(() => -1);
facts["graceReconnectedInMilliseconds"] = await grace.waitFor(CONNECTION("online"), 40_000).catch(() => -1);
const offlineEditAtGrace = await grace.waitFor(`document.querySelector(".sasha-view-canvas-area").innerText.includes("while offline")`, 5_000).then(() => true, () => false);
facts["offlineEditArrivedAtGrace"] = offlineEditAtGrace;
facts["offlineEditOnServer"] = site.deckText(deckId).includes("while offline");
await ada.press(ESCAPE);
await grace.screenshot(join(output, "05-editor-after-reconnect-grace.png"));

// --- the list page with the deck on it ---------------------------------------------------------------
step("list page");
await ada.navigate(`${site.address}/decks`);
await ada.waitFor(`document.querySelector(".sasha-web-deck-card") !== null`, 8_000);
await waitForFonts(ada);
await ada.screenshot(join(output, "06-list.png"));

step("share and import dialogs");
await ada.click(await centreOf({ tab: ada, selector: `[...document.querySelectorAll(".sasha-web-deck-card button")].find((button) => button.textContent === "Share")` }));
facts["shareDialogListsGrace"] = await ada.waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes("Grace Hopper") === true`, 5_000).then(() => true, () => false);
await ada.screenshot(join(output, "07-share-dialog.png"));
await ada.press(ESCAPE);
await ada.waitFor(`document.querySelector('[role="dialog"]') === null`, 2_000);
await ada.click(await centreOf({ tab: ada, selector: `[...document.querySelectorAll("button")].find((button) => button.textContent === "Import from Google Slides")` }));
await ada.waitFor(`document.querySelector('[role="dialog"] input') !== null`, 2_000);
await ada.insertText("https://docs.google.com/presentation/d/1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U/edit");
await ada.click(await centreOf({ tab: ada, selector: `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Import")` }));
facts["importOffersConnect"] = await ada.waitFor(`[...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === "Connect Google Slides")`, 5_000).then(() => true, () => false);
await ada.screenshot(join(output, "08-import-needs-google.png"));

step("the embedded editor, signed in with a ticket");
facts["policyViolationsOnTheListPage"] = await ada.evaluate(`window.sashaPolicyViolations ?? []`);
const addon = await browser.openTab(VIEWPORT);
await addon.navigate(`${site.address}${deckPath}?embed=addon#ticket=${site.mintTicket("grace@example.com")}`);
facts["embeddedOpenedInMilliseconds"] = await addon.waitFor(`${CONNECTION("online")} && document.querySelector(".sasha-view-canvas-area .sasha-slide-root") !== null`, 15_000).catch(() => -1);
facts["embeddedAddressAfterExchange"] = await addon.evaluate("location.pathname + location.search + location.hash");
facts["embeddedSeesTheDeck"] = await addon.evaluate(`document.querySelector(".sasha-view-canvas-area").innerText.includes("while offline")`);
facts["policyViolationsInTheEditor"] = await addon.evaluate(`window.sashaPolicyViolations ?? []`);
await addon.screenshot(join(output, "09-embedded-editor.png"));

console.log(JSON.stringify({ ...facts, screenshots: output }, null, 2));
check(facts["signedOutWentToSignIn"] === "/account/deck-session", "a signed-out visitor was not sent to sign in");
check(facts["listPageHasRealLogo"] === true && facts["listPageHasLivelyShapes"] === true, "the list page lacks the logo or the lively shapes");
check(facts["invite"] === "invited", "the invitation was not recorded");
check(typeof facts["cursorVisibleAtGraceInMilliseconds"] === "number" && Number(facts["cursorVisibleAtGraceInMilliseconds"]) <= 1_000, "Grace did not see Ada's cursor within 1 s");
check(Number(facts["selectionVisibleAtGraceInMilliseconds"]) >= 0 && Number(facts["selectionVisibleAtGraceInMilliseconds"]) <= 1_000, "Grace did not see Ada's selection within 1 s");
check(typeof facts["editVisibleAtGraceInMilliseconds"] === "number" && Number(facts["editVisibleAtGraceInMilliseconds"]) <= 1_000, "Grace did not see Ada's edit within 1 s");
check(offlineIn >= 0, "the editor did not go offline when the server stopped");
check(facts["unsentWhileOffline"] === "true", "the offline edit was not marked unsent");
check(Number(facts["adaReconnectedInMilliseconds"]) >= 0, "Ada's editor did not reconnect");
check(offlineEditAtGrace && facts["offlineEditOnServer"] === true, "the offline edit did not arrive");
check(facts["shareDialogListsGrace"] === true, "the share dialog does not list the invited member");
check(facts["importOffersConnect"] === true, "the import dialog does not offer to connect Google Slides");
check(Number(facts["embeddedOpenedInMilliseconds"]) >= 0 && facts["embeddedSeesTheDeck"] === true, "the embedded editor did not open the deck with its bearer");
check(facts["embeddedAddressAfterExchange"] === `${deckPath}?embed=addon`, "the ticket stayed in the address");
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

async function signIn(options: Readonly<{ tab: Tab; name: string; email: string }>): Promise<void> {
  const navigated = options.tab.evaluate(`new Promise((resolve) => { addEventListener("pagehide", () => resolve(true)); document.getElementById("name").value = ${JSON.stringify(options.name)}; document.getElementById("email").value = ${JSON.stringify(options.email)}; document.getElementById("sign-in").click(); })`);
  await Promise.race([navigated, new Promise((resolve) => setTimeout(resolve, 3_000))]).catch(() => undefined);
}

async function waitForFonts(tab: Tab): Promise<void> {
  await tab.evaluate(`Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
}

type Rectangle = Readonly<{ left: number; top: number; right: number; bottom: number }>;

async function rectangleOf(options: Readonly<{ tab: Tab; selector: string }>): Promise<Rectangle> {
  const value = await options.tab.evaluate(`(() => { const element = ${options.selector}; if (!element) return null; const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; })()`);
  if (typeof value !== "object" || value === null) throw new Error(`nothing matches ${options.selector}`);
  return { left: Number(Reflect.get(value, "left")), top: Number(Reflect.get(value, "top")), right: Number(Reflect.get(value, "right")), bottom: Number(Reflect.get(value, "bottom")) };
}

async function centreOf(options: Readonly<{ tab: Tab; selector: string }>): Promise<Readonly<{ x: number; y: number }>> {
  const box = await rectangleOf(options);
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

async function sendMouse(options: Readonly<{ tab: Tab; type: "pressed" | "dragged" | "released"; point: Readonly<{ x: number; y: number }> }>): Promise<void> {
  switch (options.type) {
    case "pressed":
      await options.tab.moveMouse(options.point);
      await options.tab.mouse({ type: "mousePressed", point: options.point, buttons: 1 });
      return;
    case "dragged":
      await options.tab.mouse({ type: "mouseMoved", point: options.point, buttons: 1 });
      return;
    case "released":
      await options.tab.mouse({ type: "mouseReleased", point: options.point, buttons: 0 });
      return;
    default:
      throw new Error(`unknown mouse step ${String(options.type satisfies never)}`);
  }
}
