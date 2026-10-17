/**
 * Email and password sign-in for the account portal: sign up, confirm the address, sign in,
 * and reset a forgotten password. The portal (`account-portal.ts`) owns the HTTP side and
 * the pages; this file owns the rules, and answers with outcomes for the portal to render.
 *
 * The account key fits the directory's `provider:subject` model: provider `email`, subject
 * the SHA-256 (hex) of the normalised address (trimmed, NFC, lowercased). The address itself
 * is never a key and never written in clear: the store holds the hash, the directory seals
 * the address with the account's own key for the "a•••@example.com" hint, and erasing the
 * account removes the password record with the link (`account-eraser.ts`).
 *
 * What is kept where:
 *
 *  - **Passwords**: confirmed accounts only, in `passwordCredentials` (the `--store` file),
 *    keyed `email:<subject>`, as an scrypt hash with its own salt and cost
 *    (`password-hashing.ts`).
 *  - **Unconfirmed sign-ups, confirmation and reset links**: in this process's memory. Links
 *    live 30 minutes, unconfirmed sign-ups a day; a restart forgets them, which costs the
 *    person one more request. Only the SHA-256 of a link's token is held, so a heap dump
 *    yields no usable link.
 *
 * Attacks and their defences:
 *
 *  - **Account enumeration.** Sign-up answers "check your email" whether or not the address
 *    has an account (an existing one gets a notice instead of a link); reset answers the
 *    same for every address and mails only real accounts; sign-in has one message for
 *    "no such address" and "wrong password". Timing follows: sign-up always hashes, an
 *    unknown sign-in verifies against a dummy hash, and mail goes out in the background
 *    (`runInBackground`) so the Gmail round trip does not show in the response time.
 *    Throttles count every request, not only those that sent mail, so a 429 says nothing
 *    about the address either.
 *  - **Squatting an address.** An unconfirmed sign-up does not hold the address: a later
 *    sign-up replaces it (and retires its link), and it expires after a day.
 *  - **Pre-account takeover** (an attacker signs up the victim's address with a password of
 *    their choosing and hopes the victim clicks the link). The mail says to ignore it if you
 *    did not ask, and the link only confirms on an explicit button press on our page, so a
 *    mail scanner fetching links cannot activate anything. A victim who later uses
 *    "forgot password" sets their own.
 *  - **Token guessing and reuse.** Tokens are 256 random bits, single use, 30 minutes. Each
 *    address has at most one live link of each kind: a new one retires the old.
 *  - **Password guessing.** Ten attempts per client address and ten per account per 15
 *    minutes, counted before the password is even hashed.
 *  - **Mail bombing and spam relaying.** Mail is limited per client address (3 per 15
 *    minutes, 10 a day), per recipient (3 an hour), and globally (400 a day, under Gmail's
 *    500 a day for a consumer account); recipients are validated by `gmail-sender.ts`.
 *  - **Resource exhaustion by long passwords.** At most 256 characters, checked before
 *    hashing.
 *
 * ADDING an email and password to an account that is already signed in (`startLink`,
 * `confirmLink`) mails the same kind of single-use link, and the link only works for the
 * account that asked, in a browser signed in to it. Without that binding, an attacker could
 * ask to add the VICTIM's address to the ATTACKER's account and wait for the victim to press
 * the button in the mail: the attacker's account would then hold a verified copy of the
 * victim's address, and deck invitations sent to it would land there. An address that
 * already signs in to an account gets a notice instead of a link (merging accounts is not
 * supported), and the answer on the page is the same either way, so the form cannot be used
 * to learn which addresses have accounts.
 */
import { createHash } from "node:crypto";
import { emailHint, type AccountDirectory, type IdentityLinkOutcome } from "./account-directory";
import type { AccountId } from "./account-vault";
import { isMailboxAddress, type MailSender, type OutgoingMail } from "./gmail-sender";
import { createExpiringTable } from "./expiring-table";
import { escapeHtml } from "./html-pages";
import type { PasswordCredential, RecordStore } from "./oauth-store";
import { hashPassword, isWeakerThan, verifyPassword, type ScryptCost } from "./password-hashing";
import type { Throttle, ThrottleDecision, ThrottleRule } from "./request-throttle";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export const EMAIL_PROVIDER = "email";
export const EMAIL_PROVIDER_DISPLAY_NAME = "Email and password";
export const EMAIL_LINK_LIFETIME_MS = 30 * 60 * 1000;
export const UNCONFIRMED_SIGNUP_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordLimits = Readonly<{
  mailPerClient: ThrottleRule;
  mailPerClientDaily: ThrottleRule;
  mailPerRecipient: ThrottleRule;
  mailGlobalDaily: ThrottleRule;
  signInPerClient: ThrottleRule;
  signInPerAccount: ThrottleRule;
}>;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const DEFAULT_PASSWORD_LIMITS: PasswordLimits = {
  mailPerClient: { name: "mail per client address, 15 minutes", limit: 3, windowMs: 15 * MINUTE_MS },
  mailPerClientDaily: { name: "mail per client address, a day", limit: 10, windowMs: DAY_MS },
  mailPerRecipient: { name: "mail per recipient, an hour", limit: 3, windowMs: 60 * MINUTE_MS },
  mailGlobalDaily: { name: "all mail, a day", limit: 400, windowMs: DAY_MS },
  signInPerClient: { name: "sign-in attempts per client address, 15 minutes", limit: 10, windowMs: 15 * MINUTE_MS },
  signInPerAccount: { name: "sign-in attempts per account, 15 minutes", limit: 10, windowMs: 15 * MINUTE_MS },
};

/** Why a form was refused. Each says something about the input, never about an account. */
export type InputProblem = "address" | "password-too-short" | "password-too-long";

export type MailRequestOutcome =
  /** Said whatever the address: "if it can be used, a message is on its way". */
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "invalid"; problem: InputProblem }>
  | Readonly<{ kind: "throttled"; retryAfterMs: number }>;

export type SignInAttempt =
  | Readonly<{ kind: "signed-in"; accountId: AccountId }>
  /** Unknown address or wrong password: deliberately one case. */
  | Readonly<{ kind: "rejected" }>
  /** The right password for a sign-up whose address is not confirmed yet; a new link was sent. */
  | Readonly<{ kind: "unconfirmed" }>
  | Readonly<{ kind: "throttled"; retryAfterMs: number }>;

export type LinkOutcome =
  | Readonly<{ kind: "signed-in"; accountId: AccountId }>
  /** Unknown, used, retired by a newer one, or expired. */
  | Readonly<{ kind: "invalid-link" }>
  | Readonly<{ kind: "invalid"; problem: InputProblem }>;

export type LinkPurpose = "confirm" | "reset" | "link";

export type EmailLinkOutcome =
  /** `IdentityLinkOutcome` from the directory, the password saved when it is `linked`. */
  | IdentityLinkOutcome
  /** Unknown, used, retired by a newer one, or expired. */
  | Readonly<{ kind: "invalid-link" }>
  /** The browser is signed in to a different account than the one that asked; the link still works. */
  | Readonly<{ kind: "wrong-account" }>;

export type PasswordSignIn = Readonly<{
  signUp(options: Readonly<{ email: string; password: string; clientAddress: string }>): Promise<MailRequestOutcome>;
  signIn(options: Readonly<{ email: string; password: string; clientAddress: string }>): Promise<SignInAttempt>;
  requestReset(options: Readonly<{ email: string; clientAddress: string }>): Promise<MailRequestOutcome>;
  /** Whether a link still works, without using it: the page behind the link asks first. */
  isLinkLive(options: Readonly<{ purpose: LinkPurpose; token: string }>): boolean;
  confirmAddress(options: Readonly<{ token: string }>): Promise<LinkOutcome>;
  completeReset(options: Readonly<{ token: string; password: string }>): Promise<LinkOutcome>;
  /** Mails a link that adds this address and password to `accountId`. Same answer for any address. */
  startLink(
    options: Readonly<{ accountId: AccountId; email: string; password: string; clientAddress: string }>,
  ): Promise<MailRequestOutcome>;
  /** Uses the mailed link, only for the account that asked for it. */
  confirmLink(options: Readonly<{ token: string; accountId: AccountId }>): Promise<EmailLinkOutcome>;
}>;

/** The `accountLinks` / `passwordCredentials` key for an email subject. */
export function emailLinkKey(subject: string): string {
  return `${EMAIL_PROVIDER}:${subject}`;
}

/** Trimmed, NFC, lowercase; null when it is not a plain address. */
export function normaliseEmail(text: string): string | null {
  const normalised = text.trim().normalize("NFC").toLowerCase();
  return isMailboxAddress(normalised) ? normalised : null;
}

export function emailSubject(normalisedEmail: string): string {
  return createHash("sha256").update(normalisedEmail, "utf-8").digest("hex");
}

export function createPasswordSignIn(
  options: Readonly<{
    publicUrl: string;
    credentials: RecordStore<PasswordCredential>;
    directory: AccountDirectory;
    mailSender: MailSender;
    throttle: Throttle;
    limits: PasswordLimits;
    now: () => Date;
    /** URL-safe, at least 256 bits: link tokens are drawn from it. */
    randomToken: () => string;
    scryptCost: ScryptCost;
    /** Production: fire and forget. Tests: collect, to await the mail. Never rejects. */
    runInBackground: (work: Promise<void>) => void;
    warn: (message: string) => void;
  }>,
): PasswordSignIn {
  const { credentials, directory, mailSender, throttle, limits, now, randomToken, scryptCost, runInBackground, warn } = options;
  const baseUrl = options.publicUrl.replace(/\/+$/, "");
  const clock = (): number => now().getTime();
  const unconfirmed = createExpiringTable<UnconfirmedSignUp>({ now: clock, capacity: MAX_UNCONFIRMED });
  /** Addresses being added to a signed-in account, keyed by subject; a newer request replaces an older one. */
  const pendingLinks = createExpiringTable<PendingEmailLink>({ now: clock, capacity: MAX_UNCONFIRMED });
  const links: Readonly<Record<LinkPurpose, SingleUseLinks>> = {
    confirm: singleUseLinks({ now, randomToken, lifetimeMs: EMAIL_LINK_LIFETIME_MS }),
    reset: singleUseLinks({ now, randomToken, lifetimeMs: EMAIL_LINK_LIFETIME_MS }),
    link: singleUseLinks({ now, randomToken, lifetimeMs: EMAIL_LINK_LIFETIME_MS }),
  };
  // Verified against when the address is unknown, so that answer takes as long as a real one.
  let dummyHash: Promise<string> | null = null;

  function admitMail(request: Readonly<{ clientAddress: string; subject: string }>): ThrottleDecision {
    return throttle.admit({
      checks: [
        { rule: limits.mailPerClient, key: request.clientAddress },
        { rule: limits.mailPerClientDaily, key: request.clientAddress },
        { rule: limits.mailPerRecipient, key: request.subject },
        { rule: limits.mailGlobalDaily, key: "all" },
      ],
    });
  }

  function deliver(delivery: Readonly<{ mail: OutgoingMail; what: string }>): void {
    const { mail, what } = delivery;
    runInBackground(
      mailSender.send(mail).then(
        (outcome) => {
          switch (outcome.kind) {
            case "sent":
              return;
            case "failed":
              warn(`account portal: ${what} mail to ${emailHint(mail.to)} was not sent: ${outcome.reason}`);
              return;
            default:
              assertNever(outcome);
          }
        },
        (cause: unknown) => warn(`account portal: ${what} mail failed: ${cause instanceof Error ? cause.message : String(cause)}`),
      ),
    );
  }

  function sendConfirmation(signUp: UnconfirmedSignUp): void {
    const token = links.confirm.issue(signUp.subject);
    deliver({ mail: confirmationMail({ to: signUp.email, link: `${baseUrl}/account/email/verify?token=${token}` }), what: "confirmation" });
  }

  function signInAs(identity: Readonly<{ subject: string; email: string }>): Promise<AccountId> {
    return directory.findOrCreateByIdentity({ provider: EMAIL_PROVIDER, subject: identity.subject, email: identity.email });
  }

  return {
    signUp: async ({ email, password, clientAddress }) => {
      const normalised = normaliseEmail(email);
      if (normalised === null) return { kind: "invalid", problem: "address" };
      const passwordProblem = checkPassword(password);
      if (passwordProblem !== null) return { kind: "invalid", problem: passwordProblem };
      const subject = emailSubject(normalised);
      const admitted = admitMail({ clientAddress, subject });
      if (admitted.kind === "refused") return { kind: "throttled", retryAfterMs: admitted.retryAfterMs };
      // Hashed on both paths below, so an existing address does not answer faster.
      const passwordHash = await hashPassword({ password, cost: scryptCost });
      if ((await credentials.get({ key: emailLinkKey(subject) })) !== null) {
        deliver({ mail: alreadyRegisteredMail({ to: normalised, baseUrl }), what: "already-registered notice" });
        return { kind: "accepted" };
      }
      const signUp: UnconfirmedSignUp = { subject, email: normalised, passwordHash };
      unconfirmed.put({ key: subject, value: signUp, lifetimeMilliseconds: UNCONFIRMED_SIGNUP_LIFETIME_MS });
      sendConfirmation(signUp);
      return { kind: "accepted" };
    },

    signIn: async ({ email, password, clientAddress }) => {
      const normalised = normaliseEmail(email);
      const subject = emailSubject(normalised ?? email);
      const admitted = throttle.admit({
        checks: [
          { rule: limits.signInPerClient, key: clientAddress },
          { rule: limits.signInPerAccount, key: subject },
        ],
      });
      if (admitted.kind === "refused") return { kind: "throttled", retryAfterMs: admitted.retryAfterMs };
      if (normalised === null || password.length > MAX_PASSWORD_LENGTH) return { kind: "rejected" };
      const credential = await credentials.get({ key: emailLinkKey(subject) });
      if (credential !== null) {
        const check = await verifyPassword({ password, encoded: credential.passwordHash });
        if (check.kind !== "match") return { kind: "rejected" };
        if (isWeakerThan({ encoded: credential.passwordHash, cost: scryptCost })) {
          const passwordHash = await hashPassword({ password, cost: scryptCost });
          await credentials.put({ key: emailLinkKey(subject), value: { ...credential, passwordHash, updatedAtMs: now().getTime() } });
        }
        return { kind: "signed-in", accountId: await signInAs({ subject, email: normalised }) };
      }
      const pending = unconfirmed.get(subject);
      if (pending !== null) {
        if ((await verifyPassword({ password, encoded: pending.passwordHash })).kind !== "match") return { kind: "rejected" };
        // A resend is still mail: it is sent only when the mail limits allow.
        if (admitMail({ clientAddress, subject }).kind === "admitted") sendConfirmation(pending);
        return { kind: "unconfirmed" };
      }
      dummyHash ??= hashPassword({ password: "no account has this password", cost: scryptCost });
      await verifyPassword({ password, encoded: await dummyHash });
      return { kind: "rejected" };
    },

    requestReset: async ({ email, clientAddress }) => {
      const normalised = normaliseEmail(email);
      if (normalised === null) return { kind: "invalid", problem: "address" };
      const subject = emailSubject(normalised);
      const admitted = admitMail({ clientAddress, subject });
      if (admitted.kind === "refused") return { kind: "throttled", retryAfterMs: admitted.retryAfterMs };
      if ((await credentials.get({ key: emailLinkKey(subject) })) !== null) {
        const token = links.reset.issue(subject);
        deliver({ mail: resetMail({ to: normalised, link: `${baseUrl}/account/email/reset?token=${token}` }), what: "password reset" });
        return { kind: "accepted" };
      }
      // Someone who signed up but lost the confirmation mail: "forgot password" resends it.
      const pending = unconfirmed.get(subject);
      if (pending !== null) sendConfirmation(pending);
      return { kind: "accepted" };
    },

    isLinkLive: ({ purpose, token }) => links[purpose].isLive(token),

    confirmAddress: async ({ token }) => {
      const subject = links.confirm.take(token);
      const pending = subject === null ? null : unconfirmed.get(subject);
      if (subject === null || pending === null) return { kind: "invalid-link" };
      unconfirmed.delete(subject);
      const key = emailLinkKey(subject);
      // A confirmed account already holding the address keeps its own password.
      if ((await credentials.get({ key })) === null) {
        await credentials.put({ key, value: { subject, passwordHash: pending.passwordHash, updatedAtMs: now().getTime() } });
      }
      return { kind: "signed-in", accountId: await signInAs({ subject, email: pending.email }) };
    },

    completeReset: async ({ token, password }) => {
      // Checked before the link is used, so a too-short password does not cost the link.
      const passwordProblem = checkPassword(password);
      if (passwordProblem !== null) return links.reset.isLive(token) ? { kind: "invalid", problem: passwordProblem } : { kind: "invalid-link" };
      const subject = links.reset.take(token);
      const key = subject === null ? null : emailLinkKey(subject);
      const credential = key === null ? null : await credentials.get({ key });
      if (subject === null || key === null || credential === null) return { kind: "invalid-link" };
      const passwordHash = await hashPassword({ password, cost: scryptCost });
      await credentials.put({ key, value: { ...credential, passwordHash, updatedAtMs: now().getTime() } });
      // The directory already holds this account's sealed address; null here never overwrites it.
      return { kind: "signed-in", accountId: await directory.findOrCreateByIdentity({ provider: EMAIL_PROVIDER, subject, email: null }) };
    },

    startLink: async ({ accountId, email, password, clientAddress }) => {
      const normalised = normaliseEmail(email);
      if (normalised === null) return { kind: "invalid", problem: "address" };
      const passwordProblem = checkPassword(password);
      if (passwordProblem !== null) return { kind: "invalid", problem: passwordProblem };
      const subject = emailSubject(normalised);
      const admitted = admitMail({ clientAddress, subject });
      if (admitted.kind === "refused") return { kind: "throttled", retryAfterMs: admitted.retryAfterMs };
      // Hashed on both paths below, as in sign-up, so a taken address does not answer faster.
      const passwordHash = await hashPassword({ password, cost: scryptCost });
      if ((await credentials.get({ key: emailLinkKey(subject) })) !== null) {
        deliver({ mail: alreadyInUseMail({ to: normalised, baseUrl }), what: "address-in-use notice" });
        return { kind: "accepted" };
      }
      pendingLinks.put({ key: subject, value: { accountId, email: normalised, passwordHash }, lifetimeMilliseconds: EMAIL_LINK_LIFETIME_MS });
      const token = links.link.issue(subject);
      deliver({ mail: addAddressMail({ to: normalised, link: `${baseUrl}/account/email/link?token=${token}` }), what: "add-address" });
      return { kind: "accepted" };
    },

    confirmLink: async ({ token, accountId }) => {
      const subject = links.link.subjectOf(token);
      const pending = subject === null ? null : pendingLinks.get(subject);
      if (subject === null || pending === null) return { kind: "invalid-link" };
      // Checked before the link is used, so opening it in the wrong browser does not cost it.
      if (pending.accountId !== accountId) return { kind: "wrong-account" };
      links.link.take(token);
      pendingLinks.delete(subject);
      const outcome = await directory.linkIdentity({ accountId, provider: EMAIL_PROVIDER, subject, email: pending.email });
      // The password only once the address is this account's: never over another account's.
      if (outcome.kind === "linked") {
        await credentials.put({ key: emailLinkKey(subject), value: { subject, passwordHash: pending.passwordHash, updatedAtMs: now().getTime() } });
      }
      return outcome;
    },
  };
}

// ---------------------------------------------------------------- input rules

/** Length in characters (code points), the only rule: no composition requirements. */
function checkPassword(password: string): InputProblem | null {
  const length = Array.from(password.normalize("NFC")).length;
  if (length < MIN_PASSWORD_LENGTH) return "password-too-short";
  if (length > MAX_PASSWORD_LENGTH) return "password-too-long";
  return null;
}

// ---------------------------------------------------------------- unconfirmed sign-ups and links

type UnconfirmedSignUp = Readonly<{ subject: string; email: string; passwordHash: string }>;

type PendingEmailLink = Readonly<{ accountId: AccountId; email: string; passwordHash: string }>;

/** Bounds memory against a flood of sign-ups that never confirm; the oldest go first. */
const MAX_UNCONFIRMED = 10_000;
const MAX_LINKS = 10_000;

type SingleUseLinks = Readonly<{
  /** A new token for `subject`; any earlier token for it stops working. */
  issue(subject: string): string;
  isLive(token: string): boolean;
  /** The subject of a live token, without using it up; null when it is not live. */
  subjectOf(token: string): string | null;
  /** The subject, once; null when unknown, retired, expired or already taken. */
  take(token: string): string | null;
}>;

function singleUseLinks(options: Readonly<{ now: () => Date; randomToken: () => string; lifetimeMs: number }>): SingleUseLinks {
  const { now, randomToken, lifetimeMs } = options;
  const byTokenHash = new Map<string, Readonly<{ subject: string; expiresAtMs: number }>>();
  const tokenHashBySubject = new Map<string, string>();

  const live = (token: string): Readonly<{ tokenHash: string; subject: string }> | null => {
    const tokenHash = hashToken(token);
    const entry = byTokenHash.get(tokenHash);
    if (entry === undefined) return null;
    if (entry.expiresAtMs > now().getTime()) return { tokenHash, subject: entry.subject };
    forget({ tokenHash, subject: entry.subject });
    return null;
  };

  const forget = (entry: Readonly<{ tokenHash: string; subject: string }>): void => {
    byTokenHash.delete(entry.tokenHash);
    if (tokenHashBySubject.get(entry.subject) === entry.tokenHash) tokenHashBySubject.delete(entry.subject);
  };

  return {
    issue: (subject) => {
      const previous = tokenHashBySubject.get(subject);
      if (previous !== undefined) byTokenHash.delete(previous);
      const nowMs = now().getTime();
      for (const [tokenHash, entry] of byTokenHash) {
        if (entry.expiresAtMs <= nowMs) forget({ tokenHash, subject: entry.subject });
      }
      while (byTokenHash.size >= MAX_LINKS) {
        const oldest = byTokenHash.entries().next();
        if (oldest.done === true) break;
        forget({ tokenHash: oldest.value[0], subject: oldest.value[1].subject });
      }
      const token = randomToken();
      const tokenHash = hashToken(token);
      byTokenHash.set(tokenHash, { subject, expiresAtMs: nowMs + lifetimeMs });
      tokenHashBySubject.set(subject, tokenHash);
      return token;
    },
    isLive: (token) => live(token) !== null,
    subjectOf: (token) => live(token)?.subject ?? null,
    take: (token) => {
      const entry = live(token);
      if (entry === null) return null;
      forget(entry);
      return entry.subject;
    },
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("base64url");
}

// ---------------------------------------------------------------- mail

const SIGNATURE = "Sasha Slides · https://sashaslides.com";

function confirmationMail(options: Readonly<{ to: string; link: string }>): OutgoingMail {
  return mail({
    to: options.to,
    subject: "Confirm your email address for Sasha Slides",
    paragraphs: [
      "Someone, hopefully you, asked to create a Sasha Slides account with this email address.",
      "To confirm the address and sign in, open this link within 30 minutes and press the button on the page:",
    ],
    link: options.link,
    after: ["If you did not ask for this, ignore this message: no account is created unless the link is used."],
  });
}

function alreadyRegisteredMail(options: Readonly<{ to: string; baseUrl: string }>): OutgoingMail {
  return mail({
    to: options.to,
    subject: "You already have a Sasha Slides account",
    paragraphs: [
      "Someone, hopefully you, tried to create a Sasha Slides account with this email address, but it already has one, so nothing was changed.",
      "To sign in, use your existing password. If you have forgotten it, set a new one here:",
    ],
    link: `${options.baseUrl}/account/email/forgot`,
    after: ["If this was not you, you can ignore this message."],
  });
}

function addAddressMail(options: Readonly<{ to: string; link: string }>): OutgoingMail {
  return mail({
    to: options.to,
    subject: "Add this email address to your Sasha Slides account",
    paragraphs: [
      "Someone signed in to Sasha Slides, hopefully you, asked to add this email address and a password as a way to sign in to their account.",
      "To add it, open this link within 30 minutes in the browser where you are signed in, and press the button on the page:",
    ],
    link: options.link,
    after: ["If you did not ask for this, ignore this message: the address is not added unless the link is used."],
  });
}

function alreadyInUseMail(options: Readonly<{ to: string; baseUrl: string }>): OutgoingMail {
  return mail({
    to: options.to,
    subject: "This email address already has a Sasha Slides account",
    paragraphs: [
      "Someone signed in to Sasha Slides, hopefully you, asked to add this email address to their account, but the address already signs in to a different Sasha Slides account, so nothing was changed.",
      "Merging two accounts is not supported yet. To use this address, sign in with it and its password.",
    ],
    link: `${options.baseUrl}/account`,
    after: ["If this was not you, you can ignore this message."],
  });
}

function resetMail(options: Readonly<{ to: string; link: string }>): OutgoingMail {
  return mail({
    to: options.to,
    subject: "Reset your Sasha Slides password",
    paragraphs: ["Someone, hopefully you, asked to reset the password of the Sasha Slides account for this email address.", "To choose a new password, open this link within 30 minutes:"],
    link: options.link,
    after: ["If you did not ask for this, ignore this message: your password stays as it is."],
  });
}

function mail(
  options: Readonly<{ to: string; subject: string; paragraphs: readonly string[]; link: string; after: readonly string[] }>,
): OutgoingMail {
  const { paragraphs, link, after } = options;
  const text = [...paragraphs, link, ...after, SIGNATURE].join("\n\n") + "\n";
  const html = [
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    ...after.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<p style="color:#6e6e73">${escapeHtml(SIGNATURE)}</p>`,
  ].join("\n");
  return { to: options.to, subject: options.subject, text, html: `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif">${html}</body></html>` };
}
