/**
 * What the add-on's "can Sasha answer comments on this deck?" check says, shared by the connector
 * (`comment-access-check.ts`, which answers it) and the add-on (`addon/src/comment-access-state.ts`,
 * which draws the card from it and keeps a copy in the sidebar seed).
 *
 * WHY ITS OWN FILE: the add-on bundles everything it imports into a 500 KB page, and the checker
 * imports `node:http`; this file imports nothing, so both sides read one definition.
 */

/** `POST` from Code.gs (UrlFetchApp): `{ identityToken, presentationId, bindingSecret }`. */
export const COMMENT_ACCESS_PATH = "/comments/access";

/**
 * The four answers. `needsAllow` carries the `/comments/allow?deck=<id>` page that lets the user's
 * own grant reach the deck; `notConnected` means the connector holds no usable Google grant for
 * this Google account, which only connecting Sasha Slides to an assistant with it can fix.
 */
export type CommentAccessAnswer =
  | Readonly<{ access: "ready" }>
  | Readonly<{ access: "needsAllow"; allowUrl: string }>
  | Readonly<{ access: "notConnected"; connectUrl: string; explanation: string }>
  | Readonly<{ access: "viewOnly" }>;

/** The answer from an untrusted value (a reply, a remembered copy), or null when it is not one. */
export function parseCommentAccessAnswer(value: unknown): CommentAccessAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const access: unknown = Reflect.get(value, "access");
  switch (access) {
    case "ready":
    case "viewOnly":
      return { access };
    case "needsAllow": {
      const allowUrl = httpsUrlOf(Reflect.get(value, "allowUrl"));
      return allowUrl === null ? null : { access, allowUrl };
    }
    case "notConnected": {
      const connectUrl = httpsUrlOf(Reflect.get(value, "connectUrl"));
      const explanation: unknown = Reflect.get(value, "explanation");
      return connectUrl === null || typeof explanation !== "string" ? null : { access, connectUrl, explanation };
    }
    default:
      return null;
  }
}

/** Only an https address is ever put behind a link the sidebar opens. */
function httpsUrlOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
