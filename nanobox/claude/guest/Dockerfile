# Tiny deterministic guest image for the tier-1 (node) differential harness: static busybox + the
# CPU test programs. Built by ../build-guest.sh, which also turns it into a c2w /pack.
FROM busybox:1.36.1-musl
COPY tests/bin/ /tests/
CMD ["/tests/run.sh"]
