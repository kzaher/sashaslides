// AN EMPTY MAIL-SENDER FILE MEANS "EMAIL SIGN-IN OFF", NOT A FAILED START. The deploy mounts every
// secret by name and creates an empty placeholder for one not provided yet (Docker would otherwise
// turn the missing source into a directory), and the connector always passes `--mail-sender`. So a
// server deployed before the Gmail sender is minted must still start, with email sign-in off.
import { strict as assert } from "node:assert";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAccountEraser } from "../http/account-eraser";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import { loadAccountPortal } from "../http/account-portal-stack";
import { inMemoryAuthStore } from "../http/oauth-store";

function load(mailSenderText: string, besideMailSender: Readonly<Record<string, string>> = {}): ReturnType<typeof loadAccountPortal> {
  const dir = mkdtempSync(join(tmpdir(), "sasha-stack-"));
  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  for (const [name, text] of Object.entries(besideMailSender)) write(name, text);
  const store = inMemoryAuthStore();
  const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) });
  return loadAccountPortal({
    publicUrl: "https://sashaslides.example",
    identityProvidersPath: write("identity-providers.json", '{"providers":[{"name":"google"}]}'),
    googleClientPath: write("google.json", JSON.stringify({ web: { client_id: "id.apps.googleusercontent.com", client_secret: "secret" } })),
    sessionSecret: randomBytes(32).toString("hex"),
    mailSenderPath: write("mail-sender.json", mailSenderText),
    trustedProxies: null,
    store,
    vault,
    eraser: createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(false) }),
    warn: () => undefined,
  });
}

test("an empty mail-sender file starts the portal with email sign-in off", () => {
  for (const text of ["", "\n", "  \n"]) {
    const loaded = load(text);
    assert.equal(loaded.kind, "ok", loaded.kind === "failed" ? loaded.message : "");
    assert.ok(loaded.kind === "ok" && loaded.banner.some((line) => /email sign-in: off/.test(line)), JSON.stringify(loaded));
  }
});

test("a mail-sender file with content is still parsed, and a bad one still fails the start", () => {
  const loaded = load('{"from": 1}');
  assert.equal(loaded.kind, "failed");
});

test("a service-account mail sender reads its key file from beside the mail-sender file, and the banner names the mode", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const keyFile = JSON.stringify({ type: "service_account", private_key_id: "kid", private_key: privateKey, client_email: "mailer@project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" });
  // The process's cwd is not the temporary directory, so only resolving beside the file finds the key.
  const loaded = load(JSON.stringify({ serviceAccountKeyPath: "gmail-service-account.json", impersonate: "noreply@exponent.company", from: "Sasha Slides <noreply@sashaslides.com>" }), {
    "gmail-service-account.json": keyFile,
  });
  assert.equal(loaded.kind, "ok", loaded.kind === "failed" ? loaded.message : "");
  assert.ok(loaded.kind === "ok" && loaded.banner.some((line) => line.includes("mailing as n•••@sashaslides.com through the Gmail API (service account, acting as n•••@exponent.company)")), JSON.stringify(loaded));
});

test("a service-account mail sender whose key file is missing fails the start, naming the field", () => {
  const loaded = load(JSON.stringify({ serviceAccountKeyPath: "missing.json", impersonate: "noreply@exponent.company", from: "noreply@sashaslides.com" }));
  assert.equal(loaded.kind, "failed");
  assert.ok(loaded.kind === "failed" && /serviceAccountKeyPath: cannot read the key file \(ENOENT\)/.test(loaded.message), JSON.stringify(loaded));
});
