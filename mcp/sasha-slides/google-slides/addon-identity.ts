/**
 * What the add-on's server-to-server calls carry, and the identity token audience they are
 * checked against (SPEC.md 21.13).
 *
 * THE AUDIENCE IS MEASURED, NOT CONFIGURED. `ScriptApp.getIdentityToken()` is issued to the OAuth
 * client of the Apps Script project's own auto-created Cloud project (CLAUDE.md: project
 * 342987503423 for the bound script, not this connector's 982862611156), which nobody here can
 * configure or even open (the Cloud console needs 2-step verification).
 *
 * HOW IT WAS MEASURED, and its one caveat. The development deck's bound script ran a temporary
 * function that sent its own `ScriptApp.getOAuthToken()` to Google's tokeninfo: `azp` and `aud`
 * both came back as the client below (e2e/google-slides-addon-live.ts `run-measure`). An identity
 * token from the same project is issued to that same client. A real IDENTITY token could not be
 * minted yet: it needs the `openid` scope in that script's appsscript.json, and the Apps Script
 * settings page in this browser never SAVES "Show appsscript.json" (it ticks, no save request is
 * sent, and a reload shows it unticked: measured with real presses, the input's click, a valid
 * time zone set first, and the JavaScript pointer sequence that does work for this IDE's file
 * menu), so the manifest could not be deployed and `getIdentityToken()` returns null there
 * (measured with a temporary function, 2026-10-15). The first real handoff after
 * that re-consent confirms this value; a mismatch is logged with the token's own `aud`
 * (google-slides-interchange.ts). The published add-on has a different project and needs its own
 * entry here.
 */
import { ADDON_REQUEST_HEADERS } from "../engine/src/contracts/deck-api.ts";
import { unverifiedClaims, type IdentityClaims, type IdentityVerifier } from "./identity-token.ts";

export const ADDON_IDENTITY_AUDIENCES: readonly Readonly<{ audience: string; project: string; measuredOn: string; method: string }>[] = [
  {
    audience: "342987503423-e63ortccvhg0itoufrgukvpq6566jhtn.apps.googleusercontent.com",
    project: "development deck bound script 1GqibbX21wU_8SMuFAC8nWStv6Y8wfrBNfiK1nQnbiawQXuABRNgr9NFo",
    measuredOn: "2026-10-15",
    method: "tokeninfo azp of the project's own access token (granted: drive, presentations, script.container.ui, script.external_request, spreadsheets.readonly)",
  },
  {
    audience: "208631238841-k4qehdn5bavg3g1bk1m04cvbh9ror67o.apps.googleusercontent.com",
    project: "second test deck bound script 108CjW5E50kHgTsAEdrUWDBmwFQ0bxiUys7s7bhtzA5WRwYZIbYstGSTR (deck 1rSamevPmnXhKVIVcBgNx_dNsza8MbR_7xXj_6VlsgIQ)",
    measuredOn: "2026-10-16",
    method: "the connector's own 'wrong audience' log line for this project's identity token (comment access check)",
  },
];

/** Headers Code.gs sends on GET /deck-api/addon/export/<id> and its result (deck-api.ts ADDON_REQUEST_HEADERS). */
export const ADDON_IDENTITY_HEADER = ADDON_REQUEST_HEADERS.identityToken;
export const ADDON_BINDING_SECRET_HEADER = ADDON_REQUEST_HEADERS.bindingSecret;
/** The add-on presentation's current page ids, comma separated, so the plan knows which pages to replace. */
export const ADDON_PAGE_IDS_HEADER = ADDON_REQUEST_HEADERS.presentationPageIds;

/**
 * Two `Utilities.getUuid()` values base64url-encoded are 43 characters; anything much shorter is
 * not a binding secret (editor-code-gs.ts `sashaBindingSecret_`).
 */
export const MINIMUM_BINDING_SECRET_LENGTH = 32;

/**
 * The add-on's identity token checked against every pinned audience: the claims, or null after a
 * warning. Shared by the editor handoff (google-slides-interchange.ts) and the comment access check
 * (comment-bot/comment-access-check.ts), so the two can never disagree about who is asking.
 */
export async function verifyAddonIdentityToken(
  options: Readonly<{ verifier: IdentityVerifier; identityToken: string; warn: (message: string) => void }>,
): Promise<IdentityClaims | null> {
  for (const pinned of ADDON_IDENTITY_AUDIENCES) {
    const verdict = await options.verifier.verify({ token: options.identityToken, audience: pinned.audience });
    if (verdict.kind === "verified") return verdict.claims;
    if (verdict.reason !== "wrong audience") {
      options.warn(`add-on identity token rejected: ${verdict.reason}`);
      return null;
    }
  }
  // The audience is not a secret, and naming it is how a new Apps Script project's client is
  // found and pinned (ADDON_IDENTITY_AUDIENCES above).
  options.warn(`add-on identity token rejected: wrong audience ${JSON.stringify(unverifiedClaims(options.identityToken)?.["aud"] ?? null)}`);
  return null;
}
