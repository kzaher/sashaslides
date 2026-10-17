# The sashaslides.com website image. Multi-stage, so a deploy is never stale and needs no build
# tools on the machine that starts it (deploy/publish.sh builds it on the server).
#
#   builder (native architecture; emits platform-neutral JavaScript):
#     npm install at the repository root (esbuild, jszip) and npm ci in the site (preact),
#     then the developer page's bundles: `npm run build` (dev/build.ts) -> public/dev.js,
#     public/dev-pptx.js (pptxgenjs FORK bundled from deps/pptxgenjs/src) and public/e2e-drawio.js.
#   runtime (amd64, the server): server.ts + pages.ts + public/ + the draw.io webapp, run by tsx.
#
# The type check is not run here: it is `npm test` / `npm run typecheck` in the site, before a deploy.
# Build context is the REPOSITORY ROOT (docker-compose.yml); .dockerignore trims it. Every source
# directory the bundles read must be COPYed below (dev/build.test.ts checks this) AND packed into
# deploy/publish.sh's site tarball.

# ---- builder ------------------------------------------------------------------------------------
FROM node:22 AS builder
WORKDIR /src

COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY renderer/html2slides/addon-server/package.json renderer/html2slides/addon-server/package-lock.json ./renderer/html2slides/addon-server/
RUN cd renderer/html2slides/addon-server && npm ci --no-audit --no-fund

# The pptxgenjs fork's TypeScript source (bundled directly; its package.json carries the browser map).
COPY deps/pptxgenjs/package.json ./deps/pptxgenjs/package.json
COPY deps/pptxgenjs/src ./deps/pptxgenjs/src
# The product converter and the deck API contracts and readers the page shares with the connector.
COPY mcp/sasha-slides/converter ./mcp/sasha-slides/converter
COPY mcp/sasha-slides/engine/src/contracts ./mcp/sasha-slides/engine/src/contracts
COPY mcp/sasha-slides/engine/src/shared ./mcp/sasha-slides/engine/src/shared
COPY mcp/sasha-slides/engine/src/web/parsing ./mcp/sasha-slides/engine/src/web/parsing
COPY mcp/sasha-slides/google-slides/insert-html-contract.ts mcp/sasha-slides/google-slides/slides-client.ts ./mcp/sasha-slides/google-slides/
COPY renderer ./renderer
RUN cd renderer/html2slides/addon-server && npm run build \
  && test -s public/dev.js && test -s public/dev-pptx.js && test -s public/e2e-drawio.js

# The build date, served at /build-info.json so a deploy can be confirmed. Declared after the heavy
# steps and passed fresh each deploy, so only this cheap layer reruns when nothing else changed.
ARG BUILD_DATE=unknown
RUN printf '{"buildDate":"%s"}\n' "$BUILD_DATE" > renderer/html2slides/addon-server/public/build-info.json

# ---- runtime ------------------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-slim AS runtime
WORKDIR /app
COPY --from=builder /src/renderer/html2slides/addon-server/package.json ./
# The server has no dependencies of its own (node builtins only); tsx runs its TypeScript.
RUN npm install --omit=dev --no-audit --no-fund --no-save tsx@4
COPY --from=builder /src/renderer/html2slides/addon-server/server.ts ./
COPY --from=builder /src/renderer/html2slides/addon-server/pages.ts ./
COPY --from=builder /src/renderer/html2slides/addon-server/public ./public
# The self-hosted draw.io editor. server.ts resolves it at join(/app, "../../../deps/drawio/src/main/webapp"),
# which is /deps/drawio/src/main/webapp; copied straight from the build context.
COPY deps/drawio/src/main/webapp /deps/drawio/src/main/webapp
# Fail loudly if the webapp did not make it in, rather than ship a 503 at /drawio/.
RUN test -f /deps/drawio/src/main/webapp/index.html \
  || (echo "FATAL: drawio webapp missing: git submodule update --init deps/drawio" && exit 1)

ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server.ts"]
