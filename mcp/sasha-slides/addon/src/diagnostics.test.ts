import { test } from "node:test";
import assert from "node:assert/strict";
import { accountSlotOf, collectDiagnostics, describeDiagnostics } from "./diagnostics.ts";

test("accountSlotOf reads the Google account slot out of the HtmlService host", () => {
  // The real host observed from a working session, slot 0.
  assert.equal(
    accountSlotOf("https://n-anszcgtk3ynud553esqx7pwt3k44o447uyo6z6q-0lu-script.googleusercontent.com/userCodeAppPanel"),
    0,
  );
  // A second signed-in account serves the same panel from slot 1.
  assert.equal(accountSlotOf("https://n-abc-1lu-script.googleusercontent.com/userCodeAppPanel"), 1);
  assert.equal(accountSlotOf("https://n-abc-12lu-script.googleusercontent.com/userCodeAppPanel"), 12);
  // Anything that is not that host shape must report unknown rather than assume the default.
  assert.equal(accountSlotOf("https://docs.google.com/presentation/d/abc/edit"), null);
  assert.equal(accountSlotOf(""), null);
  assert.equal(accountSlotOf("https://n-abc-xlu-script.googleusercontent.com/userCodeAppPanel"), null);
});

test("describeDiagnostics flags a non-default account, because that is the actionable case", () => {
  const base = { href: "https://n-abc-0lu-script.googleusercontent.com/userCodeAppPanel", visibilityState: "visible", readStorage: () => true, now: () => new Date("2026-10-04T12:00:00Z") };
  assert.match(describeDiagnostics(collectDiagnostics(base)), /account slot 0 · visible · storage ok/);
  assert.doesNotMatch(describeDiagnostics(collectDiagnostics(base)), /NOT the browser default/);

  const second = describeDiagnostics(collectDiagnostics({ ...base, href: "https://n-abc-1lu-script.googleusercontent.com/userCodeAppPanel" }));
  assert.match(second, /account slot 1 \(NOT the browser default\)/);

  const blocked = describeDiagnostics(collectDiagnostics({ ...base, readStorage: () => false, visibilityState: "hidden" }));
  assert.match(blocked, /not visible · storage blocked/);
});

test("an unreadable host reports unknown instead of pretending it is the default", () => {
  const d = collectDiagnostics({ href: "about:blank", visibilityState: "visible", readStorage: () => true, now: () => new Date("2026-10-04T12:00:00Z") });
  assert.equal(d.accountSlot, null);
  assert.match(describeDiagnostics(d), /account slot unknown/);
});
