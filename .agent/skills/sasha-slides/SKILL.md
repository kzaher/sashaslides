---
name: sasha-slides
description: Moved. The live skill is .claude/skills/sasha-slides/SKILL.md, which is where Claude Code discovers project skills. This directory keeps only the shell harness.
---

# Moved

The skill now lives at **`.claude/skills/sasha-slides/SKILL.md`** — verified discoverable by
Claude Code (it appears in its skill list and resolves as `/sasha-slides`).

Two copies of the same instructions drift, and a drifted skill is worse than none, so this
file is deliberately a pointer rather than a duplicate.

What stays here is the shell harness the skill calls:

```bash
.agent/skills/sasha-slides/sasha-slides.sh check --write   # auth gate
.agent/skills/sasha-slides/sasha-slides.sh e2e             # whole loop on a fake Drive
.agent/skills/sasha-slides/sasha-slides.sh selftest        # proves the assertions bite
```
