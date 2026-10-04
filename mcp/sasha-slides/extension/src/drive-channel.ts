// WHICH WAY THE EXTENSION REACHES DRIVE. PROTOCOL.md's "Identity" section leaves two options open
// and the decision is the user's, so this file is the seam: both options produce the same
// `DriveApi` + `SlidesApi` pair, and nothing above here knows which one it got.
//
//   A  "google-oauth"      the extension talks to Google directly, as the SAME OAuth client as the
//                          MCP server (see google-identity.ts). Drive stays the only transport.
//   B  "localhost-bridge"  the extension talks to the MCP server over localhost; the server does
//                          every Drive call with the credential it already has.
//
// RECOMMENDATION: B. Reasons, in order of weight:
//   1. ZERO new credentials. Option A needs the user to turn their Desktop client into a Web
//      client, add a chromiumapp.org redirect, and then consent a SECOND time from the browser --
//      and if Google refuses the implicit flow for that client, A needs the client secret shipped
//      inside the extension. B needs nothing: the server already has a working token
//      (.auth/tokens.json) and the extension holds no Google credential at all.
//   2. The app-identity trap cannot bite. Under B there is exactly one Drive app, so "an app sees
//      only the files it created" is trivially satisfied -- no possibility of the silent
//      empty-result failure the Identity section warns about.
//   3. It is the proven path in this repo. nanobox/extension already reaches a localhost server
//      from an extension context, including the forbidden-header constraints.
//   4. Latency improves. The server can block on its own Drive poll (or skip Drive entirely for
//      the notification) and push, instead of the browser polling every 5 s.
// The cost of B is honest: the picker only works while the MCP server is running, and the server
// must grow an HTTP surface plus an origin check on it. Under A the picker works whenever Chrome is
// open, which is the one thing A buys.
//
// Both are implemented below. Switching is one key in chrome.storage.local, not a rewrite.

import {
  httpDriveApi,
  httpSlidesApi,
  type DriveApi,
  type DriveFileRef,
  type HttpOutcome,
  type SlidesApi,
} from "./drive-api.ts";
import { chromeWebAuthFlow, systemClock, webAuthFlowTokenSource } from "./google-identity.ts";
import type { Parsed } from "./protocol.ts";

export type ChannelKind = "google-oauth" | "localhost-bridge";

export type Channel = Readonly<{ kind: ChannelKind; drive: DriveApi; slides: SlidesApi }>;

export const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:8777";

/**
 * Option A. `chrome.identity` is reached only through the injected `WebAuthFlow`, so this is also
 * the only place in the extension that names it.
 */
export function googleOAuthChannel({ clientId }: { clientId: string }): Channel {
  const tokens = webAuthFlowTokenSource({ clientId, flow: chromeWebAuthFlow(), clock: systemClock });
  return { kind: "google-oauth", drive: httpDriveApi({ tokens }), slides: httpSlidesApi({ tokens }) };
}

/**
 * Option B. Every call becomes one POST to the MCP server, which performs it with the credential it
 * already holds. The request shape is this extension's proposal, not a contract yet -- one JSON
 * envelope per interface method, so the server implements eight handlers and nothing else changes.
 */
export function localhostBridgeChannel({ origin }: { origin: string }): Channel {
  const call = async <TValue>(method: string, payload: unknown): Promise<HttpOutcome<TValue>> => {
    try {
      const response = await fetch(`${origin}/drive-channel/${method}`, {
        method: "POST",
        // `Origin` cannot be set from here (it is a forbidden request-header name and
        // Headers.append is a silent no-op for it), so the server must authenticate the caller by
        // the shared token below, never by the Origin header.
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      if (response.status === 401) return { kind: "unauthorized", message: text.slice(0, 400) };
      if (!response.ok) return { kind: "failed", status: response.status, message: text.slice(0, 400) };
      return { kind: "ok", value: JSON.parse(text) as TValue };
    } catch (cause) {
      return {
        kind: "failed",
        status: null,
        message: `the sasha-slides MCP server is not reachable on ${origin} (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      };
    }
  };

  const drive: DriveApi = {
    listByRoles: (spec) => call<readonly DriveFileRef[]>("listByRoles", spec),
    downloadText: (fileId) => call<string>("downloadText", { fileId }),
    createTextFile: (spec) => call<DriveFileRef>("createTextFile", spec),
    createBinaryFile: async (spec) =>
      call<DriveFileRef>("createBinaryFile", { ...spec, base64: await base64Of(spec.bytes), bytes: undefined }),
    ensureChildFolder: (spec) => call<DriveFileRef>("ensureChildFolder", spec),
  };
  const slides: SlidesApi = {
    batchUpdate: (spec) => call<readonly string[]>("batchUpdate", spec),
    pageThumbnailPng: async (spec) => {
      const encoded = await call<string>("pageThumbnailPng", spec);
      if (encoded.kind !== "ok") return encoded;
      return { kind: "ok", value: blobOfBase64(encoded.value) };
    },
  };
  return { kind: "localhost-bridge", drive, slides };
}

export function isChannelKind(candidate: string): candidate is ChannelKind {
  // A parse-boundary guard on a stored string, so it compares rather than switching exhaustively.
  return candidate === "google-oauth" || candidate === "localhost-bridge";
}

/** JSON cannot carry bytes, so the bridge leg base64s them. One encode per render artifact. */
async function base64Of(bytes: Blob): Promise<string> {
  const buffer = await bytes.arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function blobOfBase64(encoded: string): Blob {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let position = 0; position < binary.length; position++) bytes[position] = binary.charCodeAt(position);
  return new Blob([bytes], { type: "image/png" });
}

export type ChannelChoice = Readonly<{ kind: ChannelKind; clientId: string; bridgeOrigin: string }>;

/** Reads the choice out of storage. Defaults to the recommendation, so nothing needs configuring. */
export async function readChannelChoice(): Promise<Parsed<ChannelChoice>> {
  const stored = await chrome.storage.local.get(["driveChannel", "oauthClientId", "bridgeOrigin"]);
  const requested = stored["driveChannel"];
  const kind = typeof requested === "string" && isChannelKind(requested) ? requested : "localhost-bridge";
  const clientId = typeof stored["oauthClientId"] === "string" ? stored["oauthClientId"] : "";
  const bridgeOrigin = typeof stored["bridgeOrigin"] === "string" ? stored["bridgeOrigin"] : DEFAULT_BRIDGE_ORIGIN;
  if (kind === "google-oauth" && clientId === "") {
    return {
      kind: "invalid",
      reason:
        "driveChannel is 'google-oauth' but no oauthClientId is set. It must be the SAME client id " +
        "the MCP server uses (.auth/google_oauth.json); a different one sees none of its files.",
    };
  }
  return { kind: "ok", value: { kind, clientId, bridgeOrigin } };
}

export function openChannel(choice: ChannelChoice): Channel {
  switch (choice.kind) {
    case "google-oauth":
      return googleOAuthChannel({ clientId: choice.clientId });
    case "localhost-bridge":
      return localhostBridgeChannel({ origin: choice.bridgeOrigin });
    default:
      return assertNeverChannel(choice.kind);
  }
}

function assertNeverChannel(value: never): never {
  throw new Error(`Unhandled channel: ${String(value)}`);
}
