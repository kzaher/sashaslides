---
name: e2e-test
description: Run E2E test suite for html2slides converter — screenshots, converts, compares, and launches SxS review
user_invocable: true
---

Run the E2E test suite for the HTML→Google Slides converter. Execute the script at `.claude/skills/e2e-test.sh`.

The test suite:
1. Screenshots all 30 HTML fixture slides (originals)
2. Converts them to Google Slides via the API (creates a NEW presentation each time)
3. Exports Slides API thumbnails
4. Compares current thumbnails vs previous blessed snapshots → detects regressions
5. Launches SxS rating server for manual review

Arguments: `[--parallelism N] [--skip-convert] [--port N]`

Rating keys in the SxS UI:
- `g` = good → saved to eval-set + snapshots blessed
- `b` = focus comment box (type issue, then Enter = bad) → saved to eval-set
- `s` = skip → NOT saved to eval-set
- `→/n` = next, `←/p` = prev

Each slide shows links to "View HTML Source" and "Open in Google Slides" for inspection.

**IMPORTANT — After launching the rating server:**
- Monitor the user's rating comments by polling `ratings.json` in the latest run's `sxs/` directory.
- When the user rates slides as "bad" with comments, read those comments and use them to fix the converter.
- Re-run the pipeline after fixes and present updated results.
- Do NOT wait for the user to tell you about comments — proactively check `ratings.json` periodically.

Directory structure:
```
e2e/
  fixtures/     ← 30 HTML test slides
  snapshots/    ← blessed thumbnails from accepted runs
  runs/<ts>/    ← per-run artifacts (originals, thumbs, diff-report, sxs/)
  eval-set/     ← rated slides (good+bad, with fixture HTML + images)
```

Examples:
```
/e2e-test
/e2e-test --parallelism 10
/e2e-test --skip-convert --port 3456
```
