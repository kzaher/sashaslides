# nanobox-claude-npm: Claude Code installed the OFFICIAL npm way on a system Node.js, on top of the
# same minimal glibc Ubuntu rootfs the other nanobox images use (see ../../../vm-build/Dockerfile).
#
#   /usr/local/bin/node     official Node.js 22 binary (from the node:22-bookworm-slim image)
#   /usr/local/lib/node_modules/@anthropic-ai/claude-code   `npm install -g @anthropic-ai/claude-code`
#   /usr/local/bin/claude   -> ../lib/node_modules/@anthropic-ai/claude-code/cli.js (#!/usr/bin/env node)
#
# Built by ../../build-claude-npm.sh, which also exports it as an OCI layout for the browser VM.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.112

# --- the minimal distro (identical recipe to nanobox-base, plus libstdc++ for node) --------------
FROM ubuntu:24.04 AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates busybox-static
RUN set -eux; \
    mkdir -p /rootfs/bin /rootfs/usr/bin /rootfs/usr/local/bin /rootfs/usr/local/lib /rootfs/etc/ssl/certs \
             /rootfs/lib/x86_64-linux-gnu /rootfs/lib64 /rootfs/tmp /rootfs/root \
             /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/var/tmp; \
    chmod 1777 /rootfs/tmp /rootfs/var/tmp; \
    cp /usr/bin/busybox /rootfs/bin/busybox; \
    for a in $(/usr/bin/busybox --list); do [ "$a" = busybox ] || ln -sf busybox "/rootfs/bin/$a"; done; \
    ln -sf busybox /rootfs/bin/sh; \
    ln -sf ../../bin/busybox /rootfs/usr/bin/env; \
    cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/; \
    for l in libc.so.6 libm.so.6 libdl.so.2 librt.so.1 libpthread.so.0 libresolv.so.2 \
             libgcc_s.so.1 libnss_dns.so.2 libnss_files.so.2 libnsl.so.1 libstdc++.so.6; do \
      if [ -e "/lib/x86_64-linux-gnu/$l" ]; then cp -aL "/lib/x86_64-linux-gnu/$l" /rootfs/lib/x86_64-linux-gnu/; fi; \
    done; \
    cp -aL /lib64/ld-linux-x86-64.so.2 /rootfs/lib64/; \
    ln -sf ../lib/node_modules/@anthropic-ai/claude-code/cli.js /rootfs/usr/local/bin/claude; \
    printf 'root:x:0:0:root:/root:/bin/sh\n' > /rootfs/etc/passwd; \
    printf 'root:x:0:\n' > /rootfs/etc/group; \
    printf 'hosts: files dns\n' > /rootfs/etc/nsswitch.conf; \
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /rootfs/etc/resolv.conf; \
    printf '127.0.0.1 localhost\n' > /rootfs/etc/hosts; \
    printf 'nanobox\n' > /rootfs/etc/hostname; \
    printf 'NAME="nanobox"\nID=nanobox\nID_LIKE=ubuntu\nPRETTY_NAME="nanobox (minimal Ubuntu 24.04 glibc)"\n' > /rootfs/etc/os-release; \
    du -sh /rootfs

# --- Claude Code from npm, on the official Node.js image ------------------------------------------
FROM ${NODE_IMAGE} AS claude
ARG CLAUDE_CODE_VERSION
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && cd /usr/local/lib/node_modules/@anthropic-ai/claude-code \
    && (ls vendor 2>/dev/null || true) \
    # keep only the linux-x64 ripgrep (the package ships one per platform)
    && (cd vendor/ripgrep 2>/dev/null && for d in *; do [ "$d" = x64-linux ] || rm -rf "$d"; done || true) \
    && du -sh /usr/local/lib/node_modules/@anthropic-ai/claude-code \
    && node --version && ./cli.js --version

# --- the image -------------------------------------------------------------------------------------
FROM scratch AS nanobox-claude-npm
COPY --from=rootfs /rootfs/ /
COPY --from=claude /usr/local/bin/node /usr/local/bin/node
COPY --from=claude /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
ENV PATH=/usr/local/bin:/bin:/usr/bin \
    HOME=/root \
    TERM=xterm-256color \
    LANG=C.UTF-8
WORKDIR /root
CMD ["/usr/local/bin/claude"]
