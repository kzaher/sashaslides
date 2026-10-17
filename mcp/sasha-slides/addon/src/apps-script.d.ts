// The two globals an HtmlService page is handed by its host, declared rather than imported.
//
// `google.script.run` is injected into an HtmlService page by Apps Script itself -- there is no
// package to install and `@types/google-apps-script` only types the SERVER side (SlidesApp,
// UrlFetchApp, ...), not this client shim. It is declared with the real function signatures
// instead of an index signature so a typo in a function name is a compile error and not a silent
// "script function not found" at runtime.
//
// EVERY SURFACE GETS THE SAME SHIM. Each HtmlService document is injected its own
// `google.script.run`; none uses every function, but the shim is one declaration because Code.gs is
// one file -- and its function list is bridge.ts's `ServerFunctionArgs`, not restated here.

import type { ServerFunctions } from "./bridge.ts";

declare global {
  /**
   * The compiled `renderer/html2slides/extract-dom.ts` IIFE, BASE64-encoded and inlined by
   * build-addon.ts via esbuild `--define`. It is a script, not a module (it has no `export`), which
   * is why the bundler has to be the thing that carries it; base64 is why HtmlService's sanitiser
   * cannot corrupt it on the way into the sidebar (see build-addon.ts step 2).
   */
  const __SASHA_EXTRACTOR_JS_B64__: string;

  /**
   * The absolute path of the checkout the add-on was built from, inlined by build-addon.ts so the
   * sidebar's Dev tab can print the exact `claude mcp add` command instead of a placeholder.
   * Defined for the sidebar bundle only.
   */
  const __SASHA_REPO_ROOT__: string;

  /**
   * Where the deck editor and the self-hosted draw.io editor live (`SASHA_EDITOR_ORIGIN`, default
   * https://sashaslides.com), inlined by build-addon.ts for the slides window and the diagram dialog.
   */
  const __SASHA_EDITOR_ORIGIN__: string;

  /**
   * The hosted connector's `https://<host>/mcp` address, from `SASHA_CONNECTOR_URL` at build time,
   * or null when the build was given none. Defined for the sidebar bundle only.
   */
  const __SASHA_CONNECTOR_URL__: string | null;

  /**
   * One pending `google.script.run` call. Each `withSuccessHandler` / `withFailureHandler` returns
   * a new runner, and the call itself returns void -- the result arrives through the handlers.
   */
  type AppsScriptRunner = Readonly<{
    withSuccessHandler(handler: (value: unknown) => void): AppsScriptRunner;
    withFailureHandler(handler: (error: unknown) => void): AppsScriptRunner;
  }> &
    ServerFunctions;

  const google: Readonly<{
    script: Readonly<{
      run: AppsScriptRunner;
      /** Only present in a real sidebar; the standalone smoke page has no host chrome to close. */
      host?: Readonly<{ close(): void }>;
    }>;
  }>;
}
