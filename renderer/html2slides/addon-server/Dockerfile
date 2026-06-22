# html2slides addon-server — multi-stage build so a deploy is NEVER stale and
# needs NO build tools on your machine (just Docker). Everything that can go
# stale (the pptxgenjs fork browser bundle, the convert-bundle, Code.gs) is
# rebuilt from source here, every build.
#
#   builder (native arch — fast on an Apple-Silicon Mac; emits platform-neutral JS):
#     • npm install root deps (esbuild, tsx, …)
#     • build the pptxgenjs FORK browser bundle  (rollup + gulp ship → pptxgen.bundle.js, WITH our fixes)
#     • build convert-bundle.js (Insert) + Code.gs via build-addon.ts
#     • assemble everything into addon-server/public
#   runtime (amd64 — matches the server; just serves the built artifacts):
#
# Build context is the REPO ROOT (see compose). .dockerignore trims it.

# ---- builder: native arch (no --platform) so npm/rollup/esbuild run natively ----
FROM node:22 AS builder
WORKDIR /src

# root deps first (layer cache): esbuild + tsx for build-addon, googleapis/jszip/pngjs.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Build the pptxgenjs fork browser bundle FROM SOURCE (never the stale checked-in one).
COPY deps/pptxgenjs ./deps/pptxgenjs
RUN cd deps/pptxgenjs \
  && npm install --no-audit --no-fund \
  && npm run build \
  && npm run ship          # → dist/pptxgen.bundle.js with our gradient/round2/group fixes

# Build the UI/Insert bundle + Code.gs from source.
COPY renderer ./renderer
ARG SERVER_ORIGIN=https://sashaslides.com
RUN SERVER_ORIGIN=$SERVER_ORIGIN npx tsx renderer/html2slides/browser/build-addon.ts \
  && cp deps/pptxgenjs/dist/pptxgen.bundle.js renderer/html2slides/addon-server/public/pptxgen.bundle.js \
  && cp dist/renderer/html2slides/addon/Code.gs   renderer/html2slides/addon-server/public/Code.gs \
  && cp dist/renderer/html2slides/addon/appsscript.json renderer/html2slides/addon-server/public/appsscript.json \
  && echo "built: $(ls -1 renderer/html2slides/addon-server/public | tr '\n' ' ')"

# Stamp the build date so the UI shows when it was last refreshed. Declared AFTER
# the heavy steps + passed fresh each deploy, so it only re-runs this cheap layer
# (and updates the stamp even when the rest of the build is fully cached).
ARG BUILD_DATE=unknown
RUN printf '{"buildDate":"%s"}\n' "$BUILD_DATE" > renderer/html2slides/addon-server/public/build-info.json

# ---- runtime: amd64 (the deploy target) ----------------------------------------
FROM --platform=linux/amd64 node:22-slim
WORKDIR /app
COPY --from=builder /src/renderer/html2slides/addon-server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm install tsx @types/node @types/pngjs --no-audit --no-fund
COPY --from=builder /src/renderer/html2slides/addon-server/server.ts ./
COPY --from=builder /src/renderer/html2slides/addon-server/registry.ts ./
COPY --from=builder /src/renderer/html2slides/addon-server/api ./api
COPY --from=builder /src/renderer/html2slides/addon-server/public ./public
# Self-hosted drawio editor. server.ts resolves DRAWIO_DIR as
# join(HERE=/app, "../../../deps/drawio/src/main/webapp") → /deps/drawio/src/main/webapp,
# so copy the prebuilt webapp (straight from the build context, not the builder stage)
# to exactly that path. Enables /drawio/* + flips CONFIG.drawioAvailable=true.
COPY deps/drawio/src/main/webapp /deps/drawio/src/main/webapp
# Fail LOUD if the webapp didn't make it in (e.g. deps/drawio not populated on the
# build host) — far better than silently shipping a 503 "submodule not populated".
RUN test -f /deps/drawio/src/main/webapp/index.html \
  || (echo "FATAL: drawio webapp missing — run: git clone --depth 1 https://github.com/jgraph/drawio.git deps/drawio" && exit 1)

ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server.ts"]
