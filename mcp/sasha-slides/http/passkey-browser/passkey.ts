/**
 * The account portal's only script: it runs the browser half of a passkey ceremony.
 *
 * The portal is server-rendered HTML that works without JavaScript; this script only adds
 * the passkey buttons on top. They ship `hidden`, inside one `[data-passkeys]` container,
 * and are shown here only when the browser has WebAuthn, so a browser without script (or
 * without passkeys) never sees a button that cannot work, and the other providers' links
 * are untouched.
 *
 * Each button names its ceremony in `data-passkey`: `create` (a new account), `signin`, or
 * `add` (to the signed-in account, which also carries the session's CSRF token on the
 * container as `data-csrf`). A ceremony is three steps:
 *
 *   POST /account/passkey/<ceremony>/options  → the server's options, binary fields base64url
 *   navigator.credentials.create / .get        → the authenticator answers
 *   POST /account/passkey/<ceremony>/verify    → on success the server sets the session
 *                                                cookie and names where to go next
 *
 * Not React (the TypeScript skill's default for UI): there is no state to render, only two
 * attributes to flip on server-rendered markup and one status line, which is the
 * server-generated-static-HTML exception that rule names. Bundled by `build.ts` into
 * `../passkey-script.generated.ts`, which the portal serves at `/account/passkey.js`.
 */

type Ceremony = "create" | "signin" | "add";

type ServerAnswer = Readonly<{ kind: "ok"; body: Readonly<Record<string, unknown>> }> | Readonly<{ kind: "failed"; message: string }>;

const container = document.querySelector<HTMLElement>("[data-passkeys]");
if (container !== null && typeof window.PublicKeyCredential === "function") start(container);

function start(root: HTMLElement): void {
  root.hidden = false;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-passkey]")];
  const status = root.querySelector<HTMLElement>("[data-passkey-status]");
  for (const button of buttons) {
    const ceremony = parseCeremony(button.dataset["passkey"]);
    if (ceremony === null) continue;
    button.addEventListener("click", () => {
      void runCeremony({ ceremony, csrf: root.dataset["csrf"] ?? null, buttons, status });
    });
  }
}

async function runCeremony(
  options: Readonly<{ ceremony: Ceremony; csrf: string | null; buttons: readonly HTMLButtonElement[]; status: HTMLElement | null }>,
): Promise<void> {
  const { ceremony, csrf, buttons, status } = options;
  const say = (message: string): void => {
    if (status === null) return;
    status.textContent = message;
    status.hidden = message === "";
  };
  for (const button of buttons) button.disabled = true;
  say("");
  try {
    const csrfField = csrf === null ? {} : { csrf };
    const offered = await post({ path: `/account/passkey/${ceremony}/options`, body: csrfField });
    if (offered.kind === "failed") return say(offered.message);
    const publicKey = asRecord(offered.body["publicKey"]);
    if (publicKey === null) return say("The server sent an unexpected answer. Please reload the page.");
    const credential =
      ceremony === "signin"
        ? await navigator.credentials.get({ publicKey: requestOptions(publicKey) })
        : await navigator.credentials.create({ publicKey: creationOptions(publicKey) });
    if (!(credential instanceof PublicKeyCredential)) return say("No passkey was chosen.");
    const verified = await post({ path: `/account/passkey/${ceremony}/verify`, body: { ...csrfField, credential: credentialJson(credential) } });
    if (verified.kind === "failed") return say(verified.message);
    const redirect = verified.body["redirect"];
    window.location.assign(typeof redirect === "string" && redirect.startsWith("/account") ? redirect : "/account");
  } catch (error) {
    say(describeFailure({ error, ceremony }));
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function parseCeremony(value: string | undefined): Ceremony | null {
  return value === "create" || value === "signin" || value === "add" ? value : null;
}

async function post(options: Readonly<{ path: string; body: Readonly<Record<string, unknown>> }>): Promise<ServerAnswer> {
  const response = await fetch(options.path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.body),
  });
  const parsed: unknown = await response.json().catch(() => null);
  const body = asRecord(parsed) ?? {};
  if (response.ok) return { kind: "ok", body };
  const message = body["message"];
  return { kind: "failed", message: typeof message === "string" ? message : "Something went wrong. Please try again." };
}

function describeFailure(options: Readonly<{ error: unknown; ceremony: Ceremony }>): string {
  const name = options.error instanceof DOMException ? options.error.name : "";
  if (name === "NotAllowedError") return "The passkey request was cancelled or timed out.";
  if (name === "InvalidStateError" && options.ceremony !== "signin") return "This device already holds a passkey for this account.";
  return "The passkey could not be used. Please try again.";
}

// ---------------------------------------------------------------- server JSON → WebAuthn options

function creationOptions(json: Readonly<Record<string, unknown>>): PublicKeyCredentialCreationOptions {
  const user = asRecord(json["user"]) ?? {};
  const rp = asRecord(json["rp"]) ?? {};
  const selection = asRecord(json["authenticatorSelection"]) ?? {};
  return {
    rp: { id: text(rp["id"]), name: text(rp["name"]) },
    user: { id: bytes(user["id"]), name: text(user["name"]), displayName: text(user["displayName"]) },
    challenge: bytes(json["challenge"]),
    pubKeyCredParams: records(json["pubKeyCredParams"]).map((parameter) => ({
      type: "public-key",
      alg: typeof parameter["alg"] === "number" ? parameter["alg"] : 0,
    })),
    timeout: typeof json["timeout"] === "number" ? json["timeout"] : 300_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: verification(selection["userVerification"]),
    },
    excludeCredentials: records(json["excludeCredentials"]).map((descriptor) => ({ type: "public-key", id: bytes(descriptor["id"]) })),
  };
}

function requestOptions(json: Readonly<Record<string, unknown>>): PublicKeyCredentialRequestOptions {
  return {
    challenge: bytes(json["challenge"]),
    rpId: text(json["rpId"]),
    timeout: typeof json["timeout"] === "number" ? json["timeout"] : 300_000,
    userVerification: verification(json["userVerification"]),
    // Empty: the authenticator offers its discoverable passkeys, so no username is asked for.
    allowCredentials: [],
  };
}

function verification(value: unknown): UserVerificationRequirement {
  return value === "required" || value === "discouraged" ? value : "preferred";
}

// ---------------------------------------------------------------- credential → server JSON

function credentialJson(credential: PublicKeyCredential): Readonly<Record<string, unknown>> {
  const { response } = credential;
  const envelope = { id: credential.id, rawId: base64Url(credential.rawId), type: credential.type };
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      ...envelope,
      response: { clientDataJSON: base64Url(response.clientDataJSON), attestationObject: base64Url(response.attestationObject) },
    };
  }
  if (response instanceof AuthenticatorAssertionResponse) {
    return {
      ...envelope,
      response: {
        clientDataJSON: base64Url(response.clientDataJSON),
        authenticatorData: base64Url(response.authenticatorData),
        signature: base64Url(response.signature),
        userHandle: response.userHandle === null ? null : base64Url(response.userHandle),
      },
    };
  }
  return envelope;
}

// ---------------------------------------------------------------- small conversions

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  // A non-null, non-array object is a string-keyed record; every read below narrows its values.
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bytes(value: unknown): ArrayBuffer {
  const base64 = text(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index);
  return buffer;
}

function base64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
