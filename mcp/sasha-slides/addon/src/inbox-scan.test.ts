// THE INBOX SCAN'S MARKER QUERIES MUST FIT IN ONE URL FETCH. Measured live 2026-10-15: with 35+
// proposals the fixed 40-folder chunk overflowed Apps Script's UrlFetch URL limit ("Limit
// Exceeded: URLFetch URL Length"), so every scan fell back to the DriveApp walk and the sidebar
// spun for 18-27 s. The queries are now sized by the URL they produce, not by a folder count.

import assert from "node:assert/strict";
import test from "node:test";
import { inboxMarkerQueries, MARKER_QUERY_URL_PREFIX, URL_FETCH_MAXIMUM_URL_LENGTH } from "./inbox-scan.ts";

/** Real Drive folder ids are 33 characters. */
const folderIds = Array.from({ length: 45 }, (_, index) => `1${"aBcDeFgHiJkLmNoPqRsTuVwXyZ01234".slice(0, 30)}${String(index).padStart(2, "0")}`);

test("REPRO: forty real-length folder ids in one query make a URL longer than UrlFetch allows", () => {
  const head = "(name = 'READY' or name = 'PICK' or name = 'manifest.json') and trashed = false and (";
  const oldQuery = `${head}${folderIds.slice(0, 40).map((id) => `'${id}' in parents`).join(" or ")})`;
  assert.ok((MARKER_QUERY_URL_PREFIX + encodeURIComponent(oldQuery)).length > URL_FETCH_MAXIMUM_URL_LENGTH);
});

test("every marker query's URL fits, and together they ask about every folder exactly once", () => {
  const queries = inboxMarkerQueries({ folderIds, urlPrefix: MARKER_QUERY_URL_PREFIX, maximumUrlLength: URL_FETCH_MAXIMUM_URL_LENGTH });
  for (const query of queries) assert.ok((MARKER_QUERY_URL_PREFIX + encodeURIComponent(query)).length <= URL_FETCH_MAXIMUM_URL_LENGTH, query.length.toString());
  const asked = queries.flatMap((query) => [...query.matchAll(/'([^']+)' in parents/g)].map((match) => match[1]));
  assert.deepEqual(asked, folderIds);
  assert.ok(queries.length > 1 && queries.length < folderIds.length, `${String(queries.length)} queries`);
});

test("no folders, no queries; one folder, one query", () => {
  assert.deepEqual(inboxMarkerQueries({ folderIds: [], urlPrefix: MARKER_QUERY_URL_PREFIX, maximumUrlLength: URL_FETCH_MAXIMUM_URL_LENGTH }), []);
  assert.equal(inboxMarkerQueries({ folderIds: [folderIds[0] ?? ""], urlPrefix: MARKER_QUERY_URL_PREFIX, maximumUrlLength: URL_FETCH_MAXIMUM_URL_LENGTH }).length, 1);
});

test("inboxMarkerQueries is self-contained, so the copy Code.gs embeds runs exactly as tested", () => {
  const embedded = new Function(`return (${inboxMarkerQueries.toString()});`)() as typeof inboxMarkerQueries;
  const options = { folderIds, urlPrefix: MARKER_QUERY_URL_PREFIX, maximumUrlLength: URL_FETCH_MAXIMUM_URL_LENGTH };
  assert.deepEqual(embedded(options), inboxMarkerQueries(options));
});
