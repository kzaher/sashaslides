#!/bin/bash
# Symlink skills from /claude/skills/ into workspace .claude/skills/
# Runs at container start via postStartCommand

set -e

WORKSPACE="/workspaces/sashaslides"
SHARED_SKILLS="/claude/skills"
LOCAL_SKILLS="$WORKSPACE/.claude/skills"

if [ ! -d "$SHARED_SKILLS" ]; then
  echo "setup-claude: /claude/skills not found, skipping skill symlinks"
  exit 0
fi

mkdir -p "$LOCAL_SKILLS"

for skill in "$SHARED_SKILLS"/*; do
  [ -e "$skill" ] || continue
  name="$(basename "$skill")"
  target="$LOCAL_SKILLS/$name"
  # Remove existing file/symlink to ensure fresh link
  rm -f "$target"
  ln -s "$skill" "$target"
  echo "setup-claude: linked $name"
done

echo "setup-claude: done"
