/**
 * Cookies, as the account portal, the deck sessions and the `/comments/allow` page write and read
 * them: every one `HttpOnly; Secure`, its path and SameSite chosen per cookie. Also the
 * constant-time comparison every secret check here uses, and the signed-value format the two
 * session cookies share.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { asRecord, parseJson } from "./json-values";

export type SameSite = "Lax" | "Strict" | "None";

export function setCookie(
  options: Readonly<{ name: string; value: string; path: string; maxAgeSeconds: number; sameSite: SameSite }>,
): string {
  return `${options.name}=${options.value}; Path=${options.path}; Max-Age=${String(options.maxAgeSeconds)}; HttpOnly; Secure; SameSite=${options.sameSite}`;
}

export function clearCookie(options: Readonly<{ name: string; path: string; sameSite: SameSite }>): string {
  return `${options.name}=; Path=${options.path}; Max-Age=0; HttpOnly; Secure; SameSite=${options.sameSite}`;
}

/** Every value sent under `name`, in the order the browser sent them (most specific path first). */
export function cookieValues(options: Readonly<{ request: IncomingMessage; name: string }>): readonly string[] {
  const header = options.request.headers.cookie;
  if (header === undefined) return [];
  const values: string[] = [];
  for (const pair of header.split(/;\s*/u)) {
    const equals = pair.indexOf("=");
    if (equals > 0 && pair.slice(0, equals) === options.name) values.push(pair.slice(equals + 1));
  }
  return values;
}

/** Compares digests, so neither the length nor the content of the secret leaks by timing. */
export function constantTimeEqual(left: string, right: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text, "utf-8").digest();
  return timingSafeEqual(digest(left), digest(right));
}

export type SignedValues = Readonly<{
  seal(claims: Readonly<Record<string, unknown>>): string;
  /** The claims, or null when the value is malformed or its MAC does not match. */
  open(value: string): Readonly<Record<string, unknown>> | null;
}>;

/**
 * `base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, label + payload))`. The label
 * keeps one cookie from passing as another signed with the same secret; changing either the
 * label or the format signs everyone out.
 */
export function signedValues(options: Readonly<{ secret: string; label: string }>): SignedValues {
  const mac = (payload: string): string => createHmac("sha256", options.secret).update(`${options.label}${payload}`).digest("base64url");
  return {
    seal: (claims) => {
      const payload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
      return `${payload}.${mac(payload)}`;
    },
    open: (value) => {
      const [payload, signature, extra] = value.split(".");
      if (payload === undefined || signature === undefined || extra !== undefined) return null;
      if (!constantTimeEqual(signature, mac(payload))) return null;
      const parsed = parseJson(Buffer.from(payload, "base64url").toString("utf-8"));
      return parsed.kind === "ok" ? asRecord(parsed.value) : null;
    },
  };
}
