// THE RUNNER PAGE: the document the sandboxed frame loads on the runner's own site, and the content
// security policy its server must send with it (transition-protocol.ts header). Built by
// build-presenter.ts next to the bundled bootstrap.
//
// The policy allows no network at all -- no `connect-src`, nothing but `self` for scripts (the
// bootstrap file) and `blob:` (the transition script, which the bootstrap turns into a blob
// address because a policy without `unsafe-eval` and `unsafe-inline` scripts cannot run text any
// other way), inline styles for the slides' inline styling, and `blob:`/`data:` images and fonts
// built from the bytes the host transfers. The same policy is repeated in a meta element, so a page
// served without the header (a static file server in a test) is no less locked down.

export const RUNNER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' blob:",
  "style-src 'unsafe-inline' blob:",
  "img-src blob: data:",
  "font-src blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const RUNNER_BOOTSTRAP_FILE = "runner-bootstrap.js";

export function runnerPageMarkup(options: Readonly<{ bootstrapAddress: string }>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${RUNNER_CONTENT_SECURITY_POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sasha transition runner</title>
<style>html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }</style>
</head>
<body>
<script src="${options.bootstrapAddress}"></script>
</body>
</html>
`;
}
