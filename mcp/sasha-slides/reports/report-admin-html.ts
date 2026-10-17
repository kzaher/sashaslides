/**
 * The defect-report pages' markup: the overview, one report, and the short message pages. Pure
 * string building over values the data layer (report-service/src/report-overview.ts) decided; every
 * interpolated value goes through `escapeHtml`.
 *
 * Their policy is the account portal's, widened by exactly what these pages need: `img-src 'self'`
 * for the screenshots and `frame-src 'self'` for the slide. No script anywhere, so the forms are
 * plain HTML forms and the filters are a GET form.
 *
 * WHY THE SLIDE IS AN IFRAME OF ITS OWN ROUTE. The slide is HTML a stranger submitted. It is served
 * by `/account/reports/<id>/slide` under `Content-Security-Policy: sandbox` (no scripts, an opaque
 * origin, even when opened directly) and embedded with an empty `sandbox` attribute, so it can
 * neither run nor reach this origin's cookies. See report-admin.ts.
 */
import { createHash } from "node:crypto";
import type { DefectReport, ReportAnnotation } from "../../../report-service/src/defect-report.ts";
import {
  overviewQuery,
  shortened,
  type OverviewFilter,
  type ReportSummary,
} from "../../../report-service/src/report-overview.ts";
import type { ReportIndexEntry } from "../../../report-service/src/report-store.ts";
import { describeStatus, REPORT_STATUSES, type ReportStatus, type Triage } from "../../../report-service/src/report-triage.ts";
import { escapeHtml } from "../http/html-pages";
import { SASHA_ICON_SVG } from "../http/sasha-icon.generated";
import { REPORTS_PATH } from "../http/account-portal";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

const STYLE = `
:root{--bg:#EEF1F6;--fg:#1C2333;--muted:#4B5468;--line:rgba(28,35,51,.14);--panel:#fff;--link:#4338CA;--danger:#c4161c;--new:#1d4ed8;--triaged:#a16207;--fixed:#15803d;--wontfix:#6b7280;--sans:"Manrope","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0E1220;--fg:#EEF1F8;--muted:#AEB6C9;--line:rgba(255,255,255,.14);--panel:#182033;--link:#A5B4FC;--danger:#ff6961;--new:#93c5fd;--triaged:#fcd34d;--fixed:#86efac;--wontfix:#cbd5e1;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.5}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
.bar{border-bottom:1px solid var(--line)}
.bar-inner,.wrap{max-width:1040px;margin:0 auto;padding-inline:16px}
.bar-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;flex-wrap:wrap}
.brand{color:var(--fg);font-weight:600;display:inline-flex;align-items:center;gap:10px}.brand svg{width:24px;height:24px}
.who{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.wrap{padding-block:28px 64px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 6px;font-weight:600}
h2{font-size:17px;margin:28px 0 10px;font-weight:600}
p{margin:0 0 10px}.muted{color:var(--muted)}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 12px}
.tab{padding:5px 12px;border:1px solid var(--line);border-radius:999px;color:var(--fg);background:var(--panel)}
.tab[aria-current="page"]{border-color:var(--link);color:var(--link);font-weight:600}
form.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0 0 18px}
label.field{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);min-width:0}
input,select,textarea{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 9px;max-width:100%}
input[type=search]{width:240px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
button.primary{background:var(--link);border-color:var(--link);color:#fff}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.when{white-space:nowrap}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.status-new{color:var(--new)}.status-triaged{color:var(--triaged)}.status-fixed{color:var(--fixed)}.status-wontfix{color:var(--wontfix)}
.tone-leak{color:var(--danger)}.tone-risk{color:var(--triaged)}.tone-note{color:var(--muted)}
.empty{padding:28px;text-align:center;color:var(--muted)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.panel+.panel{margin-top:14px}
.panel form{display:flex;flex-direction:column;gap:8px}
dl.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0}
dl.meta dt{color:var(--muted)}dl.meta dd{margin:0;overflow-wrap:anywhere}
blockquote{margin:0;padding:10px 14px;border-left:3px solid var(--link);background:var(--panel);border-radius:0 8px 8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.stage{width:640px;height:360px;overflow:hidden;border:1px solid var(--line);border-radius:10px;background:#fff}
.stage iframe{width:1280px;height:720px;border:0;transform:scale(.5);transform-origin:0 0;display:block}
@media (max-width:720px){.stage{width:320px;height:180px}.stage iframe{transform:scale(.25)}}
ol.annotations{margin:0;padding-left:20px}ol.annotations li{margin:0 0 10px}
.shots{display:flex;flex-wrap:wrap;gap:12px}
.shots figure{margin:0;max-width:100%}.shots img{max-width:100%;width:480px;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
.shots figcaption{font-size:13px;color:var(--muted)}
pre{font-family:var(--mono);font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:420px}
ul.notes{list-style:none;margin:0;padding:0}ul.notes li{padding:8px 0;border-bottom:1px solid var(--line)}
ul.notes li:last-child{border-bottom:0}.note-text{white-space:pre-wrap;overflow-wrap:anywhere}
label.confirm{display:flex;gap:8px;align-items:flex-start;font-size:14px}
.actions{display:flex;flex-wrap:wrap;gap:8px}.actions.top{margin-top:12px}
a.button{display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--fg)}
.crumbs{margin:0 0 10px;font-size:14px}
`;

const STYLE_HASH = `'sha256-${createHash("sha256").update(STYLE, "utf-8").digest("base64")}'`;

/** The pages' headers: no script, this stylesheet, images and frames from this origin only. */
export function reportPageHeaders(): Readonly<Record<string, string>> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src ${STYLE_HASH}; img-src 'self'; frame-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

export function overviewPage(
  options: Readonly<{
    rows: readonly ReportSummary[];
    tabs: readonly Readonly<{ status: ReportStatus; count: number }>[];
    total: number;
    filter: OverviewFilter;
    viewerEmail: string;
  }>,
): string {
  const { rows, tabs, total, filter } = options;
  const currentStatus = filter.status.kind === "only" ? filter.status.status : null;
  const tabLink = (status: ReportStatus | null, label: string, count: number): string => {
    const query = overviewQuery({ ...filter, status: status === null ? { kind: "all" } : { kind: "only", status } });
    const current = status === currentStatus ? ' aria-current="page"' : "";
    return `<a class="tab"${current} href="${escapeHtml(withQuery(REPORTS_PATH, query))}">${escapeHtml(label)} <span class="muted">${String(count)}</span></a>`;
  };
  const statusOptions = [`<option value="">Any status</option>`]
    .concat(
      REPORT_STATUSES.map(
        (status) =>
          `<option value="${status}"${status === currentStatus ? " selected" : ""}>${escapeHtml(describeStatus(status))}</option>`,
      ),
    )
    .join("");
  const table =
    rows.length === 0
      ? `<div class="empty">${total === 0 ? "No reports yet." : "No report matches these filters."}</div>`
      : `<table>
<thead><tr><th scope="col">Received</th><th scope="col">Slide</th><th scope="col">Comment</th><th scope="col">Status</th><th scope="col">Attachments</th><th scope="col"><span class="muted">Zip</span></th></tr></thead>
<tbody>
${rows.map(overviewRow).join("\n")}
</tbody>
</table>`;
  return documentOf({
    title: "Defect reports",
    viewerEmail: options.viewerEmail,
    main: `<h1>Defect reports</h1>
<p class="muted">${String(total)} report${total === 1 ? "" : "s"} held. Reports are deleted automatically after the retention period.</p>
<nav class="tabs" aria-label="Status">
${tabLink(null, "All", total)}
${tabs.map((tab) => tabLink(tab.status, describeStatus(tab.status), tab.count)).join("\n")}
</nav>
<form class="filters" method="get" action="${REPORTS_PATH}">
<label class="field">Search<input type="search" name="q" value="${escapeHtml(filter.text)}" placeholder="comment, slide, id, version"></label>
<label class="field">Status<select name="status">${statusOptions}</select></label>
<label class="field">From<input type="date" name="from" value="${escapeHtml(filter.from ?? "")}"></label>
<label class="field">To<input type="date" name="to" value="${escapeHtml(filter.to ?? "")}"></label>
<button type="submit" class="primary">Filter</button>
<a class="button" href="${REPORTS_PATH}">Clear</a>
</form>
<div class="table-scroll">
${table}
</div>`,
  });
}

function overviewRow(row: ReportSummary): string {
  const href = reportPath(row.id);
  const comment = row.note === "" ? `<span class="muted">(no comment)</span>` : escapeHtml(shortened({ text: row.note, maxCharacters: 140 }));
  const attachments = [
    `${String(row.annotationCount)} note${row.annotationCount === 1 ? "" : "s"}`,
    `${String(row.screenshotCount)} screenshot${row.screenshotCount === 1 ? "" : "s"}`,
  ].join(", ");
  return `<tr>
<td class="when"><a href="${href}">${escapeHtml(formatInstant(row.receivedAt))}</a></td>
<td>${row.slideLabel === "" ? `<span class="muted">(no label)</span>` : escapeHtml(shortened({ text: row.slideLabel, maxCharacters: 60 }))}</td>
<td><a href="${href}">${comment}</a></td>
<td>${statusBadge(row.status)}${row.triageNoteCount > 0 ? ` <span class="muted">${String(row.triageNoteCount)} note${row.triageNoteCount === 1 ? "" : "s"}</span>` : ""}</td>
<td class="muted">${attachments}</td>
<td><a href="${href}/download" aria-label="Download ${escapeHtml(row.id)} as a zip">.zip</a></td>
</tr>`;
}

/** How much of the converter output the page shows inline; the zip always has all of it. */
const CONVERTER_PREVIEW_BYTES = 64 * 1024;

export function detailPage(
  options: Readonly<{ entry: ReportIndexEntry; report: DefectReport; triage: Triage; csrf: string; viewerEmail: string }>,
): string {
  const { entry, report, triage, csrf } = options;
  const base = reportPath(entry.id);
  const converter = report.converterOutput.text;
  const converterShown =
    Buffer.byteLength(converter, "utf8") > CONVERTER_PREVIEW_BYTES
      ? `${prettyJson(converter).slice(0, CONVERTER_PREVIEW_BYTES)}\n… (truncated; the zip holds all of it)`
      : prettyJson(converter);
  const annotations =
    report.attachments.annotations.length === 0
      ? `<p class="muted">None were sent with this report.</p>`
      : `<ol class="annotations">${report.attachments.annotations.map(annotationItem).join("")}</ol>`;
  const screenshots =
    report.attachments.screenshots.length === 0
      ? `<p class="muted">None were sent with this report.</p>`
      : `<div class="shots">${report.attachments.screenshots
          .map(
            (shot) =>
              `<figure><img src="${base}/screenshots/${encodeURIComponent(shot.name)}" alt="Screenshot ${escapeHtml(shot.name)}" loading="lazy"><figcaption>${escapeHtml(shot.name)}</figcaption></figure>`,
          )
          .join("")}</div>`;
  const notes =
    triage.notes.length === 0
      ? `<p class="muted">No notes yet.</p>`
      : `<ul class="notes">${triage.notes
          .map(
            (note) =>
              `<li><div class="muted">${escapeHtml(note.by)} · ${escapeHtml(formatInstant(note.at))}</div><div class="note-text">${escapeHtml(note.text)}</div></li>`,
          )
          .join("")}</ul>`;
  const statusChoices = REPORT_STATUSES.map(
    (status) => `<option value="${status}"${status === triage.status ? " selected" : ""}>${escapeHtml(describeStatus(status))}</option>`,
  ).join("");
  const changed =
    triage.statusChangedAt === null || triage.statusChangedBy === null
      ? `<p class="muted">Not triaged yet.</p>`
      : `<p class="muted">Set by ${escapeHtml(triage.statusChangedBy)}, ${escapeHtml(formatInstant(triage.statusChangedAt))}.</p>`;
  const csrfField = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  return documentOf({
    title: `Report ${entry.id}`,
    viewerEmail: options.viewerEmail,
    main: `<p class="crumbs"><a href="${REPORTS_PATH}">← All reports</a></p>
<h1>${report.context.slideLabel === "" ? "Defect report" : escapeHtml(report.context.slideLabel)}</h1>
<p>${statusBadge(triage.status)} <span class="muted">${escapeHtml(entry.id)}</span></p>
<div class="layout">
<div>
<h2>The user's comment</h2>
${report.note === "" ? `<p class="muted">The user wrote nothing.</p>` : `<blockquote>${escapeHtml(report.note)}</blockquote>`}
<h2>The slide as sent</h2>
<p class="muted">The anonymised HTML the user sent, rendered with scripts and network access off.</p>
<div class="stage"><iframe src="${base}/slide" sandbox="" title="The reported slide" loading="lazy" referrerpolicy="no-referrer"></iframe></div>
<h2>Review notes the user saw</h2>
${annotations}
<h2>Screenshots</h2>
${screenshots}
<h2>Converter output</h2>
<details><summary>${String(entry.converterOutputBytes)} bytes of Slides API requests</summary><pre>${escapeHtml(converterShown)}</pre></details>
</div>
<aside>
<section class="panel">
<h2>Details</h2>
<dl class="meta">
<dt>Received</dt><dd>${escapeHtml(formatInstant(entry.receivedAt))}</dd>
<dt>Reported</dt><dd>${escapeHtml(formatInstant(entry.clientReportedAt))} <span class="muted">(user's clock)</span></dd>
<dt>Add-on</dt><dd>${escapeHtml(report.versions.addon)}</dd>
<dt>Converter</dt><dd>${escapeHtml(report.versions.converter)}</dd>
<dt>Protocol</dt><dd>${String(report.versions.protocol)}</dd>
<dt>Schema</dt><dd>${String(report.schemaVersion)}</dd>
<dt>Stored</dt><dd>${String(entry.storedBytes)} bytes</dd>
</dl>
<div class="actions top"><a class="button" href="${base}/download">Download zip</a></div>
</section>
<section class="panel">
<h2>Status</h2>
${changed}
<form method="post" action="${base}/status">
${csrfField}
<label class="field">New status<select name="status">${statusChoices}</select></label>
<button type="submit" class="primary">Save status</button>
</form>
</section>
<section class="panel">
<h2>Notes</h2>
${notes}
<form method="post" action="${base}/notes">
${csrfField}
<label class="field">Add a note<textarea name="text" rows="3" maxlength="4000" required></textarea></label>
<button type="submit">Add note</button>
</form>
</section>
<section class="panel">
<h2>Delete</h2>
<form method="post" action="${base}/delete">
${csrfField}
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> Delete this report, its attachments and its notes. This cannot be undone.</label>
<button type="submit" class="danger">Delete report</button>
</form>
</section>
</aside>
</div>`,
  });
}

function annotationItem(annotation: ReportAnnotation): string {
  return `<li><span class="badge tone-${annotation.tone}">${escapeHtml(annotation.tone)}</span> <strong>${escapeHtml(annotation.heading)}</strong> <span class="muted">(${escapeHtml(describeSide(annotation.side))})</span><div>${escapeHtml(annotation.detail)}</div></li>`;
}

function describeSide(side: ReportAnnotation["side"]): string {
  switch (side) {
    case "as-is":
      return "the user's slide";
    case "as-sent":
      return "the slide as sent";
    default:
      return assertNever(side);
  }
}

export function reportMessagePage(
  options: Readonly<{ title: string; message: string; viewerEmail: string | null; action?: Readonly<{ href: string; label: string }> }>,
): string {
  const action = options.action === undefined ? "" : `<p><a href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a></p>`;
  return documentOf({
    title: options.title,
    viewerEmail: options.viewerEmail,
    main: `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${action}`,
  });
}

export function reportPath(id: string): string {
  return `${REPORTS_PATH}/${encodeURIComponent(id)}`;
}

function statusBadge(status: ReportStatus): string {
  return `<span class="badge status-${status}">${escapeHtml(describeStatus(status))}</span>`;
}

function documentOf(options: Readonly<{ title: string; main: string; viewerEmail: string | null }>): string {
  const who = options.viewerEmail === null ? "" : `<span class="who">Signed in as ${escapeHtml(options.viewerEmail)} · <a href="/account">Account</a></span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · Sasha Slides</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><div class="bar-inner"><a class="brand" href="${REPORTS_PATH}">${SASHA_ICON_SVG}Defect reports</a>${who}</div></header>
<main class="wrap">
${options.main}
</main>
</body>
</html>
`;
}

/** `2026-10-04 13:02 UTC`: unambiguous for an owner reading reports from anywhere. */
function formatInstant(instant: string): string {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return instant;
  return `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function withQuery(path: string, query: string): string {
  return query === "" ? path : `${path}?${query}`;
}

function prettyJson(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value, null, 2);
  } catch {
    return text;
  }
}
