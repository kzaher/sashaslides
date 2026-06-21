# Hosting sashaslides on server.holosweat.com (nginx + certbot + registry)

Fits your existing box exactly like `api.holosweat.com`: a localhost-bound
container, fronted by an nginx site with a certbot cert. **Additive and isolated**
— its own compose project + a new nginx site; nothing existing is modified.

## Topology
```
browser ──https──▶ nginx (:443, certbot cert)  ──▶  127.0.0.1:6000  ──▶  sashaslides container
                   site: sashaslides.com                              (plain HTTP :8787 inside)
```
The container is **localhost-only** (`127.0.0.1:6000`), so it needs **no public
firewall opening** — nginx (already on 443) is the only thing exposed.

## One-time prerequisites
1. **DNS**: add an A record `sashaslides.com → 78.46.91.212` (same IP as your other subdomains).
2. **Registry**: the `registry:2` container on the server's `:5000` (your existing one — the `docker run … registry:2` line in your other deploy script). Already running.
3. Edit the top of `deploy/deploy-sashaslides.sh` if needed: `DOMAIN`, `ACME_EMAIL`, `HOST_PORT` (6000 is free; change if it clashes).

## Deploy (from your local machine, like your other script)
```bash
cd renderer/html2slides/addon-server
bash deploy/deploy-sashaslides.sh
```
What it does (all additive):
1. Opens the `:5000` SSH tunnel, `docker compose build`s the image, pushes it to your registry.
2. Copies `docker-compose.yml` + `.env` + the nginx site to the server.
3. Remotely: pulls the image; `certbot certonly` for `sashaslides.com` (skips if valid — never touches other certs); installs the **new** nginx site (`sites-available` + `sites-enabled` symlink), `nginx -t`, `systemctl reload nginx` (graceful — existing sites unaffected); `docker compose -p sashaslides up -d` (its own project — your `/root/holosweat` stack is untouched).
4. **Firewall: `ufw allow 80/tcp` + `ufw allow 443/tcp` only — idempotent, no deletes/denies/reset.** Your existing rules stay exactly as they are.
5. `curl https://sashaslides.com/healthz` → `ok`.

## Updating later
- **UI/feature change** → re-run the script (rebuild + push + `up -d`). nginx/cert untouched.
- **Cert** → certbot's own systemd timer renews it; nothing to do.

## drawio editor (follow-up)
v1 ships without the drawio *editor* webapp (detection/export/oversampling all work; `/drawio` 503s). To enable in-slide editing, on your local machine: `git submodule update --init deps/drawio`, build its webapp, bake it into the image (a `COPY deps/drawio/src/main/webapp /app/drawio` line — ask me and I'll wire the Dockerfile + repo-root build context), then re-run the deploy.

## Rollback / removal (clean, leaves your stack intact)
```bash
ssh root@server.holosweat.com '
  docker compose -p sashaslides -f /root/sashaslides/docker-compose.yml down
  rm -f /etc/nginx/sites-enabled/sashaslides.com
  nginx -t && systemctl reload nginx'
# (cert + DNS can stay; ufw rules were only adds you already had)
```
