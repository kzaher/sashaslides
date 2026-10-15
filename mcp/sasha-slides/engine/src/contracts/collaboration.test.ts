// The milestone 2 contract tables are decisions both ends rely on without talking to each other:
// the permission table (server enforces, editor hides), the close codes (server sends, client
// branches), and the API paths (server routes, client calls). These tests pin the properties the
// SPEC states about them, in the order the contract files declare them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOSE_CODE_BY_REASON,
  COLLABORATION_LIMITS,
  DECK_SYNC_PATH_PREFIX,
  DECK_SYNC_SUBPROTOCOL,
  LOCAL_COLLABORATION_STATUS,
  RECONNECT_AFTER_CLOSE,
  type CloseReason,
} from "./collaboration.ts";
import { DECK_PERMISSIONS_BY_ROLE, DECK_ROLES, roleAllows, roleRank, type DeckPermission } from "./deck-access.ts";
import { DECK_API_PATHS, DECK_API_PREFIX, DECK_SESSION_COOKIE_PATH } from "./deck-api.ts";
import type { DeckId } from "./ids.ts";

const PERMISSIONS = Object.keys(DECK_PERMISSIONS_BY_ROLE.owner) as readonly DeckPermission[];

describe("deck access", () => {
  it("every role may read", () => {
    for (const role of DECK_ROLES) assert.equal(roleAllows({ role, permission: "read" }), true, role);
  });

  it("a higher role allows everything a lower role allows (the table is monotonic)", () => {
    for (const higher of DECK_ROLES) {
      for (const lower of DECK_ROLES) {
        if (roleRank(higher) <= roleRank(lower)) continue;
        for (const permission of PERMISSIONS) {
          if (!roleAllows({ role: lower, permission })) continue;
          assert.equal(roleAllows({ role: higher, permission }), true, `${higher} lacks ${permission} that ${lower} has`);
        }
      }
    }
  });

  it("only document writers may approve transition scripts, and only the owner shares or deletes", () => {
    const rows = DECK_ROLES.map((role) => ({
      role,
      approve: roleAllows({ role, permission: "approveTransitionScript" }),
      edit: roleAllows({ role, permission: "editDocument" }),
      share: roleAllows({ role, permission: "share" }),
      deleteDeck: roleAllows({ role, permission: "deleteDeck" }),
    }));
    assert.deepEqual(rows, [
      { role: "owner", approve: true, edit: true, share: true, deleteDeck: true },
      { role: "editor", approve: true, edit: true, share: false, deleteDeck: false },
      { role: "commenter", approve: false, edit: false, share: false, deleteDeck: false },
      { role: "viewer", approve: false, edit: false, share: false, deleteDeck: false },
    ]);
  });
});

describe("the WebSocket protocol", () => {
  it("close codes are distinct application codes (4000-4999)", () => {
    const codes = Object.values(CLOSE_CODE_BY_REASON);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.ok(code >= 4000 && code <= 4999, String(code));
  });

  it("the client stops for good only where retrying cannot help", () => {
    const stops = (Object.keys(RECONNECT_AFTER_CLOSE) as readonly CloseReason[]).filter((reason) => RECONNECT_AFTER_CLOSE[reason] === "stop").sort();
    assert.deepEqual(stops, ["accessRevoked", "deckDeleted", "deckNotFound", "deckUnreadable", "documentSchemaTooNew", "protocolVersionUnsupported"]);
  });

  it("the sync endpoint lives under the session cookie's path, so the upgrade carries the cookie", () => {
    assert.ok(DECK_SYNC_PATH_PREFIX.startsWith(`${DECK_SESSION_COOKIE_PATH}/`));
    assert.equal(DECK_SYNC_SUBPROTOCOL, "sasha-deck.1");
  });

  it("a local deck is online-equivalent and owned", () => {
    assert.deepEqual(LOCAL_COLLABORATION_STATUS, { connection: { kind: "local" }, role: "owner", members: [], unsentChanges: false });
  });

  it("the burst covers at least five seconds of the sustained rate", () => {
    assert.ok(COLLABORATION_LIMITS.messageBurst >= COLLABORATION_LIMITS.messagesPerSecond * 5);
  });
});

describe("the deck API paths", () => {
  it("every API path is under /deck-api, the cookie's path", () => {
    const deckId = "dk_Example01" as DeckId;
    const paths = [
      DECK_API_PATHS.session,
      DECK_API_PATHS.profile,
      DECK_API_PATHS.decks,
      DECK_API_PATHS.deck(deckId),
      DECK_API_PATHS.members(deckId),
      DECK_API_PATHS.googleSlidesImport,
      DECK_API_PATHS.googleSlidesConnect,
      DECK_API_PATHS.googleSlidesExport(deckId),
      DECK_API_PATHS.embedSession,
      DECK_API_PATHS.addonHandoff,
      DECK_API_PATHS.agentSessionRevert(deckId, "as_session01"),
    ];
    for (const path of paths) assert.ok(path.startsWith(`${DECK_API_PREFIX}/`), path);
    assert.equal(DECK_API_PREFIX, DECK_SESSION_COOKIE_PATH);
  });
});
