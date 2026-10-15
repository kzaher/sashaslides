// THE PUBLIC PAGES: the product home page, the legal pages Google's OAuth consent screen links to,
// and the developer UI that used to live at "/".

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DECK_LIST_ADDRESS, PAGES, pageFor } from "./pages.ts";

const PUBLIC_DIR = join(import.meta.dirname, "public");
const read = (file: string): string => readFileSync(join(PUBLIC_DIR, file), "utf8");

test("each public address maps to its page, and the old home page moved to /dev", () => {
  const rows: readonly { path: string; file: string | null }[] = [
    { path: "/", file: "home.html" },
    { path: "/dev", file: "app.html" },
    { path: "/dev/", file: "app.html" },
    { path: "/privacy", file: "privacy.html" },
    { path: "/terms", file: "terms.html" },
    { path: "/walkthroughs/claude-ai", file: "walkthroughs/claude-ai.html" },
    { path: "/walkthroughs/chatgpt", file: "walkthroughs/chatgpt.html" },
    { path: "/shell.html", file: null },
    { path: "/privacy/extra", file: null },
  ];
  for (const row of rows) assert.equal(pageFor(row.path), row.file, row.path);
});

test("every mapped page exists in public/", () => {
  for (const file of new Set(Object.values(PAGES))) assert.ok(existsSync(join(PUBLIC_DIR, file)), file);
});

test("the public pages link both legal pages and never advertise the developer tools", () => {
  const home = read("home.html");
  for (const href of ['href="/privacy"', 'href="/terms"']) assert.ok(home.includes(href), href);
  for (const file of ["home.html", "privacy.html", "terms.html"]) {
    const page = read(file);
    assert.doesNotMatch(page, /href="\/dev"/, `${file}: no link to /dev`);
    assert.doesNotMatch(page, />Developers</, `${file}: no Developers entry`);
  }
  assert.equal(pageFor("/dev"), "app.html", "the developer UI is still served, just not linked");
});

test("the privacy policy carries what Google's verification checks for", () => {
  const privacy = read("privacy.html");
  // Google API Services User Data Policy: the Limited Use disclosure, verbatim in substance.
  assert.match(privacy, /Google API Services User Data Policy/);
  assert.match(privacy, /Limited Use requirements/);
  // Every scope the connector asks for (mcp/sasha-slides/http/oauth-metadata.ts BROKERED_SCOPES).
  for (const scope of ["openid", "email", "auth/presentations", "auth/drive.file"]) assert.ok(privacy.includes(scope), scope);
  assert.match(privacy, /myaccount\.google\.com\/permissions/, "says how to revoke access");
  assert.match(privacy, /href="\/terms"/);
});

test("the terms link back to the privacy policy", () => {
  assert.match(read("terms.html"), /href="\/privacy"/);
});

test("the legal pages name the operator and its contact address, and no personal address", () => {
  for (const file of ["privacy.html", "terms.html", "home.html"]) {
    const page = read(file);
    assert.match(page, /Exponent GmbH/, file);
    assert.doesNotMatch(page, /krunoslav/i, file);
  }
  for (const file of ["privacy.html", "terms.html"]) {
    const page = read(file);
    for (const line of ["Sihleggstrasse 23", "8832 Wollerau", "Switzerland", "CHE-257.333.635"]) assert.ok(page.includes(line), `${file}: ${line}`);
    assert.match(page, /mailto:sasha\.slides@exponent\.company/, file);
  }
});

test("both legal pages say they can change at any time and that continued use means acceptance", () => {
  for (const file of ["privacy.html", "terms.html"]) {
    const page = read(file);
    assert.match(page, /change [^.]*at any time/i, `${file}: may change at any time`);
    assert.match(page, /continu\w* to use the Service[^.]*(accept|agree)/i, `${file}: continued use is acceptance`);
  }
  // The intro states it up front too, not only in the last section.
  assert.match(read("terms.html"), /By using the Service you agree to these terms, as updated from time to time/);
});

test("the privacy policy covers improvement use, the paid-plan exception and key-reset deletion", () => {
  const privacy = read("privacy.html");
  assert.match(privacy, /improve the (quality of the )?Service/i, "data may be used to improve the service");
  assert.match(privacy, /paid plan[^.]*do not use/i, "except on a paid plan");
  assert.match(privacy, /generali[sz]ed AI/i, "Google data never trains general models");
  assert.match(privacy, /href="https:\/\/sashaslides\.com\/account"/, "links the deletion page");
  assert.match(privacy, /reset[^.]*key/i, "deletion resets the account key");
  assert.match(privacy, /Google, Apple, GitHub, an email address and password, or a passkey/, "names the sign-in options");
  assert.doesNotMatch(privacy, /Microsoft/, "Microsoft is no longer a sign-in option");
  assert.match(privacy, /one-way hash of your password/, "says passwords are stored only as hashes");
});

test("every public page declares the Sasha Slides favicon, and the files exist", () => {
  for (const file of ["home.html", "privacy.html", "terms.html"]) {
    const page = read(file);
    assert.match(page, /<link rel="icon" href="\/favicon\.ico" sizes="any">/, file);
    assert.match(page, /<link rel="icon" href="\/static\/sasha-slides-icon\.svg" type="image\/svg\+xml">/, file);
    assert.match(page, /<link rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png">/, file);
  }
  for (const file of ["favicon.ico", "sasha-slides-icon.svg", "apple-touch-icon.png"]) assert.ok(existsSync(join(PUBLIC_DIR, file)), file);
});

test("the home page links the walkthrough video for each assistant", () => {
  const home = read("home.html");
  for (const href of ['href="/walkthroughs/claude-ai"', 'href="/walkthroughs/chatgpt"']) assert.ok(home.includes(href), href);
  assert.match(home, /https:\/\/sashaslides\.com\/mcp/, "and the connector address to paste");
});

test("the home page describes the comment flow: the bot address, the share step and the stop step", () => {
  const home = read("home.html");
  assert.match(home, /aria-label="Answering comments"/);
  assert.match(home, /sasha@sashaslides\.com/, "names the address to share the deck with");
  assert.match(home, /Share your deck with/, "says to share the deck");
  assert.match(home, /Tell your assistant you are done/, "says how to stop");
  assert.match(home, /24 hours/);
  assert.match(home, /Stop when I say I&rsquo;m done/, "has the example prompt");
});

test("the setup walkthrough pages exist, each with its title, the animated player and the production connector", () => {
  const rows: readonly { file: string; flow: string; title: string }[] = [
    { file: "walkthroughs/claude-ai.html", flow: "claude-ai", title: "Connect Claude to Sasha Slides" },
    { file: "walkthroughs/chatgpt.html", flow: "chatgpt", title: "Connect ChatGPT to Sasha Slides" },
  ];
  for (const row of rows) {
    assert.ok(existsSync(join(PUBLIC_DIR, row.file)), `${row.file}: run mcp/sasha-slides/addon npm run build:walkthroughs`);
    const page = read(row.file);
    assert.ok(page.includes(`<title>${row.title}</title>`), `${row.file}: title`);
    assert.ok(page.includes(`data-flow="${row.flow}"`), `${row.file}: names its flow`);
    assert.ok(page.includes('data-connector="https://sashaslides.com/mcp"'), `${row.file}: types the production address`);
    assert.ok(page.includes("sasha-wt-viewport") && page.includes("Play the walkthrough"), `${row.file}: carries the player`);
    assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+stylesheet|\.mp4/, `${row.file}: self-contained`);
  }
});

test("the home page's data section offers Enterprise on your own servers and states the free-plan data use", () => {
  const home = read("home.html");
  assert.match(home, /<h2>Your data stays yours<\/h2>/);
  assert.match(home, /Enterprise:<\/strong> run Sasha Slides on your own servers/);
  assert.match(home, /On the free plan we may use data about how you use Sasha Slides to improve it; on a paid plan we never do\./);
});

test("the home page links to the deck list as 'Your decks', which the connector serves, not the website", () => {
  const home = read("home.html");
  assert.equal(DECK_LIST_ADDRESS, "/decks");
  const links = [...home.matchAll(/<a [^>]*href="\/decks"[^>]*>([^<]+)<\/a>/g)].map((match) => match[1]);
  assert.deepEqual(links, ["Your decks", "Your decks"], "in the bar and under the hero");
  assert.equal(pageFor(DECK_LIST_ADDRESS), null, "nginx routes /decks to the connector");
  assert.match(read("site.css"), /\.cta \{/, "the call to action is styled");
});
