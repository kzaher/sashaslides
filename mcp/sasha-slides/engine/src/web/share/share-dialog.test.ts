// THE SHARE DIALOG (acceptance 10): "Invite" posts exactly an `InviteRequest` {email, role}; link
// sharing offers off, viewer and commenter and never editor; a role that may not share sees the
// people list read-only.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DECK_ROLES, roleAllows, type DeckRole } from "../../contracts/deck-access.ts";
import type { DeckDetailsBody } from "../../contracts/deck-api.ts";
import { createDeckApiClient, sessionCredentials } from "../api/deck-api-client.ts";
import { PEER_PERSON, TEST_DECK_ID, TEST_PERSON } from "../testing/collaboration-harness.ts";
import { createShareActions, inviteRequestOf, LINK_SHARING_CHOICES, ShareDialog } from "./share-dialog.tsx";

function details(role: DeckRole): DeckDetailsBody {
  return {
    deck: { deckId: TEST_DECK_ID, title: "Quarterly review", role, owner: TEST_PERSON, createdAt: 1, updatedAt: 2, googleSlides: null },
    members: [
      { person: TEST_PERSON, role: "owner", email: roleAllows({ role, permission: "share" }) ? "ada@example.com" : null },
      { person: PEER_PERSON, role: "commenter", email: roleAllows({ role, permission: "share" }) ? "grace@example.com" : null },
    ],
    invitations: roleAllows({ role, permission: "share" }) ? [{ invitationId: "in_pending01", email: "new@example.com", role: "viewer", invitedAt: 3 }] : [],
    linkSharing: { kind: "anyoneSignedIn", role: "viewer" },
    agentSessions: [],
  };
}

function render(role: DeckRole): string {
  const ignore = (): void => undefined;
  return renderToStaticMarkup(
    createElement(ShareDialog, {
      details: details(role),
      draft: { email: "", role: "editor" },
      busy: false,
      problem: null,
      onDraftChange: ignore,
      onInvite: ignore,
      onChangeMember: ignore,
      onRemoveMember: ignore,
      onCancelInvitation: ignore,
      onLinkSharingChange: ignore,
      onClose: ignore,
    }),
  );
}

describe("10. the share dialog", () => {
  it("Invite posts an InviteRequest {email, role} to the deck's members", async () => {
    const posted: { method: string; path: string; body: unknown; csrf: string | null }[] = [];
    const credentials = sessionCredentials("cookie");
    credentials.update({ csrfToken: "csrf-1", bearerToken: null });
    const api = createDeckApiClient({
      origin: "https://sashaslides.test",
      credentials,
      fetch: (address, init) => {
        posted.push({ method: init.method ?? "GET", path: new URL(address).pathname, body: JSON.parse(String(init.body)), csrf: new Headers(init.headers).get("X-Sasha-Csrf") });
        return Promise.resolve(new Response(JSON.stringify({ outcome: "invited", details: details("owner") }), { status: 200 }));
      },
    });
    const result = await createShareActions(api.deck(TEST_DECK_ID)).invite({ email: "  grace@example.com ", role: "commenter" });
    assert.equal(result.kind, "ok");
    assert.deepEqual(posted, [{ method: "POST", path: `/deck-api/decks/${TEST_DECK_ID}/members`, body: { email: "grace@example.com", role: "commenter" }, csrf: "csrf-1" }]);
  });

  it("refuses to post something that is not an email address", () => {
    assert.equal(inviteRequestOf({ email: "not an address", role: "viewer" }), null);
    assert.deepEqual(inviteRequestOf({ email: "a@b.c", role: "viewer" }), { email: "a@b.c", role: "viewer" });
  });

  it("link sharing offers only off, viewer and commenter", () => {
    assert.deepEqual(LINK_SHARING_CHOICES.map((choice) => choice.linkSharing), [{ kind: "off" }, { kind: "anyoneSignedIn", role: "viewer" }, { kind: "anyoneSignedIn", role: "commenter" }]);
    const markup = render("owner");
    const radios = [...markup.matchAll(/<input[^>]*name="link-sharing"[^>]*>/g)].map((match) => /value="([a-z]+)"/.exec(match[0])?.[1]);
    assert.deepEqual(radios, ["off", "viewer", "commenter"]);
    assert.ok(/<input[^>]*value="viewer"[^>]*checked=""|<input[^>]*checked=""[^>]*value="viewer"/.test(markup), "the current setting is chosen");
  });

  for (const role of DECK_ROLES) {
    const mayShare = roleAllows({ role, permission: "share" });
    it(`${role}: ${mayShare ? "edits who has access" : "sees the people list read-only"}`, () => {
      const markup = render(role);
      assert.ok(markup.includes("Ada Lovelace") && markup.includes("Grace Hopper"), "everyone sees the people");
      const controls = { selects: /<select/.test(markup), inputs: /<input/.test(markup), invite: />Invite</.test(markup), remove: />Remove</.test(markup), pending: markup.includes("new@example.com") };
      assert.deepEqual(controls, { selects: mayShare, inputs: mayShare, invite: mayShare, remove: mayShare, pending: mayShare });
      if (!mayShare) assert.ok(markup.includes("Anyone signed in with the link can view."), "the link sharing, as a sentence");
    });
  }
});
