#!/bin/bash
# Start a Docker daemon that actually works inside this devcontainer, for vm-build/build.sh.
#
#   sudo unshare -m --propagation private ./vm-build/start-docker.sh &
#   export DOCKER_HOST=unix:///tmp/xdgrt-1000/docker.sock
#
# A plain dockerd can't run containers here: even root lacks CAP_MKNOD/CAP_NET_ADMIN, so runc's
# container init fails. Rootless mode (RootlessKit + slirp4netns) avoids both — but it needs, first:
#
#   apt-get install -y docker.io uidmap slirp4netns fuse-overlayfs nftables
#   mknod /dev/net/tun c 10 200 && chmod 666 /dev/net/tun
#   echo "node:100000:65536" | tee /etc/subuid /etc/subgid
#   curl -sSL https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-27.5.1.tgz \
#     | tar xz -C /usr/bin --strip-components=1
#   mkdir -p ~/.config/docker && echo '{"storage-driver":"vfs"}' > ~/.config/docker/daemon.json
#   update-alternatives --set iptables /usr/sbin/iptables-nft   # legacy has no kernel tables here
#
# Run rootless dockerd in a private mount namespace with an UNMASKED /proc
# (the kernel refuses proc mounts inside a userns when the visible /proc is masked).
mount --make-rprivate / 2>/dev/null
mount -t proc proc /proc
# same story for sysfs: the outer /sys has masked read-only submounts. mount(8) refuses a plain
# re-mount over /sys ("already mounted"), so mount a clean one aside and move it into place.
mkdir -p /run/cleansys && mount -t sysfs sysfs /run/cleansys && mount --move /run/cleansys /sys
# the fresh sysfs has no cgroup tree; runc requires one in mountinfo
mount -t cgroup2 none /sys/fs/cgroup
export XDG_RUNTIME_DIR=/tmp/xdgrt-1000
export PATH=/usr/bin:/usr/sbin:/sbin:/bin
exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all \
  env HOME=/home/node XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR PATH=$PATH \
  /usr/bin/dockerd-rootless.sh
