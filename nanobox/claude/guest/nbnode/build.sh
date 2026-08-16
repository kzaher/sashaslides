#!/usr/bin/env bash
# Build nbnode.
#   ./build.sh          static x86-64 musl binary -> ./nbnode   (alpine gcc in docker, same recipe as hctest)
#   ./build.sh host     native build -> ./nbnode-host            (for `node test.mjs`, no docker needed)
#   ./build.sh test     build host + run the socketpair unit test
# Extra CFLAGS: CFLAGS="-DNBNODE_DEBUG" ./build.sh   (stderr tracing on by default; NBNODE_DEBUG=1 -> LOG frames)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export DOCKER_HOST="${DOCKER_HOST:-unix:///tmp/xdgrt-1000/docker.sock}"
CFLAGS="${CFLAGS:-}"
case "${1:-static}" in
  static)
    docker run --rm -v "$PWD":/w -w /w alpine:3.20 sh -c \
      "apk add -q gcc musl-dev && gcc -std=gnu11 -Wall -Wextra -static -O2 -s $CFLAGS -o nbnode nbnode.c && ls -la nbnode && file nbnode 2>/dev/null || true"
    ;;
  host) gcc -std=gnu11 -Wall -Wextra -O2 -g $CFLAGS -o nbnode-host nbnode.c && ls -la nbnode-host ;;
  test) "$0" host && exec node test.mjs ./nbnode-host ;;
  *) echo "usage: $0 [static|host|test]" >&2; exit 2 ;;
esac
