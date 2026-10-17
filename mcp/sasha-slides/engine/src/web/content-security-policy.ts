// THE PAGES' CONTENT SECURITY POLICY, exactly as SPEC.md 21.8 states it, and its embedded variant
// for `/deck/<id>?embed=addon`, which differs only in `frame-ancestors` (ADDON_FRAME_ANCESTORS:
// Google Slides and the add-on's HtmlService sandbox). build-web.ts writes both into the manifest;
// the connector sends them, so the server never composes a policy of its own.
//
// Why each directive: scripts and stylesheets only from our own origin (no inline script at all;
// the configuration block is inert JSON); Tidepool's font from Google Fonts; `style-src-attr
// 'unsafe-inline'` for the renderer's inline slide styles; images from our origin, object
// addresses (asset bytes fetched with the session) and data addresses; the WebSocket and the API
// on our own origin; the runner frame on our own origin until a second registrable domain exists;
// and no framing at all, except by the add-on.
//
// Two additions the integrated run in Chrome showed were needed (SPEC.md 21.8 records both):
//
//  * THE PRESENTER'S STYLE ELEMENTS ARE ALLOWED BY HASH, not by 'unsafe-inline'. The presentation,
//    the transition preview and the speaker window each add one fixed `<style>` (the presenter is
//    frozen, so it keeps doing that); `style-src` names the SHA-256 of exactly those texts, which
//    build-web.ts computes from the same constants, so any other inline stylesheet stays blocked.
//  * THE PRESENTER FETCHES FONT FILES for the transition runner (compose-editor.ts
//    `googleFontFiles`: the stylesheet from fonts.googleapis.com, the files from
//    fonts.gstatic.com), so `connect-src` names both; without them a scripted transition shows
//    the slides in a fallback font.

import { ADDON_FRAME_ANCESTORS } from "../contracts/deck-api.ts";
import { PRESENTER_RULES, SPEAKER_VIEW_STYLE_TEXT } from "../presenter/view/presenter-stylesheet.ts";

/**
 * The exact text of every `<style>` element the presenter inserts: presentation.tsx and
 * transition-preview.tsx and build-preview.tsx render PRESENTER_RULES; speaker-view.tsx inserts
 * SPEAKER_VIEW_STYLE_TEXT (both exported by presenter-stylesheet.ts, so this is the same value).
 */
export const PRESENTER_INLINE_STYLE_TEXTS: readonly string[] = [PRESENTER_RULES, SPEAKER_VIEW_STYLE_TEXT];

/** Both pages' policies, given the base64 SHA-256 of each text in PRESENTER_INLINE_STYLE_TEXTS. */
export function deckPagesContentSecurityPolicies(options: Readonly<{ inlineStyleHashes: readonly string[] }>): Readonly<{ standalone: string; embedded: string }> {
  const hashSources = options.inlineStyleHashes.map((hash) => `'sha256-${hash}'`).join(" ");
  const shared = [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' https://fonts.googleapis.com ${hashSources}`,
    "style-src-attr 'unsafe-inline'",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' blob: data:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  return {
    standalone: [...shared, "frame-ancestors 'none'"].join("; "),
    embedded: [...shared, `frame-ancestors ${ADDON_FRAME_ANCESTORS.join(" ")}`].join("; "),
  };
}
