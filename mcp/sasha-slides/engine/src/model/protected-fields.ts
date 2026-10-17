// THE PROTECTED FIELDS OF A DOCUMENT, as the deck server's guard reads and corrects them
// (collaboration.ts header, SPEC.md 21.6): every script's author, approval and the fingerprint of its
// text and purpose -- transitions and scripted build steps alike, they share the store and the rule
// -- and the three `meta` keys that never change after creation.
//
// Key decisions:
//
//  * READ RAW, JUDGE ELSEWHERE. This file is the only place the guard touches Yjs; deciding what to
//    correct is the pure `correctionsFor` in engine/src/server, which compares two of these values.
//    Author and approval are kept as the raw stored values (compared by their JSON), because a
//    malformed value written by a forged client must still count as "changed" -- a parsed view
//    that dropped it would let it through.
//  * WRITES ARE WHOLE VALUES under the caller's origin (REPAIR_ORIGIN on the server), in one
//    transaction, so the correction is one update the room can merge with the offending one.

import * as Y from "yjs";
import { assertNever } from "../contracts/assert-never.ts";
import type { ProtectedMetaKey } from "../contracts/collaboration.ts";
import { scriptFingerprint, type ScriptPurpose, type TransitionApproval } from "../contracts/document.ts";
import type { TransitionScriptId } from "../contracts/ids.ts";
import { META_KEY, TRANSITION_SCRIPT_KEY } from "../contracts/yjs-schema.ts";
import { documentRoots } from "./document-paths.ts";

export type ProtectedScriptFields = Readonly<{
  /** The stored author value, unparsed (see the header). */
  author: unknown;
  /** The stored approval value, unparsed. */
  approval: unknown;
  /**
   * `scriptFingerprint` of the stored script, stylesheet, markup and purpose (a missing source reads
   * as ""; a missing purpose as "transition", what records from before builds mean). Because the
   * purpose is in it, turning an approved build-step script into a transition, or back, is a text
   * change to the guard: the sender becomes its author and the approval is revoked unless they may
   * approve and do.
   */
  fingerprint: string;
}>;

export type ProtectedFields = Readonly<{
  /** `undefined` where the key is absent. */
  meta: Readonly<Record<ProtectedMetaKey, unknown>>;
  scripts: ReadonlyMap<TransitionScriptId, ProtectedScriptFields>;
}>;

export type ProtectedFieldWrite =
  | Readonly<{ kind: "scriptApproval"; scriptId: TransitionScriptId; approval: TransitionApproval }>
  | Readonly<{ kind: "scriptAuthor"; scriptId: TransitionScriptId; author: unknown }>
  /** `undefined` deletes the key (it was absent before the offending update). */
  | Readonly<{ kind: "meta"; key: ProtectedMetaKey; value: unknown }>;

export const PROTECTED_META_KEYS: readonly ProtectedMetaKey[] = ["deckId", "schemaVersion", "createdAt"];

export function readProtectedFields(sharedDocument: Y.Doc): ProtectedFields {
  const roots = documentRoots(sharedDocument);
  const meta: Record<ProtectedMetaKey, unknown> = {
    deckId: roots.meta.get(META_KEY.deckId),
    schemaVersion: roots.meta.get(META_KEY.schemaVersion),
    createdAt: roots.meta.get(META_KEY.createdAt),
  };
  const scripts = new Map<TransitionScriptId, ProtectedScriptFields>();
  roots.transitionScripts.forEach((value, key) => {
    if (!(value instanceof Y.Map)) return;
    // Keys of the transitionScripts root are script ids by construction (command-application.ts);
    // the brand records that, and the guard only ever writes back to the same key.
    scripts.set(key as TransitionScriptId, {
      author: value.get(TRANSITION_SCRIPT_KEY.author),
      approval: value.get(TRANSITION_SCRIPT_KEY.approval),
      fingerprint: storedScriptFingerprint(value),
    });
  });
  return { meta, scripts };
}

/** Writes every correction in ONE transaction under `origin`; a write to a script that is gone is skipped. */
export function writeProtectedFields(options: Readonly<{ sharedDocument: Y.Doc; writes: readonly ProtectedFieldWrite[]; origin: object }>): void {
  if (options.writes.length === 0) return;
  const roots = documentRoots(options.sharedDocument);
  options.sharedDocument.transact(() => {
    for (const write of options.writes) {
      switch (write.kind) {
        case "scriptApproval": {
          const script = roots.transitionScripts.get(write.scriptId);
          if (script instanceof Y.Map) script.set(TRANSITION_SCRIPT_KEY.approval, write.approval);
          break;
        }
        case "scriptAuthor": {
          const script = roots.transitionScripts.get(write.scriptId);
          if (script instanceof Y.Map) script.set(TRANSITION_SCRIPT_KEY.author, write.author);
          break;
        }
        case "meta":
          if (write.value === undefined) roots.meta.delete(META_KEY[write.key]);
          else roots.meta.set(META_KEY[write.key], write.value);
          break;
        default:
          assertNever(write);
      }
    }
  }, options.origin);
}

/**
 * `scriptFingerprint` of a stored script record, read the way `ProtectedScriptFields.fingerprint`
 * describes. Command validation compares an approval's fingerprint against the same reading, so the
 * guard and a command never disagree about what text an approval covers.
 */
export function storedScriptFingerprint(script: Y.Map<unknown>): string {
  const text = (name: string): string => {
    const stored: unknown = script.get(name);
    return typeof stored === "string" ? stored : "";
  };
  return scriptFingerprint({
    script: text(TRANSITION_SCRIPT_KEY.script),
    stylesheet: text(TRANSITION_SCRIPT_KEY.stylesheet),
    markup: text(TRANSITION_SCRIPT_KEY.markup),
    purpose: purposeOf(script.get(TRANSITION_SCRIPT_KEY.purpose)),
  });
}

/** The stored purpose; anything but "animation" reads as "transition" (an unknown value can never claim a build step's approval). */
function purposeOf(stored: unknown): ScriptPurpose {
  return stored === "animation" ? "animation" : "transition";
}
