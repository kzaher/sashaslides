# The Sasha Slides remote MCP connector (mcp/sasha-slides/server.ts --http).
#
# Built ON THE SERVER by deploy/publish.sh from a context that holds exactly the files
# context-files.ts lists (the server's import graph + the workflow skill + this
# directory), laid out at their repo-relative paths:
#
#   /app/mcp/sasha-slides/...                     the server, run by tsx
#   /app/.claude/skills/sasha-slides/SKILL.md     the client instructions it serves
#   /app/report-service/src/...                   the defect-report intake it mounts (--reports)
#
# Secrets and state are never baked in; docker-compose.yml mounts them.

FROM node:24-slim
WORKDIR /app

# Runtime dependencies, pinned by the lockfile in this directory.
COPY mcp/sasha-slides/deploy/package.json mcp/sasha-slides/deploy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY .claude/skills/sasha-slides/SKILL.md .claude/skills/sasha-slides/SKILL.md
COPY mcp/sasha-slides mcp/sasha-slides
COPY report-service/src report-service/src

# Fail the build, not the first request, when the context is short of a file: --help
# loads the whole import graph.
RUN node_modules/.bin/tsx mcp/sasha-slides/server.ts --help > /dev/null

# A dedicated unprivileged user. Not the image's `node` (uid 1000): on the server uid 1000
# is a login user, who would then own the secrets. The passwd entry matters: tsx calls
# os.userInfo(), which throws for a uid without one. publish.sh chowns data/ and the
# secret files to this uid (CONNECTOR_UID).
RUN groupadd -g 10100 sasha && useradd -u 10100 -g 10100 -M -d /nonexistent -s /usr/sbin/nologin sasha
USER sasha
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# --host 0.0.0.0 is inside the container only; compose publishes it on 127.0.0.1.
# --trusted-proxy: Docker's port proxy makes nginx's connections arrive from the network gateway
# (172.30.0.1 on sasha-connector_default, measured 2026-10-13), so X-Real-IP is believed from it
# alone. If the network is recreated with another gateway, the server warns once and counts every
# visitor as one client: stricter limits, never a bypass.
# --reports keeps the add-on's defect reports in /data/reports (report store + triage.jsonl), read at
# /account/reports by the verified addresses in SASHA_ADMIN_EMAILS (connector.env).
# An empty mail-sender.json (the deploy's placeholder) leaves email sign-in off. Comment watches
# need no secret file: they act as each signed-in user (SASHA_PICKER_API_KEY in connector.env
# turns on the /comments/allow picker).
ENTRYPOINT ["node_modules/.bin/tsx", "mcp/sasha-slides/server.ts", "--http", "--host", "0.0.0.0", "--port", "8787"]
CMD ["--public-url", "https://sashaslides.com", \
     "--store", "/data/oauth-store.json", "--key-store", "/data/account-keys.json", \
     "--google-client", "/run/secrets/google_oauth_web.json", \
     "--identity-providers", "/run/secrets/identity-providers.json", \
     "--mail-sender", "/run/secrets/mail-sender.json", \
     "--reports", "/data/reports", \
     "--trusted-proxy", "172.30.0.1"]
