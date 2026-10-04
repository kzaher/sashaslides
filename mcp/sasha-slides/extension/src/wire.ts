// The port protocol between the three extension contexts, and the guards that parse it. Both ends
// import these types, so the legs cannot drift apart.
//
//   content script (Google Slides tab)  <--port-->  service worker (broker)  <--port-->  offscreen
//
// The service worker is a BROKER and nothing else, for the reason nanobox's proxy documents: Chrome
// terminates an extension service worker after 30 s of inactivity, after 5 minutes on one request,
// and after 30 s waiting for a fetch response, and since Chrome 114 an idle port is explicitly NOT
// a keep-alive. A Drive poll loop, a cached OAuth token and a user staring at a picker for a minute
// all outlive that. An offscreen document has no lifetime cap, so the loop lives there.

import type { Proposal } from "./observer.ts";
import type { Anomaly } from "./protocol.ts";
import type { SlidesApiRequest } from "./converter-contract.ts";

export const CONTENT_PORT_PREFIX = "sasha-slides-content:";
export const OFFSCREEN_PORT_PREFIX = "sasha-slides-offscreen:";

/** content script -> offscreen document. */
export type Upstream =
  | Readonly<{ type: "hello"; protocolVersion: number; presentationId: string | null; visible: boolean }>
  | Readonly<{ type: "visibility"; visible: boolean }>
  | Readonly<{ type: "request-slide-html"; proposalId: string; index: number }>
  | Readonly<{
      type: "insert";
      proposalId: string;
      /** 1-based, so the render artifact can be named `NN.png` after the slide the user picked. */
      index: number;
      presentationId: string;
      /** Chosen by the content script because the converter had to address the page by id. */
      pageObjectId: string;
      requests: readonly SlidesApiRequest[];
    }>
  | Readonly<{
      type: "decide";
      proposalId: string;
      picked: number | null;
      insertedObjectIds: readonly string[];
      anomalies: readonly Anomaly[];
    }>;

/** offscreen document -> content script. The broker also injects `broker-failed`. */
export type Downstream =
  | Readonly<{ type: "offscreen-ready" }>
  | Readonly<{ type: "proposal"; proposal: Proposal }>
  | Readonly<{ type: "trouble"; message: string }>
  | Readonly<{ type: "slide-html"; proposalId: string; index: number; html: string }>
  | Readonly<{ type: "slide-html-failed"; proposalId: string; index: number; message: string }>
  | Readonly<{
      type: "inserted";
      proposalId: string;
      objectIds: readonly string[];
      /** `render/NN.png`, or null when the best-effort render artifact could not be written. */
      renderArtifact: string | null;
    }>
  | Readonly<{ type: "insert-failed"; proposalId: string; message: string }>
  | Readonly<{ type: "decided"; proposalId: string }>
  | Readonly<{ type: "decide-failed"; proposalId: string; message: string }>
  | Readonly<{ type: "broker-failed"; message: string }>;

/**
 * The deck a Slides tab is showing, or null. `/presentation/d/<id>/edit` is the only URL shape the
 * content script is injected into, so one regex is the whole parse -- and a null means "insert has
 * nowhere to go", which the picker must say rather than guess.
 */
export function presentationIdOf(url: string): string | null {
  const matched = /^https:\/\/docs\.google\.com\/presentation\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/.exec(url);
  return matched === null ? null : (matched[1] ?? null);
}

/**
 * A parse-boundary guard on a value that crossed a port, not a branch on a closed union -- which is
 * why it may compare `type` as a string without an assertNever arm. Callers switch on the narrowed
 * value afterwards.
 */
export function asWireMessage(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record["type"] === "string" ? record : null;
}

export function isUpstream(value: unknown): value is Upstream {
  const record = asWireMessage(value);
  if (record === null) return false;
  switch (record["type"]) {
    case "hello":
    case "visibility":
    case "request-slide-html":
    case "insert":
    case "decide":
      return true;
    default:
      return false;
  }
}
