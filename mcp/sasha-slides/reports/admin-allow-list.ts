/**
 * Who may read defect reports: the site owner, named by address in `SASHA_ADMIN_EMAILS`.
 *
 * Reports can hold a user's slide content (anonymised, but the anonymiser is assumed to fail), so the
 * pages are not open to every signed-in account. The check is an allow-list of addresses, matched
 * against the signed-in account's VERIFIED addresses (`AccountDirectory.verifiedEmails`): the portal
 * stores an address only when the provider vouched for it, so an account cannot claim one.
 *
 * Empty or unset is a valid configuration that admits nobody: the intake still stores reports, and
 * the pages answer every signed-in visitor with "not allowed" until an owner is named.
 */

export type AdminAllowList = Readonly<{ emails: ReadonlySet<string> }>;

export type AdminAllowListParse =
  | Readonly<{ kind: "ok"; allowList: AdminAllowList }>
  | Readonly<{ kind: "error"; message: string }>;

/** Comma- or whitespace-separated addresses, compared lower-cased. A malformed entry fails the start. */
export function parseAdminAllowList(text: string | undefined): AdminAllowListParse {
  const entries = (text ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry)) {
      return { kind: "error", message: `SASHA_ADMIN_EMAILS holds "${entry}", which is not an email address` };
    }
  }
  return { kind: "ok", allowList: { emails: new Set(entries) } };
}

export function isAdmin(options: Readonly<{ allowList: AdminAllowList; verifiedEmails: readonly string[] }>): boolean {
  return options.verifiedEmails.some((email) => options.allowList.emails.has(email.toLowerCase()));
}

/** The first verified address on the allow-list: what a triage entry records as its author. */
export function adminAddressOf(options: Readonly<{ allowList: AdminAllowList; verifiedEmails: readonly string[] }>): string | null {
  return options.verifiedEmails.find((email) => options.allowList.emails.has(email.toLowerCase())) ?? null;
}
