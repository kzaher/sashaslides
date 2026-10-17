// THE OVERVIEW'S DATA LAYER: one row per report, the filters over those rows, and the query string
// that carries the filters. Pure -- no file, no clock, no request -- so the admin pages
// (`mcp/sasha-slides/reports/`) only render what this decides, and the tests here decide it.

import { assertNever } from "./assert-never.ts";
import type { DefectReport, ReportVersions } from "./defect-report.ts";
import type { ReportId } from "./report-id.ts";
import type { ReportIndexEntry } from "./report-store.ts";
import { parseReportStatus, REPORT_STATUSES, type ReportStatus, type Triage } from "./report-triage.ts";

/** One row of the overview. Everything a row shows, nothing it does not. */
export type ReportSummary = Readonly<{
  id: ReportId;
  receivedAt: string;
  slideLabel: string;
  /** The user's comment, whole; the page shortens it for display. */
  note: string;
  status: ReportStatus;
  annotationCount: number;
  screenshotCount: number;
  triageNoteCount: number;
  storedBytes: number;
  versions: ReportVersions;
}>;

/** The parts of a stored report a row is made from; the admin pages cache it per id. */
export type ReportDigest = Readonly<{
  slideLabel: string;
  note: string;
  annotationCount: number;
  screenshotCount: number;
}>;

export function digestOf(report: DefectReport): ReportDigest {
  return {
    slideLabel: report.context.slideLabel,
    note: report.note,
    annotationCount: report.attachments.annotations.length,
    screenshotCount: report.attachments.screenshots.length,
  };
}

/** A digest for a report whose file could not be read: the row still appears, and says so. */
export const UNREADABLE_DIGEST: ReportDigest = { slideLabel: "", note: "(the report file could not be read)", annotationCount: 0, screenshotCount: 0 };

export function summaryOf(options: Readonly<{ entry: ReportIndexEntry; digest: ReportDigest; triage: Triage }>): ReportSummary {
  const { entry, digest, triage } = options;
  return {
    id: entry.id,
    receivedAt: entry.receivedAt,
    slideLabel: digest.slideLabel,
    note: digest.note,
    status: triage.status,
    annotationCount: digest.annotationCount,
    screenshotCount: digest.screenshotCount,
    triageNoteCount: triage.notes.length,
    storedBytes: entry.storedBytes,
    versions: entry.versions,
  };
}

export type StatusFilter = Readonly<{ kind: "all" }> | Readonly<{ kind: "only"; status: ReportStatus }>;

export type OverviewFilter = Readonly<{
  status: StatusFilter;
  /** Case-insensitive, matched against the comment, the slide label, the id and the versions. */
  text: string;
  /** Inclusive UTC calendar days, `YYYY-MM-DD`; null is unbounded. */
  from: string | null;
  to: string | null;
}>;

export const NO_FILTER: OverviewFilter = { status: { kind: "all" }, text: "", from: null, to: null };

/**
 * The filter in a query string, read leniently: a value that does not parse is dropped rather than
 * refused, because the worst a bad link can do is show more rows than it meant to.
 */
export function parseOverviewFilter(query: URLSearchParams): OverviewFilter {
  const statusText = query.get("status") ?? "";
  const status = parseReportStatus(statusText);
  return {
    status: status === null ? { kind: "all" } : { kind: "only", status },
    text: (query.get("q") ?? "").trim().slice(0, 200),
    from: calendarDayOrNull(query.get("from")),
    to: calendarDayOrNull(query.get("to")),
  };
}

/** The query string that reproduces `filter`, without the leading `?`; empty for no filter. */
export function overviewQuery(filter: OverviewFilter): string {
  const query = new URLSearchParams();
  switch (filter.status.kind) {
    case "all":
      break;
    case "only":
      query.set("status", filter.status.status);
      break;
    default:
      assertNever(filter.status);
  }
  if (filter.text !== "") query.set("q", filter.text);
  if (filter.from !== null) query.set("from", filter.from);
  if (filter.to !== null) query.set("to", filter.to);
  return query.toString();
}

/** The rows `filter` keeps, newest first. */
export function filterSummaries(
  options: Readonly<{ summaries: readonly ReportSummary[]; filter: OverviewFilter }>,
): readonly ReportSummary[] {
  const { filter } = options;
  const needle = filter.text.toLowerCase();
  return options.summaries
    .filter((summary) => statusMatches({ filter: filter.status, status: summary.status }))
    .filter((summary) => needle === "" || searchableTextOf(summary).includes(needle))
    .filter((summary) => filter.from === null || summary.receivedAt.slice(0, 10) >= filter.from)
    .filter((summary) => filter.to === null || summary.receivedAt.slice(0, 10) <= filter.to)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

/** How many reports are in each status, before the status filter -- the counts on the status tabs. */
export function statusCounts(summaries: readonly ReportSummary[]): Readonly<Record<ReportStatus, number>> {
  const counts: Record<ReportStatus, number> = { new: 0, triaged: 0, fixed: 0, wontfix: 0 };
  for (const summary of summaries) counts[summary.status] += 1;
  return counts;
}

/** The statuses in tab order, with their counts. */
export function statusTabs(summaries: readonly ReportSummary[]): readonly Readonly<{ status: ReportStatus; count: number }>[] {
  const counts = statusCounts(summaries);
  return REPORT_STATUSES.map((status) => ({ status, count: counts[status] }));
}

/** A comment cut to `maxCharacters` at a word boundary when one is close, with an ellipsis. */
export function shortened(options: Readonly<{ text: string; maxCharacters: number }>): string {
  const flat = options.text.replace(/\s+/g, " ").trim();
  const characters = [...flat];
  if (characters.length <= options.maxCharacters) return flat;
  const cut = characters.slice(0, options.maxCharacters).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > options.maxCharacters * 0.6 ? cut.slice(0, space) : cut}…`;
}

function statusMatches(options: Readonly<{ filter: StatusFilter; status: ReportStatus }>): boolean {
  switch (options.filter.kind) {
    case "all":
      return true;
    case "only":
      return options.filter.status === options.status;
    default:
      return assertNever(options.filter);
  }
}

function searchableTextOf(summary: ReportSummary): string {
  return [summary.note, summary.slideLabel, summary.id, summary.versions.addon, summary.versions.converter]
    .join("\n")
    .toLowerCase();
}

function calendarDayOrNull(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}
