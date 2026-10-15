# Publishing sashaslides.com and the Sasha Slides connector

`deploy/publish.sh` ships two services to the holosweat server (`root@78.46.91.218`; override with
`DEPLOY_HOST`). It
builds both images on the server, so this machine needs no Docker, rsync or registry: only
ssh, scp, tar, gzip, dd and node.

| Target | Compose project | Server directory | Loopback port | Source |
|---|---|---|---|---|
| website | `sashaslides` | `/root/sashaslides` | 6000 | `renderer/html2slides/addon-server` |
| connector | `sasha-connector` | `/root/sasha-connector` | 6100 | `mcp/sasha-slides/deploy` |

nginx terminates TLS and routes by path
(`renderer/html2slides/addon-server/deploy/nginx-sashaslides.conf`; the contract is tested by
`nginx-routing.test.ts` beside it). These paths go to the connector: `/mcp`, `/register`,
`/authorize`, `/token`, `/oauth/google/callback`, `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` (each with or
without `/mcp` appended), `/account` and everything under `/account/`, and the deck server's
`/decks`, `/deck/`, `/deck-app/` and `/deck-api/` (the last with WebSocket upgrades, for
`/deck-api/sync/<id>`). The connector's `/healthz` is published as `/connector/healthz`. Everything
else, including `/healthz`, `/deckhouse` and `/decks.css`, goes to the website.

**Never run more than one connector replica.** The deck server lives inside the connector
process (SPEC.md 21.1): each open deck is one room in that process's memory, the single
authoritative replica every editor and every agent edit goes through. A second replica would split
a deck's editors between two rooms that never see each other's changes, and both would write the
same files under `/data/decks`. `docker-compose.yml` runs one container; keep it so, and restart
rather than scale. A restart is safe: on `SIGTERM` the connector flushes every room and closes the
deck sockets with `serverShuttingDown` (4013), and the editors reconnect and resend anything the
last 250 milliseconds lost.

`publish.sh connector` also builds the deck web application (`npm ci` and `npm run -s build:web`
in `mcp/sasha-slides/engine`) before packing, because the connector serves
`engine/dist/web/**` from disk. Deck data lives in the same `/data` volume as the auth store:
`/data/decks/` (every record sealed with the deck owner's account key) and `/data/deck-profiles/`.

## One-time server setup

1. SSH access: by default the script uses whatever ssh's agent offers (in the devcontainer, the
   forwarded `SSH_AUTH_SOCK`). To use a dedicated key instead, append its `.pub` to the server's
   `/root/.ssh/authorized_keys` and run with `DEPLOY_KEY=~/.ssh/sashaslides_deploy`. Check access
   with `ssh -o BatchMode=yes -o ConnectTimeout=8 root@78.46.91.218 true`.
2. Firewall (ufw is active): nothing to change. Both containers publish on `127.0.0.1` only, and
   nginx already owns 80 and 443. Do not open 6000 or 6100. The TLS server block listens on
   78.46.91.212, the box's second address, as the live site file always has.
3. Google Cloud console, on the Web OAuth client in `.auth/google_oauth_web.json`: add both
   redirect URIs that the connector prints at startup:
   `https://sashaslides.com/oauth/google/callback` and
   `https://sashaslides.com/account/callback/google`.
4. The certificate for sashaslides.com must already exist. `publish.sh` refuses to install the
   nginx file without it; `renderer/html2slides/addon-server/deploy/deploy-sashaslides.sh` has the
   certbot step.

## First deploy

```bash
bash deploy/publish.sh --dry-run all     # prints every remote command and the upload sizes
bash deploy/publish.sh all
```

On the first connector deploy the server gets `/root/sasha-connector/secrets/` (mode 0700) and
`connector.env` with a freshly generated `SASHA_MASTER_KEY` and `SASHA_SESSION_SECRET`. The script
only generates a value that is absent, never overwrites one, and refuses to generate a master key
when `data/account-keys.json` already exists. `.auth/google_oauth_web.json` and
`.auth/identity-providers.json` are copied from this machine when present (mode 0600, owned by
uid 10100, the container's user; uid 1000 on the server is a login user). Without an identity-providers file the server gets a Google-only
one.

**Back up the master key straight away**, then keep that copy somewhere other than this server
and its data backups:

```bash
ssh root@78.46.91.218 grep SASHA_MASTER_KEY /root/sasha-connector/secrets/connector.env
```

The drawio webapp (147 MB, 56 MB compressed) is uploaded only when its sha256 differs from
`/root/sashaslides/drawio.sha256`, so only the first site deploy pays for it. Uploads show a live
byte count. Server builds stream their output.

## Routine deploy

```bash
bash deploy/publish.sh site          # website only
bash deploy/publish.sh connector     # connector only
bash deploy/publish.sh all
```

Each run re-installs the nginx file (`nginx -t` first; on failure the previous file is restored
and nginx is not reloaded), then checks, one line each:
`/healthz` and `/privacy` (website), and `/connector/healthz`, `/account` and
`/.well-known/oauth-protected-resource/mcp` (connector).

Tests that need no server: `npx tsx --test renderer/html2slides/addon-server/deploy/nginx-routing.test.ts`
and `bash deploy/publish.test.sh` (a dry run with ssh and scp stubbed out to fail).

## Rollback

Before each build the running image is tagged `:previous`. To go back one deploy:

```bash
bash deploy/publish.sh rollback site
bash deploy/publish.sh rollback connector
```

A connector rollback keeps `data/` and `secrets/`. Only one level is kept; deploying again
replaces it. The previous nginx file is at `/root/sashaslides/nginx-sashaslides.conf.previous`.

## Where secrets and state live

| Path on the server | What | If lost |
|---|---|---|
| `/root/sasha-connector/secrets/connector.env` | `SASHA_MASTER_KEY`, `SASHA_SESSION_SECRET` | master key: **every user's stored grant becomes unreadable**; session secret: people sign in to `/account` again |
| `/root/sasha-connector/secrets/google_oauth_web.json` | Google Web OAuth client | re-copy from `.auth/` |
| `/root/sasha-connector/secrets/identity-providers.json` | `/account` sign-in providers | re-copy from `.auth/` |
| `/root/sasha-connector/secrets/apple-signin.p8` | Sign in with Apple key, named by `privateKeyPath` in the providers file; empty until provided | re-copy from `.auth/`, or make a new key at Apple |
| `/root/sasha-connector/secrets/mail-sender.json` | Gmail sender for email sign-in (`mcp/sasha-slides/e2e/gmail-sender-token.ts`); empty leaves email sign-in off | re-mint; while the OAuth client is in Testing mode its refresh token expires after 7 days |
| `/root/sasha-connector/data/oauth-store.json` | client registrations, sealed per-user Google grants | users reconnect |
| `/root/sasha-connector/data/account-keys.json` | per-account data keys, wrapped under the master key | users reconnect |

Keep the master key out of the backups that hold `data/`: a backup holding both can read
everything, and erasing an account works by destroying its key.
