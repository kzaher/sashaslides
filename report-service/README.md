# `report-service`

Internet-facing intake for anonymised **Sasha Slides** defect reports.

When the HTML-to-Slides converter gets a slide wrong, the add-on anonymises that slide and offers to
send a report. This service is where the report lands. It accepts the payload, validates it strictly,
writes it to one file on a disk, and hands back an id the user can quote to a maintainer.

It is a **separately deployable service**. It imports nothing from `mcp/sasha-slides/**`; the wire
format in [Request and response shapes](#request-and-response-shapes) is the contract, and both sides
transcribe it independently. It also has **zero runtime dependencies** — `node:http` and
`node:crypto`, nothing from npm — because a service exposed to the internet should not have a third
party in its request path.

---

## Running it

```sh
npm run typecheck      # tsc --noEmit, clean
npm test               # the whole suite, over a real listening server
npm start              # listens on 127.0.0.1:8787 with ./data as its store
```

Node 22.6 or newer (it runs the TypeScript sources directly, via Node's own type stripping — there
is no build step and no bundler).

A production start sets at least the bind address, the data directory and the proxy hop count:

```sh
REPORT_HOST=0.0.0.0 \
REPORT_DATA_DIR=/var/lib/sasha-report-service \
REPORT_TRUSTED_PROXY_HOPS=1 \
REPORT_IP_HASH_SECRET="$(openssl rand -hex 32)" \
npm start
```

It answers `SIGTERM` and `SIGINT` by stopping accepting connections, letting in-flight requests
finish, and dropping idle keep-alive sockets immediately. Anything still running after
`REPORT_SHUTDOWN_GRACE_MS` is cut off. `stop` is idempotent, so a second Ctrl-C is harmless.

---

## Configuration

Every variable has a default the service is safe to run with; an out-of-range value is a **startup
failure**, not a silent fallback.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPORT_HOST` | `127.0.0.1` | Bind address. Loopback by default so an accidental start is not exposed. |
| `REPORT_PORT` | `8787` | TCP port. `0` picks a free one (used by the tests). |
| `REPORT_DATA_DIR` | `./data` | Root of the store. Created if absent. |
| `REPORT_MAX_BODY_BYTES` | `2097152` (2 MiB) | Hard cap on a request body. |
| `REPORT_RATE_BURST` | `10` | Burst bucket size, per client. |
| `REPORT_RATE_BURST_REFILL_PER_SECOND` | `1` | Burst bucket refill. |
| `REPORT_RATE_SUSTAINED` | `60` | Sustained bucket size, per client. |
| `REPORT_RATE_SUSTAINED_REFILL_PER_SECOND` | `0.0166…` (60/hour) | Sustained bucket refill. |
| `REPORT_RATE_MAX_CLIENTS` | `20000` | Buckets held in memory, so the limiter cannot be used to exhaust memory. |
| `REPORT_MAX_REPORTS` | `50000` | Reports held before `POST` starts answering 503. |
| `REPORT_MAX_TOTAL_BYTES` | `1073741824` (1 GiB) | Stored bytes before `POST` starts answering 503. |
| `REPORT_RETENTION_DAYS` | `30` | Age at which a report is deleted automatically. |
| `REPORT_SWEEP_INTERVAL_SECONDS` | `3600` | How often retention runs. It also runs once at startup. |
| `REPORT_ALLOWED_HOST_PATTERNS` | `*-script.googleusercontent.com` | Comma-separated host patterns allowed as an `Origin` over https. A leading `*` matches one label fragment with no dots. |
| `REPORT_ALLOWED_ORIGINS` | *(empty)* | Comma-separated **exact** origins, for local development (e.g. `http://localhost:5173`). |
| `REPORT_TRUSTED_PROXY_HOPS` | `0` | Number of proxies you operate in front of this process. See [Rate limiting](#rate-limiting). |
| `REPORT_IP_HASH_SECRET` | random per process | HMAC key for the pseudonymous client label in logs. Set it to correlate across restarts. |
| `REPORT_REQUEST_TIMEOUT_MS` | `15000` | Whole-request budget. Bounds a slow body. |
| `REPORT_HEADERS_TIMEOUT_MS` | `5000` | Header budget. Bounds a slowloris. |
| `REPORT_KEEPALIVE_TIMEOUT_MS` | `5000` | Idle keep-alive budget. |
| `REPORT_MAX_CONNECTIONS` | `256` | Concurrent sockets. |
| `REPORT_SHUTDOWN_GRACE_MS` | `10000` | How long a shutdown waits before cutting live requests. |

---

## Request and response shapes

### `POST /v1/reports`

`Content-Type: application/json` is **required** (anything else is `415`), and the body must be
identity-encoded — the service does not decompress, so a `Content-Encoding` header is also a `415`.

```json
{
  "schemaVersion": 1,
  "note": "the table lost its gridlines",
  "document": { "html": "<!doctype html>…the anonymised slide…" },
  "converterOutput": {
    "format": "slides-api-requests-json",
    "text": "[{\"createShape\":{\"objectId\":\"g1\"}}]"
  },
  "versions": { "addon": "1.4.0", "converter": "2026.10.04", "protocol": 1 },
  "clientReportedAt": "2026-10-04T12:00:00.000Z"
}
```

Every field is required, **unknown fields are rejected** (top level and nested), and there is
deliberately nowhere to put an account identifier, a Drive file id or a presentation id. If a future
add-on build starts leaking one, it gets a `422` rather than quiet storage.

`201 Created`:

```json
{
  "id": "rep_7w9b3rqhq8vd8ebsh6f5k1jqp4",
  "deletionToken": "del_3m12jvqn2pb6a8k5qp70zw1esr",
  "receivedAt": "2026-10-04T13:02:05.223Z",
  "storedBytes": 583,
  "duplicate": false
}
```

Show the user the `id` — that is what they quote. Show the `deletionToken` **once**: it is not stored
in recoverable form and cannot be reissued.

A byte-identical resubmission answers `200` with `"duplicate": true`, the original `id`, and
`"deletionToken": null`. Nothing is written twice.

### `GET /v1/reports/:id`

The submitter's receipt. **Public to whoever holds the id, metadata only.**

```json
{
  "id": "rep_7w9b3rqhq8vd8ebsh6f5k1jqp4",
  "receivedAt": "2026-10-04T13:02:05.223Z",
  "clientReportedAt": "2026-10-04T12:00:00.000Z",
  "storedBytes": 583,
  "htmlBytes": 40,
  "converterOutputBytes": 2,
  "noteBytes": 19,
  "versions": { "addon": "1.4.0", "converter": "2026.10.04", "protocol": 1 }
}
```

*Why it is not token-gated:* the body contains nothing the submitter did not already know and nothing
anybody else could use — timestamps, byte counts, version strings. Gating that behind a second
credential would be ceremony. The id is 128 bits of CSPRNG output, so it cannot be enumerated, which
is the only access control the route needs.

*Why it does not return the report:* see [Never render submitted HTML](#never-render-submitted-html).

### `DELETE /v1/reports/:id`

Self-service deletion, gated on `X-Deletion-Token`. A malformed or absent token is `401`; a
well-formed but wrong one is `403` (compared in constant time against a SHA-256 digest); an unknown
id is `404`.

```sh
curl -X DELETE https://reports.example/v1/reports/rep_7w9… \
  -H 'X-Deletion-Token: del_3m12…'
```

### `GET /healthz`

```json
{ "status": "ok", "at": "2026-10-04T13:02:05.212Z", "uptimeSeconds": 7 }
```

Liveness only. No report counts, no stored bytes, no payload. It is exempt from the origin check and
from the rate limiter, so a probe neither depends on CORS nor gets throttled by somebody else's
abuse.

### Errors

Every error is JSON, with a stable machine code:

```json
{ "error": { "code": "unknown-field", "message": "unknown field presentationId" } }
```

| Status | Codes |
| --- | --- |
| `400` | `malformed-json`, `not-an-object`, `malformed-body` |
| `401` | `deletion-token-required` |
| `403` | `origin-not-allowed`, `deletion-token-invalid` |
| `404` | `not-found` |
| `405` | `method-not-allowed` (with `Allow`) |
| `413` | `body-too-large`, `field-too-large` |
| `415` | `unsupported-media-type`, `unsupported-encoding` |
| `422` | `unknown-field`, `missing-field`, `wrong-type`, `bad-value`, `unsupported-schema-version` |
| `429` | `rate-limited` (with `Retry-After`) |
| `503` | `storage-full` (with `Retry-After`) |
| `500` | `internal-error` |

An error **never quotes a submitted value.** It names a field and a limit, and the field name itself
is scrubbed to `[A-Za-z0-9_.-]` before use — it came from the attacker's JSON, and a response body is
not where you want to discover how a client renders a control character.

---

## Limits, and why these numbers

| Limit | Value | Reasoning |
| --- | --- | --- |
| Request body | 2 MiB | Comfortably above the sum of the field caps plus JSON escaping (worst case one byte of HTML becomes six, which is why the body cap is not simply the sum). It also bounds what one connection can make the process allocate. Enforced **twice**: a `Content-Length` pre-check that refuses before reading a byte, and a running byte count while streaming — because `Content-Length` is a claim, a chunked body carries none, and a lying one is trivial to send. |
| `document.html` | 1 MiB | One anonymised slide with inlined styles measures in the tens of KiB. An order of magnitude of headroom. |
| `converterOutput.text` | 512 KiB | The Slides API request array for one slide is a few hundred objects at worst. |
| `note` | 4 KiB | A defect note is a paragraph. Anything longer is using the field as storage. |
| `versions.*` | 64 bytes, `[A-Za-z0-9][A-Za-z0-9._+:-]*` | Build identifiers, not prose. |
| `clientReportedAt` | strict ISO-8601 UTC instant | Advisory only; the store stamps its own `receivedAt` and retention is computed from that, because a client clock is attacker-controlled. |
| Stored reports | 50 000 | With the per-report cap, a bound on both inode count and worst-case volume use. |
| Stored bytes | 1 GiB | The disk cap. Checked **before** the write, against the actual serialised size. |
| Retention | 30 days | Long enough to diagnose a converter bug, short enough that the service is not an archive. |
| Tracked rate-limit clients | 20 000 | Bounds the limiter's own memory. |
| Concurrent connections | 256 | Bounds socket and memory use. |
| Header / request / keep-alive timeouts | 5 s / 15 s / 5 s | A trickling request is dropped instead of holding a connection slot for free. |

Field caps are in **bytes of UTF-8**, not characters, so a four-byte emoji cannot buy four times the
budget. A body that is not valid UTF-8 is a `400`, not a string full of replacement characters that
then gets stored.

---

## Never render submitted HTML

A service that accepts arbitrary HTML from strangers and can be persuaded to serve it back is an open
XSS and phishing host: submit a page, get a URL on a plausible-looking origin, send it to someone.

So there is **no HTML view anywhere in this service, and no route that returns a submission at all**.
The defence is structural rather than a sanitiser:

* The store exposes no function that returns submitted text. `find` returns an index entry holding
  sizes, hashes, timestamps and versions. A request handler therefore *cannot* read the HTML, even
  by mistake, because nothing hands it to one.
* Every response is `application/json; charset=utf-8` with `X-Content-Type-Options: nosniff`, so a
  browser will not sniff one into markup.
* Every response — including errors — carries
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`, plus
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. If some
  future route did serve the wrong thing, it would still have no scripting and no origin.
* Unmatched request paths are not reflected into the response or the log.

An operator who needs to read a report opens the file on disk. That is deliberately out of band.

---

## Cross-origin access

The add-on panel is an Apps Script `HtmlService` page. Its origin looks like

```
https://n-<opaque>-<slot>lu-script.googleusercontent.com
```

and note where the dots are: the whole of `n-<opaque>-<slot>lu-script` is **one DNS label** under
`googleusercontent.com`. The opaque part is generated per session and per deployment, so an
allowlist of exact origins is impossible and `Access-Control-Allow-Origin: *` would mean the whole
internet.

**The decision:** reflect the request's own `Origin`, but only after it passes a strict test.

* It must parse, and must be *exactly* its own serialised origin — no path, no trailing slash, no
  port, no userinfo, no case tricks. (One round-trip through the URL parser rejects all of those at
  once.)
* It must be `https:`.
* Its host must match a configured pattern, defaulting to `*-script.googleusercontent.com`, where
  the wildcard matches **one label fragment containing no dots**. The `-script` tail is what
  distinguishes an Apps Script sandbox from the rest of `googleusercontent.com`, which also serves
  Drive thumbnails and profile photos (`lh3.googleusercontent.com` and friends). Matching the bare
  domain suffix would have let all of those in.
* `Vary: Origin` on every response, so no cache can serve one origin's permission to another.
* `Access-Control-Allow-Credentials` is **never** sent. There are no cookies and no session here, and
  reflecting an origin *with* credentials is exactly how a reflected-CORS policy becomes CSRF.
* Requiring `Content-Type: application/json` is a real control, not a formality: an HTML form cannot
  send that content type, so a cross-site POST must go through a preflight, which this policy then
  governs.
* A request carrying a **disallowed** `Origin` gets `403` and never reaches the store. Omitting the
  CORS header alone would only stop the caller *reading* the answer — the write would still have
  happened.
* A request with **no** `Origin` (curl, a server-side caller, a health probe) is allowed. The header
  is absent precisely when it cannot be relied upon, and refusing on its absence would be theatre:
  any client can omit it.

**What this is not.** It is not authentication and it is not authorisation. CORS is enforced by
browsers; `curl` ignores every header above. And `*-script.googleusercontent.com` is the sandbox
shape for *every* Apps Script project, so the policy admits any Apps Script add-on in the world —
it cannot be narrowed, because the only project-identifying part of the host is the segment that
rotates. What it does achieve is keeping ordinary web pages from quietly submitting on a visitor's
behalf, and keeping the response unreadable to them if they try.

### Why there is no shared token

A shared secret shipped in the add-on would be **security theatre**. The add-on's panel is HTML and
JavaScript delivered to the user's browser; anyone who opens the sidebar and views source has the
token. It would add a deployment and rotation burden, it would appear in logs and bug reports, and it
would buy nothing an attacker could not obtain in thirty seconds.

A token *would* be the right answer if submissions came from a server the operator controls, or if
the endpoint were for a small set of known machines. It is not the right answer for an endpoint whose
whole purpose is to accept something from an anonymous user's browser. The controls that actually
apply here are the strict schema, the size caps, the rate limiter and the disk budget — all of which
work the same whether the caller is friendly or not.

---

## Rate limiting

Two token buckets per client, consulted in order: a small fast-refilling one (10, +1/s) that absorbs
a legitimate flurry and stops a hammering loop, and a large slow-refilling one (60, +60/hour) that
stops a patient client submitting all day. A refusal is `429` with `Retry-After`.

The client key is the source address, with IPv6 cut to a `/64` — a single residential IPv6
allocation is typically a `/64` or shorter, so keying on the full address would hand one subscriber
18 quintillion free buckets.

**What it does not stop — stated plainly, because a rate limiter is the control people most often
over-trust:**

* **Anything distributed.** A botnet, or anyone with an allocation larger than a `/64`, gets a fresh
  bucket per source. The disk caps are what bound the damage there, not this.
* **Behind a proxy, it is only as good as `REPORT_TRUSTED_PROXY_HOPS`.** At the default `0` the
  header is ignored and the socket address is used: correct when this process faces the internet
  directly, but **behind a reverse proxy every request carries the proxy's address and the limiter
  degrades into one global bucket** — one abuser then throttles everybody. Set it to the number of
  proxies you actually operate; the client address is then taken that many entries from the *right*
  of `X-Forwarded-For`, because the rightmost entries are the ones your own infrastructure appended
  and are the only ones a caller cannot forge. Set it **too high** and a client can prepend its own
  entries, choose its own key, and have an unlimited supply of buckets.
* **Shared egress, in the other direction.** An office or a carrier NAT shares one bucket. The
  defaults are high enough that a human filing defect reports will never notice.
* **It is in memory**, so a restart forgives everyone. That is a deliberate trade against keeping a
  per-address file on disk, which would itself be a disk-growth vector.

---

## Abuse protection beyond rate limiting

Filling the disk is the obvious attack on an endpoint whose job is to accept a megabyte of text from
anyone. What is in place:

* **Hard per-field and per-body caps** (above), enforced on the streaming byte count rather than on a
  claimed `Content-Length`.
* **A report count cap and a total-byte cap**, checked *before* the write against the actual
  serialised size. When either is reached, `POST` answers `503 storage-full` with `Retry-After` while
  `GET`, `DELETE` and `/healthz` keep working — the service degrades to read-only instead of filling
  a volume and taking the host down with it.
* **Duplicate suppression.** A SHA-256 of the canonical payload; a byte-identical resubmission
  returns the original id and writes nothing. A retry loop or a trivial replay flood therefore costs
  one report, not thousands. (The timestamp is excluded from the hash on purpose — a retry a second
  later is the same report.)
* **Automatic retention.** Reports older than `REPORT_RETENTION_DAYS` are deleted by a sweep that
  also compacts the index. Storage is bounded in time as well as in size.
* **Connection and time budgets.** `maxConnections`, `headersTimeout`, `requestTimeout`,
  `keepAliveTimeout` and `maxRequestsPerSocket` all bound what one socket can occupy. A trickling
  request is dropped, not waited on.
* **No decompression.** A `Content-Encoding` header is a `415`, so there is no zip-bomb surface at
  all — the service never inflates anything.
* **A bounded rate-limiter table**, so the thing meant to prevent abuse cannot itself be used to
  exhaust memory.
* **A closed id alphabet.** `:id` must parse as `rep_` plus 26 Crockford-base32 characters, a set
  containing no `.` and no `/`. Path traversal is not *defended against* so much as made
  unrepresentable: the store accepts only a validated `ReportId`, and a traversal attempt cannot
  produce one.

---

## Logging

One JSON object per line, on stdout. A request line contains exactly:

```json
{"at":"2026-10-04T13:02:05.225Z","kind":"request","method":"POST","route":"POST /v1/reports",
 "status":201,"outcome":"accepted","requestBytes":293,"durationMs":3,
 "client":"ip:b8693bb0ead8","reportId":"rep_7w9b3rqhq8vd8ebsh6f5k1jqp4"}
```

**No payload is ever logged** — not the note, not the HTML, not the converter output, not a field
value quoted back in an error, not the raw request path. The anonymiser is *supposed* to have removed
everything identifying before the payload is sent; this service assumes it failed, and treats its
input as sensitive regardless. Every line is built by naming each field individually, never by
spreading an object, so a payload cannot arrive in a log through a field somebody added upstream.

`route` is a template (`GET /v1/reports/:id`), and an unmatched path is logged as `<unmatched>`
rather than as the attacker-chosen text. `client` is `ip:` plus the first 12 hex characters of an
HMAC of the (prefix-truncated) address under `REPORT_IP_HASH_SECRET` — enough to say "these forty
requests came from one place" while reading an incident, not enough to recover the address. With the
default per-process random secret, labels are not even correlatable across restarts.

A resolved `reportId` *is* logged: it is the only way to tie a stored file to the request that
created it, which is what an operator needs during an incident. Deletion tokens are never logged.

---

## Storage, retention and deletion

```
$REPORT_DATA_DIR/
  reports/7w/rep_7w9b3rqhq8vd8ebsh6f5k1jqp4.json   one report, written once, never rewritten
  index.jsonl                                      append-only log of what exists
  incoming/                                        staging names a write passes through
```

A report file is written to `incoming/` with mode `0600` and `rename`d into place, so a reader never
sees half a report. The index line is appended only *after* the rename succeeds, so the index can
never name a file that does not exist; if the process dies in that window the file is an orphan,
which the sweep counts and reports rather than deleting on a guess. If the index append fails, the
file is rolled back.

The index is a **log**, not a file that gets rewritten: a submission appends one `stored` line and a
deletion appends one `removed` line. Replaying gives the current set, so a crash leaves a readable
index whose worst case is a trailing partial line (counted as `unreadableIndexLines` and skipped).
The sweep compacts it by writing a fresh log and renaming it over the old one.

The service is **single-process by design.** The write mutex is an in-process promise chain; two
instances over one directory would keep their line appends whole but their byte accounting and
duplicate maps would diverge. Scaling out means moving the index to something with a real lock.

Durability is not fsync-level: a power loss can lose the last few writes. For defect reports that is
the right trade — the cost of losing one is a maintainer asking the user to resend.

### How a submitter asks for a report to be deleted

**They delete it themselves.** The `deletionToken` from the submission response is the capability:

```sh
curl -X DELETE https://reports.example/v1/reports/rep_7w9… \
  -H 'X-Deletion-Token: del_3m12…'
```

That is the whole process. There is no account to prove ownership of, no email address to verify, and
no identity to collect — which is the point, given a payload that deliberately carries no identifiers.
The file is removed and a `removed` line is appended to the index.

If the token has been lost, the operator can delete the file directly (`rm` the path above and run
the sweep, or restart the service, to compact the index). The submitter has to supply the `id` for
that, and the operator has no way to verify they are the original submitter — so the honest policy is
that the id-plus-token pair is the only self-service route, and anything else is an operator judgement
call. Everything is deleted automatically after `REPORT_RETENTION_DAYS` regardless.

**The deletion token is a real secret and the id is not.** They are separate values on purpose: the
id is meant to be quoted in a chat window with a maintainer, and if quoting it also handed over the
ability to delete the report, the quotable identifier would be a footgun. The token is stored only as
a SHA-256 digest and compared in constant time; losing it means losing self-service deletion, not
losing the report.

---

## Attacks considered and *not* defended against

Being explicit about the edges is more useful than implying there are none.

* **Volumetric DDoS.** Nothing here survives someone with more bandwidth than the host. That belongs
  to a CDN or an upstream scrubber, not to a Node process. The timeouts and connection cap keep a
  *modest* flood from being free, and no more.
* **Distributed submission flooding.** Per-IP limiting is defeated by a botnet. The disk caps mean the
  worst outcome is `503 storage-full` on `POST` — the service stops accepting rather than filling the
  volume — but a determined distributed attacker *can* reach that state and deny other people the
  ability to file reports. Mitigating it properly needs a proof-of-work or an upstream reputation
  system, and neither is justified for this endpoint's value.
* **Garbage submissions from a real browser.** A human (or a headless browser in the Apps Script
  sandbox) who stays within the rate limit can submit 60 useless reports an hour. There is no
  CAPTCHA, no reputation and no content triage. Retention bounds the mess; an operator reading the
  reports is what catches it.
* **TLS.** Terminated upstream. This process speaks plain HTTP and must not be exposed directly.
  There is no HSTS header and no redirect, because deciding that belongs to whatever terminates TLS.
* **The duplicate-suppression oracle.** `"duplicate": true` reveals that a byte-identical payload has
  been submitted before. Exercising it requires already holding the exact bytes, so the information
  gained is nil, but it is a side channel and it is intentional — the disk saving is worth more.
* **A stolen receipt.** Anyone with the `id` can read the (content-free) receipt; anyone with the
  `deletionToken` can delete the report. Both are capabilities, so they are as safe as the place the
  user pasted them. The worst case is a lost defect report.
* **Insider / host compromise.** Reports are stored as plain text at `0600`. There is no
  encryption at rest; anyone who can read the volume can read the submissions. Disk encryption is the
  deployment's job.
* **A compromised anonymiser.** If the add-on's anonymiser misses something, this service stores it.
  The schema has no field for an identifier and the logs never contain a payload, which limits the
  blast radius to the stored file — but the service cannot verify that the HTML it is handed is
  genuinely anonymous, and does not pretend to.
* **Multi-process deployment.** Two instances over one data directory will diverge in their byte
  accounting. Not defended against; see above.
* **Timing side channels other than the token compare.** Only the deletion-token comparison is
  constant time. Validation rejects on the first problem it finds, so response timing leaks which
  check failed — which the error code says out loud anyway.

---

## Tests

`npm test` runs the suite over the **real service**: a real listening socket, the real filesystem
store, the real rate limiter. Nothing substitutes a part of the service for a fake of it; the only
injected dependencies are the clock, the entropy source and the log sink, which the production
composition root injects too. Requests go out over `node:http` rather than `fetch`, so the suite can
set headers `fetch` treats as forbidden (`Origin`) and send a body with no `Content-Length`.

Covered: a valid report round-trips (including the file on disk); the receipt is metadata only and
the submitted HTML is never echoed; an oversized field, an oversized body, and an oversized *chunked*
body are each rejected; unknown fields at both levels and a hostile field name; malformed JSON, wrong
types, missing fields, a future schema version, a bad instant, a wrong content type and a compressed
body; the rate limiter trips with `Retry-After` while `/healthz` keeps answering; 40 concurrent
submissions produce 40 parseable index lines, 40 distinct ids, 40 files, and the same replayed totals
after a restart; duplicate collapse; both storage budgets; the full deletion flow including a wrong
token; five path-traversal shapes; the origin policy across eleven spellings; `405` with `Allow`;
the log contains no payload; configuration validation; and graceful, idempotent shutdown.
