// THE INBOX SCAN'S MARKER QUERIES, sized by the URL they make.
//
// sashaScanInbox asks Drive which proposal folders hold READY, PICK and manifest.json with one
// files.list per group of folders, the folder ids joined into the query (`'<id>' in parents or …`).
// files.list is a GET, so the query rides in the URL, and Apps Script's UrlFetch refuses a long URL.
// Measured live 2026-10-15: groups of 40 folders overflowed it ("Limit Exceeded: URLFetch URL
// Length") once the inbox held 35+ proposals, every scan fell back to the DriveApp walk, and the
// sidebar spun for 18-27 s. So a group grows only while its encoded URL still fits.
//
// SELF-CONTAINED: Code.gs embeds `inboxMarkerQueries.toString()` verbatim (apps-script-project.ts),
// so it may use nothing from this module's scope; inbox-scan.test.ts runs the embedded copy.

/** Drive's files.list address with the fields sashaScanInbox asks for, up to the query value. */
export const MARKER_QUERY_URL_PREFIX =
  "https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=" + encodeURIComponent("files(id,name,parents)") + "&q=";

/**
 * Apps Script documents UrlFetch URLs as limited to 2 KB; kept a little under it so the margin
 * absorbs a longer id than the ones measured.
 */
export const URL_FETCH_MAXIMUM_URL_LENGTH = 2000;

/**
 * The marker queries for `folderIds`, each one's URL (prefix plus encoded query) within the limit.
 * No named inner functions: the transpiler wraps those in a `__name` helper that Apps Script does
 * not have, which the self-containment test caught.
 */
export function inboxMarkerQueries(
  options: Readonly<{ folderIds: readonly string[]; urlPrefix: string; maximumUrlLength: number }>,
): string[] {
  const head = "(name = 'READY' or name = 'PICK' or name = 'manifest.json') and trashed = false and (";
  const queries: string[] = [];
  let group: string[] = [];
  for (const folderId of options.folderIds) {
    const grown = group.concat([folderId]);
    const grownQuery = head + grown.map((id) => "'" + id + "' in parents").join(" or ") + ")";
    // A folder that does not fit alone still gets a query of its own; Drive then says why.
    if (group.length > 0 && (options.urlPrefix + encodeURIComponent(grownQuery)).length > options.maximumUrlLength) {
      queries.push(head + group.map((id) => "'" + id + "' in parents").join(" or ") + ")");
      group = [folderId];
    } else {
      group = grown;
    }
  }
  if (group.length > 0) queries.push(head + group.map((id) => "'" + id + "' in parents").join(" or ") + ")");
  return queries;
}
