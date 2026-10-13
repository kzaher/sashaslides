// THE PUBLIC PAGES: the product home page, the legal pages Google's OAuth consent screen links to,
// and the developer UI that used to live at "/".

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PAGES, pageFor } from "./pages.ts";

const PUBLIC_DIR = join(import.meta.dirname, "public");
const read = (file: string): string => readFileSync(join(PUBLIC_DIR, file), "utf8");

test("each public address maps to its page, and the old home page moved to /dev", () => {
  const rows: readonly { path: string; file: string | null }[] = [
    { path: "/", file: "home.html" },
    { path: "/dev", file: "app.html" },
    { path: "/dev/", file: "app.html" },
    { path: "/privacy", file: "privacy.html" },
    { path: "/terms", file: "terms.html" },
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
  for (const href of ['href="/videos/claude-ai.mp4"', 'href="/videos/chatgpt.mp4"']) assert.ok(home.includes(href), href);
  assert.match(home, /https:\/\/sashaslides\.com\/mcp/, "and the connector address to paste");
});
