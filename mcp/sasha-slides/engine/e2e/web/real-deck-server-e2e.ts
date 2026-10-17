// THE WEB APPLICATION AGAINST THE REAL DECK SERVER, IN CHROME. web-application-e2e.ts drives the
// browser against fake-deck-site.ts, a stand-in for the deck server's contracts; nothing there proves
// the real connector (server.ts --http with its deck server, sealed stores and session cookies)
// serves the editor and carries collaboration between two people. This run does:
//
//   1. it starts the REAL connector on a free loopback port, with throw-away stores in a fresh
//      temporary directory, a random master key and session secret, and the built dist/web;
//   2. it prepares two accounts in those stores (Ada and Grace, test identities), mints each a deck
//      session cookie with the server's own secret, and -- over the deck API, as Ada -- names them,
//      creates a deck and invites Grace as an editor;
//   3. two browser contexts (one per person) open /deck/<id>, and it checks that each sees the
//      other in presence, that Ada's selection and her typed text appear at Grace's, and that a
//      comment Ada posts appears at Grace's.
//
// Every exit path (a failed check, a thrown error, Ctrl-C) closes the tabs and contexts,
// stops the server's whole process group and deletes the temporary directory, through `await using`.
//
//   npx tsx e2e/web/real-deck-server-e2e.ts [screenshot directory]
//
// It needs dist/web (`npm run -s build:web`) and Chrome on 127.0.0.1:9223 (e2e/shared/chrome-session.ts), so it
// is not part of `npm test`. Whole run, measured 2026-10-15: about 8 s wall, 3.5 s of it the run itself.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WEB_OUTPUT_DIRECTORY } from "../../build-web.ts";
import { DECK_SESSION_COOKIE_PATH } from "../../src/contracts/deck-api.ts";
import { parseDeckId } from "../../src/contracts/ids.ts";
import { deckSessionCookies } from "../../../decks/deck-sessions.ts";
import { storeAccountDirectory } from "../../../http/account-directory.ts";
import { createAccountVault, openFileBackedDataKeyStore } from "../../../http/account-keys.ts";
import { randomAccountId, withSealedGoogleIdentities } from "../../../http/accounts.ts";
import { fileBackedAuthStore } from "../../../http/oauth-store.ts";
import { connectBrowser, type Tab } from "../shared/chrome-session.ts";

const CONNECTOR_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOOGLE_CLIENT_PATH = join(CONNECTOR_DIRECTORY, "..", "..", ".auth", "google_oauth.json");
const output = process.argv[2] ?? join(tmpdir(), "sasha-real-deck-server-end-to-end");
const VIEWPORT = { width: 1440, height: 900 } as const;
const CANVAS_ELEMENT = `.sasha-view-canvas-area .sasha-slide-root [data-sasha-element-id]`;
const ONLINE = `document.querySelector('[data-sasha-connection="online"]') !== null`;
const ENTER = { key: "Enter", code: "Enter", keyCode: 13 } as const;
const ESCAPE = { key: "Escape", code: "Escape", keyCode: 27 } as const;
/** The DevTools Protocol's modifier bits for the comment shortcut, Control+Alt+M. */
const CONTROL_ALT = 2 | 1;
/** The connector listens 1.4 s after spawning (measured 2026-10-15), so 30 s is a stall, not a slow start. */
const SERVER_START_BUDGET_MILLISECONDS = 30_000;

const runStarted = Date.now();
/** Progress on standard error, so a slow step shows where the run is. */
const step = (label: string): void => console.error(`[${((Date.now() - runStarted) / 1000).toFixed(1)} s] ${label}`);

if (!existsSync(join(DEFAULT_WEB_OUTPUT_DIRECTORY, "manifest.json"))) throw new Error(`no web build in ${DEFAULT_WEB_OUTPUT_DIRECTORY}: run npm run -s build:web first`);
await mkdir(output, { recursive: true });
const secrets = { masterKey: randomBytes(32).toString("hex"), sessionSecret: randomBytes(32).toString("base64url") } as const;
await using temporary = await temporaryDirectory();
const people = await prepareAccounts({ directory: temporary.path, masterKey: secrets.masterKey, sessionSecret: secrets.sessionSecret });
step("accounts prepared");
await using server = await startConnector({ directory: temporary.path, masterKey: secrets.masterKey, sessionSecret: secrets.sessionSecret });
step(`connector on ${server.address}`);

const deckApi = deckApiAs({ address: server.address });
const adaProfile = await deckApi({ session: people.ada, method: "PUT", path: "/deck-api/profile", body: { displayName: "Ada Lovelace" } });
const graceProfile = await deckApi({ session: people.grace, method: "PUT", path: "/deck-api/profile", body: { displayName: "Grace Hopper" } });
const created = await deckApi({ session: people.ada, method: "POST", path: "/deck-api/decks", body: { title: "Real server end to end" } });
if (created.status !== 201) throw new Error(`creating the deck answered ${String(created.status)}: ${created.text}\n${server.log()}`);
const deckId = parseDeckId(String(fieldOf({ value: fieldOf({ value: JSON.parse(created.text), name: "deck" }), name: "deckId" })));
if (deckId === null) throw new Error(`the deck server named no deck: ${created.text}`);
const invite = await deckApi({ session: people.ada, method: "POST", path: `/deck-api/decks/${deckId}/members`, body: { email: "grace@example.com", role: "editor" } });
step(`deck ${deckId} shared with Grace`);

await using browser = await connectBrowser();
const ada = await openPerson({ address: server.address, cookie: people.ada.cookie });
const grace = await openPerson({ address: server.address, cookie: people.grace.cookie });

const facts: Record<string, unknown> = {
  profiles: [adaProfile.status, graceProfile.status],
  invite: invite.status === 200 ? fieldOf({ value: JSON.parse(invite.text), name: "outcome" }) : `${String(invite.status)} ${invite.text}`,
};
const failures: string[] = [];
const check = (condition: boolean, failure: string): void => {
  if (!condition) failures.push(failure);
};

step("Ada and Grace open the deck");
await openDeck({ tab: ada, address: server.address, deckId });
await openDeck({ tab: grace, address: server.address, deckId });

step("presence");
facts["adaSeesGraceInMilliseconds"] = await ada.waitFor(`document.querySelector('[aria-label^="Also here:"]')?.getAttribute("aria-label")?.includes("Grace Hopper")`, 5_000).catch(() => -1);
facts["graceSeesAdaInMilliseconds"] = await grace.waitFor(`document.querySelector('[aria-label^="Also here:"]')?.getAttribute("aria-label")?.includes("Ada Lovelace")`, 5_000).catch(() => -1);

step("Ada selects and types");
await ada.bringToFront();
await settle(ada);
const element = await centreOf({ tab: ada, selector: `document.querySelector(${JSON.stringify(CANVAS_ELEMENT)})` });
const selected = Date.now();
await ada.click(element);
facts["selectionVisibleAtGraceInMilliseconds"] = await grace.waitFor(`document.querySelector(".sasha-view-peer-selection") !== null`, 3_000).then(() => Date.now() - selected, () => -1);
await ada.press(ENTER);
const typed = Date.now();
await ada.insertText("Hello from Ada");
facts["editVisibleAtGraceInMilliseconds"] = await grace.waitFor(`document.querySelector(".sasha-view-canvas-area").innerText.includes("Hello from Ada")`, 4_000).then(() => Date.now() - typed, () => -1);
await ada.press(ESCAPE);
await shoot({ tab: ada, name: "01-ada-typed.png" });
await shoot({ tab: grace, name: "02-grace-sees-ada-edit-and-presence.png" });

step("Ada comments");
await ada.bringToFront();
await ada.click(element);
await ada.waitFor(`document.querySelector(".sasha-view-selection-box") !== null`, 3_000);
await ada.evaluate(`document.querySelector(".sasha-view-canvas-area").focus(); true`);
await ada.press({ key: "m", code: "KeyM", keyCode: 77, modifiers: CONTROL_ALT });
await ada.waitFor(`document.querySelector("form[aria-label='New comment'] textarea") !== null`, 3_000);
await ada.click(await centreOf({ tab: ada, selector: `document.querySelector("form[aria-label='New comment'] textarea")` }));
await ada.insertText("Is this greeting final?");
await ada.click(await centreOf({ tab: ada, selector: `[...document.querySelectorAll("form[aria-label='New comment'] button")].find((button) => button.textContent === "Comment")` }));
const commented = Date.now();
facts["threadAtAda"] = await ada.waitFor(`document.querySelector(".sasha-view-thread") !== null && document.body.innerText.includes("Is this greeting final?")`, 4_000).then(() => true, () => false);
await shoot({ tab: ada, name: "03-ada-commented.png" });
await grace.bringToFront();
facts["commentPinAtGraceInMilliseconds"] = await grace.waitFor(`document.querySelector(".sasha-view-comment-pin") !== null`, 4_000).then(() => Date.now() - commented, () => -1);
if (Number(facts["commentPinAtGraceInMilliseconds"]) >= 0) await grace.click(await centreOf({ tab: grace, selector: `document.querySelector(".sasha-view-comment-pin")` }));
facts["commentTextAtGrace"] = await grace.waitFor(`document.body.innerText.includes("Is this greeting final?")`, 4_000).then(() => true, () => false);
await shoot({ tab: grace, name: "04-grace-sees-ada-comment.png" });
facts["policyViolations"] = [await ada.evaluate(`window.sashaPolicyViolations ?? []`), await grace.evaluate(`window.sashaPolicyViolations ?? []`)];

console.log(JSON.stringify({ deckId, ...facts, screenshots: output, seconds: (Date.now() - runStarted) / 1000 }, null, 2));
check(adaProfile.status === 200 && graceProfile.status === 200, "the deck server did not store the display names");
check(facts["invite"] === "added", `Grace was not added to the deck: ${String(facts["invite"])}`);
check(Number(facts["adaSeesGraceInMilliseconds"]) >= 0, "Ada's presence avatars do not show Grace Hopper");
check(Number(facts["graceSeesAdaInMilliseconds"]) >= 0, "Grace's presence avatars do not show Ada Lovelace");
check(Number(facts["selectionVisibleAtGraceInMilliseconds"]) >= 0, "Grace did not see Ada's selection");
check(Number(facts["editVisibleAtGraceInMilliseconds"]) >= 0, "Grace did not see Ada's typed text within 4 s");
check(facts["threadAtAda"] === true, "Ada's comment did not open as a thread");
check(Number(facts["commentPinAtGraceInMilliseconds"]) >= 0 && facts["commentTextAtGrace"] === true, "Grace did not see Ada's comment");
if (failures.length > 0) {
  console.error(`${failures.join("\n")}\n--- connector output ---\n${server.log()}`);
  process.exitCode = 1;
}

// --- the person's session and the deck API ------------------------------------------------------

type PersonSession = Readonly<{ cookie: string; forgeryToken: string }>;

/**
 * Two accounts in the stores the connector will open, and a deck session cookie for each minted
 * with the connector's own secret: the run signs no one in through a provider, as SPEC.md 21.3's
 * cookie is what the deck server trusts.
 */
async function prepareAccounts(options: Readonly<{ directory: string; masterKey: string; sessionSecret: string }>): Promise<Readonly<{ ada: PersonSession; grace: PersonSession }>> {
  const keys = openFileBackedDataKeyStore({ path: join(options.directory, "account-keys.json"), warn: console.error });
  if (keys.kind !== "ok") throw new Error(keys.message);
  const vault = createAccountVault({ keyStore: keys.keyStore, masterKey: Buffer.from(options.masterKey, "hex") });
  const { store } = withSealedGoogleIdentities({ store: fileBackedAuthStore({ path: join(options.directory, "oauth-store.json"), warn: console.error }), vault });
  const accounts = storeAccountDirectory({ store, vault, now: () => new Date(), newAccountId: randomAccountId });
  const cookies = deckSessionCookies({ secret: options.sessionSecret, now: () => Date.now(), randomToken: () => randomBytes(18).toString("base64url") });
  const sessionFor = async (person: Readonly<{ subject: string; email: string }>): Promise<PersonSession> => {
    const accountId = await accounts.findOrCreateByIdentity({ provider: "test", subject: person.subject, email: person.email });
    const issued = cookies.issue({ accountId });
    return { cookie: issued.setCookie.split(";")[0] ?? "", forgeryToken: issued.session.forgeryToken };
  };
  return { ada: await sessionFor({ subject: "e2e-ada", email: "ada@example.com" }), grace: await sessionFor({ subject: "e2e-grace", email: "grace@example.com" }) };
}

type DeckApiAnswer = Readonly<{ status: number; text: string }>;

/** One deck API call as a person: their cookie, their forgery token, and the site's own Origin. */
function deckApiAs(options: Readonly<{ address: string }>): (call: Readonly<{ session: PersonSession; method: "PUT" | "POST"; path: string; body: unknown }>) => Promise<DeckApiAnswer> {
  return async (call) => {
    const answer = await fetch(`${options.address}${call.path}`, {
      method: call.method,
      headers: { "Content-Type": "application/json", Cookie: call.session.cookie, Origin: options.address, "X-Sasha-Csrf": call.session.forgeryToken },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: answer.status, text: (await answer.text()).slice(0, 2_000) };
  };
}

/** One field of a parsed JSON answer, or undefined when the answer is not an object. */
function fieldOf(options: Readonly<{ value: unknown; name: string }>): unknown {
  return typeof options.value === "object" && options.value !== null ? Reflect.get(options.value, options.name) : undefined;
}

async function openPerson(options: Readonly<{ address: string; cookie: string }>): Promise<Tab> {
  const tab = await browser.openTab({ ...VIEWPORT, reducedMotion: false });
  const separator = options.cookie.indexOf("=");
  await tab.setCookie({ url: `${options.address}${DECK_SESSION_COOKIE_PATH}`, name: options.cookie.slice(0, separator), value: options.cookie.slice(separator + 1) });
  return tab;
}

async function openDeck(options: Readonly<{ tab: Tab; address: string; deckId: string }>): Promise<void> {
  await options.tab.bringToFront();
  await options.tab.navigate(`${options.address}/deck/${options.deckId}`);
  await options.tab.waitFor(`${ONLINE} && document.querySelector(${JSON.stringify(CANVAS_ELEMENT)}) !== null`, 15_000);
}

/** Fonts, then two frames: raced against timers, because a hidden tab never runs a frame. */
async function settle(tab: Tab): Promise<void> {
  await tab.evaluate(
    `Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))), new Promise((resolve) => setTimeout(resolve, 500))]))`,
  );
}

async function shoot(options: Readonly<{ tab: Tab; name: string }>): Promise<void> {
  await options.tab.bringToFront();
  await settle(options.tab);
  await options.tab.screenshot(join(output, options.name));
}

async function centreOf(options: Readonly<{ tab: Tab; selector: string }>): Promise<Readonly<{ x: number; y: number }>> {
  const value = await options.tab.evaluate(
    `(() => { const element = ${options.selector}; if (!element) return null; element.scrollIntoView({ block: "nearest" }); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
  );
  if (typeof value !== "object" || value === null) throw new Error(`nothing matches ${options.selector}`);
  return { x: Number(Reflect.get(value, "x")), y: Number(Reflect.get(value, "y")) };
}

// --- the scoped resources: the temporary directory and the connector -----------------------------

async function temporaryDirectory(): Promise<AsyncDisposable & Readonly<{ path: string }>> {
  const path = await mkdtemp(join(tmpdir(), "sasha-real-deck-server-"));
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}

type RunningConnector = AsyncDisposable & Readonly<{ address: string; log: () => string }>;

/**
 * server.ts --http with the deck server on (SASHA_SESSION_SECRET) and the web build, in its own
 * process group (npx, tsx and node are three processes) so disposing it stops all of them.
 */
async function startConnector(options: Readonly<{ directory: string; masterKey: string; sessionSecret: string }>): Promise<RunningConnector> {
  const port = await freeLoopbackPort();
  const address = `http://127.0.0.1:${String(port)}`;
  const child = spawn(
    "npx",
    [
      "tsx",
      "server.ts",
      "--http",
      "--public-url",
      address,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--store",
      join(options.directory, "oauth-store.json"),
      "--key-store",
      join(options.directory, "account-keys.json"),
      "--google-client",
      GOOGLE_CLIENT_PATH,
      "--web-build",
      DEFAULT_WEB_OUTPUT_DIRECTORY,
    ],
    {
      cwd: CONNECTOR_DIRECTORY,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SASHA_MASTER_KEY: options.masterKey, SASHA_SESSION_SECRET: options.sessionSecret },
    },
  );
  const lines: string[] = [];
  const keep = (chunk: Buffer): void => {
    lines.push(...chunk.toString("utf-8").split("\n").filter((line) => line.length > 0));
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  // `await using` cannot run on Ctrl-C or a kill, so those stop the detached group here: an exit
  // listener is synchronous, and signalling is too.
  const processId = child.pid;
  if (processId !== undefined) {
    process.once("exit", () => signalGroup({ processId, signal: "SIGKILL" }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130));
  }
  const connector: RunningConnector = { address, log: () => lines.slice(-40).join("\n"), [Symbol.asyncDispose]: () => stopProcessGroup(child) };
  const started = Date.now();
  for (;;) {
    if (lines.some((line) => line.includes("listening on"))) break;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the connector exited (${String(child.exitCode ?? child.signalCode)}) before listening:\n${connector.log()}`);
    if (Date.now() - started > SERVER_START_BUDGET_MILLISECONDS) {
      await stopProcessGroup(child);
      throw new Error(`the connector did not listen within ${String(SERVER_START_BUDGET_MILLISECONDS / 1000)} s:\n${connector.log()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The banner says whether the deck server came up; without it every /deck address is a 404.
  if (!lines.some((line) => line.includes("decks: http"))) {
    await stopProcessGroup(child);
    throw new Error(`the connector is listening without its deck server:\n${connector.log()}`);
  }
  return connector;
}

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (bound === null || typeof bound === "string") throw new Error("the port probe has no address");
  return bound.port;
}

/**
 * SIGTERM to the whole group (the server closes its deck sockets cleanly), then SIGKILL to whatever
 * of the group is left after 3 s -- npx can be gone while its node child still runs.
 */
async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const running = child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  signalGroup({ processId: child.pid, signal: "SIGTERM" });
  if (running) await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  signalGroup({ processId: child.pid, signal: "SIGKILL" });
}

function signalGroup(options: Readonly<{ processId: number; signal: NodeJS.Signals }>): void {
  try {
    process.kill(-options.processId, options.signal);
  } catch {
    // The group is already gone: nothing is left to stop.
  }
}
