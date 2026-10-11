# nanobox guest image — a minimal glibc Ubuntu that boots inside a browser VM.
#
# Layout: one tiny base (glibc + certs + busybox, ~7 MB) and one image per agent CLI, so a browser
# only ever fetches the agent it is asked to boot. `--target` picks which image to build:
#
#   nanobox-base    minimal distro on its own (shell only)
#   nanobox-claude  + Claude Code       (`claude`)
#   nanobox-codex   + OpenAI Codex      (`codex`)
#   nanobox-agy     + Antigravity CLI   (`agy`)
#   nanobox-agents  + all three
#
# The CLIs are large (200-300 MB each, already stripped by their vendors) and that dominates the
# image; the distro underneath is deliberately near-nothing.

# --- the minimal distro -----------------------------------------------------------------------
# Built by copying just the glibc runtime, the CA bundle and a static busybox out of ubuntu:24.04,
# rather than by deleting things from it — the result is a real Ubuntu userland (same libc build,
# same certs) with nothing else in it.
FROM ubuntu:24.04 AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates busybox-static
RUN set -eux; \
    mkdir -p /rootfs/bin /rootfs/usr/bin /rootfs/usr/local/bin /rootfs/etc/ssl/certs \
             /rootfs/lib/x86_64-linux-gnu /rootfs/lib64 /rootfs/tmp /rootfs/root \
             /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/var/tmp; \
    chmod 1777 /rootfs/tmp /rootfs/var/tmp; \
    \
    cp /usr/bin/busybox /rootfs/bin/busybox; \
    for a in $(/usr/bin/busybox --list); do [ "$a" = busybox ] || ln -sf busybox "/rootfs/bin/$a"; done; \
    ln -sf busybox /rootfs/bin/sh; \
    \
    cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/; \
    \
    for l in libc.so.6 libm.so.6 libdl.so.2 librt.so.1 libpthread.so.0 libresolv.so.2 \
             libgcc_s.so.1 libnss_dns.so.2 libnss_files.so.2 libnsl.so.1; do \
      if [ -e "/lib/x86_64-linux-gnu/$l" ]; then cp -aL "/lib/x86_64-linux-gnu/$l" /rootfs/lib/x86_64-linux-gnu/; fi; \
    done; \
    cp -aL /lib64/ld-linux-x86-64.so.2 /rootfs/lib64/; \
    \
    printf 'root:x:0:0:root:/root:/bin/sh\n' > /rootfs/etc/passwd; \
    printf 'root:x:0:\n' > /rootfs/etc/group; \
    printf 'hosts: files dns\n' > /rootfs/etc/nsswitch.conf; \
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /rootfs/etc/resolv.conf; \
    printf '127.0.0.1 localhost\n' > /rootfs/etc/hosts; \
    printf 'nanobox\n' > /rootfs/etc/hostname; \
    printf 'NAME="nanobox"\nID=nanobox\nID_LIKE=ubuntu\nPRETTY_NAME="nanobox (minimal Ubuntu 24.04 glibc)"\n' > /rootfs/etc/os-release; \
    du -sh /rootfs

FROM scratch AS nanobox-base
COPY --from=rootfs /rootfs/ /
# Deliberately no SSL_CERT_FILE here. Inside the browser VM, container2wasm's init appends
# SSL_CERT_FILE=/.wasmenv/proxy.crt (its fetch-backed HTTPS proxy's CA) to the image's env — and
# since glibc's getenv returns the FIRST match, an SSL_CERT_FILE baked into the image would win and
# every TLS handshake through the proxy would fail. The CA bundle is still on disk at
# /etc/ssl/certs/ca-certificates.crt for anything that looks there by default.
ENV PATH=/usr/local/bin:/bin:/usr/bin \
    HOME=/root \
    TERM=xterm-256color \
    LANG=C.UTF-8
WORKDIR /root
CMD ["/bin/sh"]

# --- agent CLIs (downloaded with the vendors' own installers) -----------------------------------
FROM ubuntu:24.04 AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
WORKDIR /dl

FROM fetch AS fetch-claude
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp "$(readlink -f /root/.local/bin/claude)" /dl/claude \
    && chmod 755 /dl/claude

FROM fetch AS fetch-codex
ARG CODEX_VERSION=rust-v0.147.0
RUN curl -fsSL -o codex.tar.gz \
      "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz" \
    && tar xzf codex.tar.gz \
    && mv codex-x86_64-unknown-linux-musl /dl/codex \
    && chmod 755 /dl/codex

FROM fetch AS fetch-agy
RUN curl -fsSL https://antigravity.google/cli/install.sh -o install.sh \
    && bash install.sh --dir /dl/agybin \
    && mv /dl/agybin/agy /dl/agy \
    && chmod 755 /dl/agy

FROM nanobox-base AS nanobox-claude
COPY --from=fetch-claude /dl/claude /usr/local/bin/claude
CMD ["/usr/local/bin/claude"]

FROM nanobox-base AS nanobox-codex
COPY --from=fetch-codex /dl/codex /usr/local/bin/codex
CMD ["/usr/local/bin/codex"]

FROM nanobox-base AS nanobox-agy
COPY --from=fetch-agy /dl/agy /usr/local/bin/agy
CMD ["/usr/local/bin/agy"]

FROM nanobox-base AS nanobox-agents
COPY --from=fetch-claude /dl/claude /usr/local/bin/claude
COPY --from=fetch-codex  /dl/codex  /usr/local/bin/codex
COPY --from=fetch-agy    /dl/agy    /usr/local/bin/agy
CMD ["/bin/sh"]
