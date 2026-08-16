# nanobox-linux-base: the smallest Linux userland the sandbox needs and NOTHING else — busybox, CA
# certificates, glibc + libstdc++ (the official Node.js binary is glibc-linked and needs libstdc++).
# No node, no CLI: the first-run installer (web/native/installer.js) fetches node-linux-x64 + npm and
# the CLIs (claude / codex / agy) from the vendors' servers into the persistent /usr/local the VM mounts.
#
# Same rootfs recipe as ../claude-npm/Dockerfile (nanobox-base + libstdc++), minus everything else.
# Built by ../../build-linux-base.sh, which also exports it as an OCI layout for the browser VM.
# --- the minimal distro (identical recipe to nanobox-base, plus libstdc++ for node) --------------
FROM ubuntu:24.04 AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates busybox-static
RUN set -eux; \
    mkdir -p /rootfs/bin /rootfs/usr/bin /rootfs/usr/local/bin /rootfs/usr/local/lib/node_modules /rootfs/etc/ssl/certs \
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
    printf 'root:x:0:0:root:/root:/bin/sh\n' > /rootfs/etc/passwd; \
    printf 'root:x:0:\n' > /rootfs/etc/group; \
    printf 'hosts: files dns\n' > /rootfs/etc/nsswitch.conf; \
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /rootfs/etc/resolv.conf; \
    printf '127.0.0.1 localhost\n' > /rootfs/etc/hosts; \
    printf 'nanobox\n' > /rootfs/etc/hostname; \
    printf 'NAME="nanobox"\nID=nanobox\nID_LIKE=ubuntu\nPRETTY_NAME="nanobox (minimal Ubuntu 24.04 glibc)"\n' > /rootfs/etc/os-release; \
    du -sh /rootfs

# --- the image ---------------------------------------------------------------------------------------
FROM scratch AS nanobox-linux-base
COPY --from=rootfs /rootfs/ /
ENV PATH=/usr/local/bin:/bin:/usr/bin \
    HOME=/root \
    TERM=xterm-256color \
    LANG=C.UTF-8
WORKDIR /root
CMD ["/bin/sh"]
