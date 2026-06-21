#!/usr/bin/env bash
# Push the current branch of every submodule (recursively) to origin.
# By default a plain push is used; pass --force to use --force-with-lease.
push_opt=""
for arg in "$@"; do
  case "$arg" in
    --force) push_opt="--force-with-lease" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

branch=$(git symbolic-ref --short HEAD) && git check-ref-format --branch "$branch" && git submodule foreach --recursive "
  case \"\$displaypath\" in
    workout/*holosweat.api)
      # The holosweat.api submodule nested inside workout is not ours to push;
      # skip it (the root-level \"api\" submodule is still pushed).
      echo \"skipping \$displaypath (api submodule nested inside workout)\" ;;
    *)
      git checkout -B '$branch' HEAD && (git push $push_opt origin '$branch' || echo 'push failed') ;;
  esac
"
