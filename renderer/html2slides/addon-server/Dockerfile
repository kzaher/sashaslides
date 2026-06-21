# html2slides addon-server — the UI/API behind the Google Slides add-on.
# Plain HTTP on $PORT; TLS + Let's Encrypt are handled by Caddy (see compose).
FROM node:22-slim AS base
WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm install tsx @types/node @types/pngjs --no-audit --no-fund

# App source + UI assets.
COPY server.ts ./
COPY api ./api
COPY public ./public

# The self-hosted drawio webapp is mounted in at runtime (see compose volume) so
# the image stays small and drawio is version-pinned by the host submodule.
# Expected mount: /app/../deps/drawio  ->  resolved by server.ts DRAWIO_CANDIDATES.
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787

# Liveness for Caddy/compose.
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
