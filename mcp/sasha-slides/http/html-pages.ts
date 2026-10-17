/**
 * The server-rendered pages' kit: one stylesheet ("Tidepool", the `/account` look), the headers
 * every page answers with, the page layout, the one-message page, and HTML escaping. The account
 * portal, the `/comments/allow` page and the connector's consent page all draw with it, so they
 * cannot drift apart again.
 *
 * Pages run no inline script, and the CSP admits exactly this stylesheet by hash, so no
 * `'unsafe-inline'` is needed. A page that loads a script names its absolute URL in its own policy.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { SASHA_ICON_SVG } from "./sasha-icon.generated";

/** One stylesheet for every page, so the CSP can admit it by hash. */
const STYLE = `
:root{--bg:#EEF1F6;--fg:#1C2333;--muted:#4B5468;--line:rgba(28,35,51,.12);--panel:rgba(255,255,255,.62);--panel-edge:rgba(255,255,255,.85);--link:#4338CA;--danger:#c4161c;--sans:"Manrope","Helvetica Neue",Helvetica,Arial,system-ui,-apple-system,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0E1220;--fg:#EEF1F8;--muted:#AEB6C9;--line:rgba(255,255,255,.12);--panel:rgba(36,46,72,.62);--panel-edge:rgba(255,255,255,.16);--link:#A5B4FC;--danger:#ff6961;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
.bar{border-bottom:1px solid var(--line)}
.bar-inner,.wrap{max-width:560px;margin:0 auto;padding-inline:16px}
.bar-inner{display:flex;align-items:center;height:52px}
.brand{color:var(--fg);font-weight:600;letter-spacing:-.01em;display:inline-flex;align-items:center;gap:10px}
.brand svg{width:26px;height:26px}
.wrap{padding-block:48px 80px}
h1{font-size:clamp(28px,6vw,40px);letter-spacing:-.03em;line-height:1.1;margin:0 0 12px;font-weight:600}
h2{font-size:20px;letter-spacing:-.015em;margin:36px 0 8px;font-weight:600}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.providers{display:grid;gap:12px;margin-top:28px}
.button,button{display:block;width:100%;padding:13px 18px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;font-weight:500;text-align:center;cursor:pointer}
.button:hover{text-decoration:none;border-color:var(--muted)}
.button{display:flex;align-items:center;justify-content:center;gap:12px}
.button .mark{width:20px;height:20px;flex:none}
.button-apple{background:#000;border-color:#000;color:#fff}
.button-apple:hover{border-color:#000;opacity:.85}
@media (prefers-color-scheme:dark){.button-apple{background:#fff;border-color:#fff;color:#000}.button-apple:hover{border-color:#fff}}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.quiet{display:inline;width:auto;padding:0;border:0;background:none;color:var(--link);font-weight:400}
ul.links{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
ul.links li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
.hint{color:var(--muted);word-break:break-all}
label.confirm{display:flex;gap:10px;align-items:flex-start;margin:16px 0}
label.confirm input{flex:none;width:18px;height:18px;margin-top:4px}
form.signout{margin-top:32px}
[hidden]{display:none!important}
.passkeys{margin-top:16px}
.providers[data-passkeys]{margin-top:12px}
.status{margin:0;color:var(--danger)}
label.field{display:block;margin:16px 0 0;font-weight:500}
label.field input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit;font-weight:400}
label.field+button,label.field~button{margin-top:22px}
.error{color:var(--danger);font-weight:500}
.alternatives{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px 20px}
ul.links li{align-items:center}
.method{display:flex;flex-direction:column;min-width:0}
.method-name{font-weight:500}
.method-side{display:flex;align-items:center;gap:16px;color:var(--muted);font-size:15px}
form.inline{display:inline;margin:0}
.notice{margin-top:16px;padding:16px 18px;border-radius:14px;background:var(--panel);border:1px solid var(--panel-edge)}
.notice p{margin:0 0 14px}
button:disabled{cursor:default;opacity:.6}
button[data-open],a.button.retry{margin-top:28px}
.picker-status{margin-top:16px}
.picker-status.done{font-weight:500}
`;

/** The CSP admits exactly this stylesheet by hash. */
export const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE, "utf-8").digest("base64")}'`;

/** A page's headers under the default policy: this stylesheet, no script, no frames. */
export function pageHeaders(options: Readonly<{ formAction: "'self'" | "'none'" }>): Readonly<Record<string, string>> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src ${STYLE_HASH}; form-action ${options.formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Keeps a callback's code and state out of any Referer a later navigation sends.
    "referrer-policy": "no-referrer",
  };
}

export function sendHtml(
  options: Readonly<{ response: ServerResponse; status: number; html: string; headers: Readonly<Record<string, string>>; cookies?: readonly string[] }>,
): void {
  const { response, status, html, cookies } = options;
  response.writeHead(status, {
    ...options.headers,
    "content-length": String(Buffer.byteLength(html, "utf-8")),
    ...(cookies === undefined || cookies.length === 0 ? {} : { "set-cookie": [...cookies] }),
  });
  response.end(html);
}

export function sendScript(options: Readonly<{ response: ServerResponse; script: string }>): void {
  options.response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": String(Buffer.byteLength(options.script, "utf-8")),
    // Revalidated on every page load, so a deploy is picked up at once.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  options.response.end(options.script);
}

export function layout(options: Readonly<{ title: string; main: string; scriptUrl?: string }>): string {
  const script = options.scriptUrl === undefined ? "" : `\n<script src="${escapeHtml(options.scriptUrl)}" defer></script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Sasha Slides</title>
<style>${STYLE}</style>${script}
</head>
<body>
<header class="bar"><div class="bar-inner"><a class="brand" href="https://sashaslides.com/">${SASHA_ICON_SVG}Sasha Slides</a></div></header>
<main class="wrap">
${options.main}
</main>
</body>
</html>
`;
}

export function messagePage(
  options: Readonly<{ title: string; message: string; action?: Readonly<{ href: string; label: string }> }>,
): string {
  const action =
    options.action === undefined ? "" : `<p><a href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a></p>`;
  return layout({
    title: options.title,
    main: `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${action}`,
  });
}

/** Escapes text for an HTML element body or a double- or single-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
