#!/usr/bin/env bash
# Name each submodule's current (detached) commit with the root module's branch,
# then pull that branch from origin. Mirrors push_all_submodules.sh.
branch=$(git symbolic-ref --short HEAD) && git check-ref-format --branch "$branch" && git submodule foreach --recursive "
  git checkout -B '$branch' HEAD && (git pull origin '$branch' || echo 'pull failed')
"
