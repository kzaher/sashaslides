/**
 * The defect-report admin pages under `/account/reports`, mounted by the account portal
 * (`account-portal.ts` `reportPages`), so they share its session cookie, its sign-in and its CSRF
 * token instead of growing a second login.
 *
 *   GET  /account/reports                          the overview: date, slide, comment, status; filters
 *   GET  /account/reports/<id>                     one report: comment, slide, review notes, screenshots,
 *                                                  converter output, and the processing forms
 *   GET  /account/reports/<id>/slide               the submitted HTML, sandboxed (see below)
 *   GET  /account/reports/<id>/screenshots/<name>  one PNG
 *   GET  /account/reports/<id>/download            everything, as `<id>.zip`
 *   POST /account/reports/<id>/status              csrf + status        → 303 back
 *   POST /account/reports/<id>/notes               csrf + text          → 303 back
 *   POST /account/reports/<id>/delete              csrf + confirm=yes   → 303 to the overview
 *
 * ACCESS. Signed out: 303 to `/account` to sign in. Signed in but not on `SASHA_ADMIN_EMAILS`
 * (matched against the account's VERIFIED addresses): 403, and nothing about any report is read.
 * Every POST needs the session's CSRF token on top of the cookie's SameSite=Lax.
 *
 * THE SUBMITTED HTML is a stranger's markup. It is only ever served from `/slide`, with
 * `Content-Security-Policy: sandbox` and no `allow-scripts`, so the browser gives it an opaque origin
 * and no script runs even when the URL is opened directly; images are limited to `data:` so the
 * page cannot call home with the owner's address; the detail page embeds it with an empty `sandbox`
 * attribute as a second, independent lock.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReportArchive } from "../../../report-service/src/report-store.ts";
import { parseReportId, type ReportId } from "../../../report-service/src/report-id.ts";
import {
  digestOf,
  filterSummaries,
  parseOverviewFilter,
  statusTabs,
  summaryOf,
  UNREADABLE_DIGEST,
  type ReportDigest,
} from "../../../report-service/src/report-overview.ts";
import { parseReportStatus, type TriageLog, type TriageWrite } from "../../../report-service/src/report-triage.ts";
import { reportBundleEntries, reportBundleName, zipArchive } from "../../../report-service/src/report-zip.ts";
import { screenshotBytesOf } from "../../../report-service/src/defect-report.ts";
import { ACCOUNT_PATH, REPORTS_PATH, type SignedInPages, type SignedInViewer } from "../http/account-portal";
import { constantTimeEqual } from "../http/cookies";
import { mediaTypeOf, readBodyText } from "../http/http-kit";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import { adminAddressOf, type AdminAllowList } from "./admin-allow-list";
import { detailPage, overviewPage, reportMessagePage, reportPageHeaders, reportPath } from "./report-admin-html";

/** The slide's own policy: no script, an opaque origin, no network but Google Fonts. */
export const SLIDE_CONTENT_SECURITY_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data:; frame-ancestors 'self'";

const MAX_FORM_BYTES = 16 * 1024;

export function createReportAdminPages(
  options: Readonly<{
    archive: ReportArchive;
    triage: TriageLog;
    allowList: AdminAllowList;
    now: () => Date;
    warn: (message: string) => void;
  }>,
): SignedInPages {
  const { archive, triage, allowList, now, warn } = options;
  // A report file is written once and never rewritten, so what a row needs from it is read once.
  const digests = new Map<ReportId, ReportDigest>();

  async function digestFor(id: ReportId): Promise<ReportDigest> {
    const cached = digests.get(id);
    if (cached !== undefined) return cached;
    const read = await archive.read(id);
    switch (read.kind) {
      case "found": {
        const digest = digestOf(read.stored.report);
        digests.set(id, digest);
        return digest;
      }
      case "not-found":
        return UNREADABLE_DIGEST;
      case "unreadable":
        warn(`reports: ${id} is unreadable: ${read.detail}`);
        return UNREADABLE_DIGEST;
      default:
        return assertNever(read);
    }
  }

  async function overview(response: ServerResponse, url: URL, email: string): Promise<void> {
    const summaries = [];
    for (const entry of archive.list()) {
      summaries.push(summaryOf({ entry, digest: await digestFor(entry.id), triage: triage.get(entry.id) }));
    }
    const filter = parseOverviewFilter(url.searchParams);
    sendPage({
      response,
      status: 200,
      html: overviewPage({
        rows: filterSummaries({ summaries, filter }),
        tabs: statusTabs(summaries),
        total: summaries.length,
        filter,
        viewerEmail: email,
      }),
    });
  }

  async function withReport(
    response: ServerResponse,
    id: ReportId,
    email: string,
    use: (found: Extract<Awaited<ReturnType<ReportArchive["read"]>>, { kind: "found" }>) => void,
  ): Promise<void> {
    const read = await archive.read(id);
    switch (read.kind) {
      case "found":
        use(read);
        return;
      case "not-found":
        sendMessage({ response, status: 404, email, title: "No such report", message: "It was deleted, or it expired." });
        return;
      case "unreadable":
        warn(`reports: ${id} is unreadable: ${read.detail}`);
        sendMessage({ response, status: 500, email, title: "Unreadable report", message: "The report file could not be read." });
        return;
      default:
        assertNever(read);
    }
  }

  async function post(
    request: IncomingMessage,
    response: ServerResponse,
    options: Readonly<{ id: ReportId; action: PostAction; viewer: SignedInViewer; email: string }>,
  ): Promise<void> {
    const { id, action, viewer, email } = options;
    if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") {
      sendMessage({ response, status: 415, email, title: "Not a form", message: "Send the form from the report page." });
      return;
    }
    const text = await readBodyText({ request, maximumBytes: MAX_FORM_BYTES, onOverflow: "drain" });
    if (text === null) {
      sendMessage({ response, status: 413, email, title: "Too long", message: "That form was too long." });
      return;
    }
    const fields = new URLSearchParams(text);
    const csrf = fields.get("csrf") ?? "";
    if (!constantTimeEqual(csrf, viewer.csrf)) {
      sendMessage({
        response,
        status: 403,
        email,
        title: "Page expired",
        message: "Your session changed since this page was opened. Open the report again and repeat the change.",
        action: { href: reportPath(id), label: "Open the report" },
      });
      return;
    }
    if (archive.find(id) === null) {
      sendMessage({ response, status: 404, email, title: "No such report", message: "It was deleted, or it expired." });
      return;
    }
    const at = now();
    switch (action) {
      case "status": {
        const status = parseReportStatus(fields.get("status") ?? "");
        if (status === null) {
          sendMessage({ response, status: 400, email, title: "Unknown status", message: "Pick one of the listed statuses." });
          return;
        }
        return answerTriageWrite({ response, email, id, written: await triage.setStatus({ id, status, by: email, at }) });
      }
      case "notes":
        return answerTriageWrite({ response, email, id, written: await triage.addNote({ id, text: fields.get("text") ?? "", by: email, at }) });
      case "delete": {
        if (fields.get("confirm") !== "yes") {
          sendMessage({ response, status: 400, email, title: "Not deleted", message: "Tick the confirmation box to delete a report." });
          return;
        }
        const purged = await archive.purge(id);
        switch (purged.kind) {
          case "removed":
          case "not-found":
            digests.delete(id);
            await triage.forget({ id, at });
            warn(`reports: audit: ${id} deleted by an admin`);
            redirect(response, REPORTS_PATH);
            return;
          case "remove-failed":
            warn(`reports: deleting ${id} failed: ${purged.detail}`);
            sendMessage({ response, status: 500, email, title: "Not deleted", message: "The report could not be deleted." });
            return;
          default:
            return assertNever(purged);
        }
      }
      default:
        return assertNever(action);
    }
  }

  function answerTriageWrite(options: Readonly<{ response: ServerResponse; email: string; id: ReportId; written: TriageWrite }>): void {
    const { response, email, id, written } = options;
    switch (written.kind) {
      case "ok":
        redirect(response, reportPath(id));
        return;
      case "refused":
        sendMessage({ response, status: 400, email, title: "Not saved", message: written.detail, action: { href: reportPath(id), label: "Back to the report" } });
        return;
      case "failed":
        warn(`reports: triage write for ${id} failed: ${written.detail}`);
        sendMessage({ response, status: 500, email, title: "Not saved", message: "The change could not be written." });
        return;
      default:
        assertNever(written);
    }
  }

  return {
    async handleRequest({ request, response, url, viewer }) {
      const method = request.method ?? "GET";
      const route = parseAdminRoute(url.pathname);
      if (viewer === null) {
        // Sign in first; the account page links back here once there is a session.
        redirect(response, ACCOUNT_PATH);
        return;
      }
      const email = adminAddressOf({ allowList, verifiedEmails: viewer.verifiedEmails });
      if (email === null) {
        sendMessage({
          response,
          status: 403,
          email: null,
          title: "Not allowed",
          message:
            allowList.emails.size === 0
              ? "No administrator is configured for defect reports (SASHA_ADMIN_EMAILS)."
              : "Defect reports are only shown to the site's administrators. Sign in with an administrator's verified address.",
          action: { href: ACCOUNT_PATH, label: "Your account" },
        });
        return;
      }
      if (route.kind === "not-found") {
        sendMessage({ response, status: 404, email, title: "Not found", message: "There is no such page." });
        return;
      }
      const wanted = route.kind === "post" ? "POST" : "GET";
      if (method !== wanted && !(wanted === "GET" && method === "HEAD")) {
        response.writeHead(405, { allow: wanted, "cache-control": "no-store", "content-length": "0" }).end();
        return;
      }
      switch (route.kind) {
        case "overview":
          return overview(response, url, email);
        case "detail":
          return withReport(response, route.id, email, ({ stored }) =>
            sendPage({
              response,
              status: 200,
              html: detailPage({ entry: stored.entry, report: stored.report, triage: triage.get(route.id), csrf: viewer.csrf, viewerEmail: email }),
            }),
          );
        case "slide":
          return withReport(response, route.id, email, ({ stored }) => {
            const body = Buffer.from(stored.report.document.html, "utf8");
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "content-length": String(body.byteLength),
              "content-security-policy": SLIDE_CONTENT_SECURITY_POLICY,
              "x-content-type-options": "nosniff",
              "x-frame-options": "SAMEORIGIN",
              "referrer-policy": "no-referrer",
              "cache-control": "no-store",
            });
            response.end(body);
          });
        case "screenshot":
          return withReport(response, route.id, email, ({ stored }) => {
            const shot = stored.report.attachments.screenshots.find((candidate) => candidate.name === route.name);
            if (shot === undefined) {
              sendMessage({ response, status: 404, email, title: "No such screenshot", message: "This report has no screenshot by that name." });
              return;
            }
            const body = screenshotBytesOf(shot);
            response.writeHead(200, {
              "content-type": "image/png",
              "content-length": String(body.byteLength),
              "content-security-policy": "default-src 'none'; sandbox",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
            });
            response.end(body);
          });
        case "download":
          return withReport(response, route.id, email, ({ stored }) => {
            const zip = zipArchive(
              reportBundleEntries({ entry: stored.entry, report: stored.report, triage: triage.get(route.id), exportedAt: now() }),
            );
            response.writeHead(200, {
              "content-type": "application/zip",
              "content-length": String(zip.byteLength),
              "content-disposition": `attachment; filename="${reportBundleName(stored.entry)}"`,
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
            });
            response.end(zip);
          });
        case "post":
          return post(request, response, { id: route.id, action: route.action, viewer, email });
        default:
          return assertNever(route);
      }
    },
  };
}

type PostAction = "status" | "notes" | "delete";

export type AdminRoute =
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "detail"; id: ReportId }>
  | Readonly<{ kind: "slide"; id: ReportId }>
  | Readonly<{ kind: "screenshot"; id: ReportId; name: string }>
  | Readonly<{ kind: "download"; id: ReportId }>
  | Readonly<{ kind: "post"; id: ReportId; action: PostAction }>
  | Readonly<{ kind: "not-found" }>;

/** The path below `/account/reports`. The id must parse as a `ReportId`, so it cannot traverse. */
export function parseAdminRoute(pathname: string): AdminRoute {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === REPORTS_PATH) return { kind: "overview" };
  if (!trimmed.startsWith(`${REPORTS_PATH}/`)) return { kind: "not-found" };
  const segments = trimmed.slice(REPORTS_PATH.length + 1).split("/").map(decodeOrEmpty);
  const [idText, section, name, extra] = segments;
  const id = parseReportId(idText ?? "");
  if (id === null || extra !== undefined) return { kind: "not-found" };
  if (section === undefined) return { kind: "detail", id };
  if (section === "screenshots") return name === undefined || name === "" ? { kind: "not-found" } : { kind: "screenshot", id, name };
  if (name !== undefined) return { kind: "not-found" };
  switch (section) {
    case "slide":
      return { kind: "slide", id };
    case "download":
      return { kind: "download", id };
    case "status":
    case "notes":
    case "delete":
      return { kind: "post", id, action: section };
    default:
      return { kind: "not-found" };
  }
}

function decodeOrEmpty(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function sendPage(options: Readonly<{ response: ServerResponse; status: number; html: string }>): void {
  const body = Buffer.from(options.html, "utf8");
  options.response.writeHead(options.status, { ...reportPageHeaders(), "content-length": String(body.byteLength) });
  options.response.end(body);
}

function sendMessage(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    email: string | null;
    title: string;
    message: string;
    action?: Readonly<{ href: string; label: string }>;
  }>,
): void {
  sendPage({
    response: options.response,
    status: options.status,
    html: reportMessagePage({
      title: options.title,
      message: options.message,
      viewerEmail: options.email,
      ...(options.action === undefined ? {} : { action: options.action }),
    }),
  });
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store", "content-length": "0" }).end();
}
