#!/usr/bin/env npx tsx
/**
 * check-google-auth.ts — pre-flight Google OAuth check for bug_solving runs.
 *
 * Exits 0 if the saved token can mint/refresh an access token, or 1 (with
 * re-auth instructions) if the grant is dead. The scaffolding runs this BEFORE
 * creating worktrees so an expired token fails loudly up front instead of
 * letting every `record-rendering --mode full` upload silently fail with
 * `invalid_grant` (swallowed by step-7's `|| true`) and leave the rating
 * servers empty after a whole multi-cluster run.
 *
 *   npx tsx renderer/structured-prompts/bug_solving/scripts/check-google-auth.ts
 */
import { assertGoogleAuthFresh } from "./record-rendering-lib.js";

assertGoogleAuthFresh()
  .then((r) => {
    const exp = r.expiry ? new Date(r.expiry).toISOString() : "unknown";
    console.log(`[auth-preflight] OK — Google token valid (access token expires ${exp})`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[auth-preflight] FAILED — ${(e as Error).message}`);
    console.error("[auth-preflight] The Google OAuth grant is dead/expired. Re-authorize with:");
    console.error("[auth-preflight]   npx tsx /workspaces/sashaslides/.auth/generate-token.ts");
    process.exit(1);
  });
