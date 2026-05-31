/**
 * google-table-layout-probe.gs — Google Slides Apps Script feasibility probe.
 *
 * HOW TO RUN:
 *   1. Open the test presentation in Google Slides.
 *   2. Extensions → Apps Script. Paste this file. Save.
 *   3. Run `probe()`. Grant the consent prompt.
 *   4. View → Logs (or the execution log). Copy the JSON it prints back here.
 *
 * It answers the two make-or-break questions for the Apps-Script alignment idea:
 *
 *   Q1 — Can the API read the REAL (auto-grown) geometry, or only the spec
 *        minimum? We dump, per table: each row's getMinimumHeight(), the
 *        table's own getHeight()/getTop() (which reflect the RENDERED total),
 *        and whether any per-cell position is exposed. If
 *        sum(minimumHeights) != table.getHeight(), Google auto-grew, and the
 *        delta tells us how much — and whether we can attribute it per-row.
 *
 *   Q2 — Does pptx shape alt-text (<p:cNvPr descr>) survive the import and read
 *        back as getDescription()/getTitle()? We dump those for EVERY element,
 *        descending into GROUPS (corner masks are grouped), so we learn whether
 *        the metadata must live on top-level shapes instead.
 */
function probe() {
  var pres = SlidesApp.getActivePresentation();
  var report = { presentation: pres.getId(), pageSize: dim(pres.getPageWidth(), pres.getPageHeight()), slides: [] };
  var slides = pres.getSlides();
  for (var si = 0; si < slides.length; si++) {
    var elems = [];
    var pes = slides[si].getPageElements();
    for (var i = 0; i < pes.length; i++) elems.push(dumpElement(pes[i], 0));
    report.slides.push({ index: si, elements: elems });
  }
  var json = JSON.stringify(report, null, 2);
  Logger.log(json);
  // Also drop it into a Doc-free, copy-pasteable spot:
  Logger.log('=== PROBE COMPLETE — copy the JSON above ===');
  return json;
}

function dumpElement(pe, depth) {
  var type = String(pe.getPageElementType());
  var o = {
    type: type,
    objectId: pe.getObjectId(),
    title: safe(function () { return pe.getTitle(); }),
    description: safe(function () { return pe.getDescription(); }),
    box: { left: r2(pe.getLeft()), top: r2(pe.getTop()), width: r2(pe.getWidth()), height: r2(pe.getHeight()) },
  };
  if (type === String(SlidesApp.PageElementType.TABLE)) {
    var t = pe.asTable();
    var nRows = t.getNumRows(), nCols = t.getNumColumns();
    o.table = { numRows: nRows, numCols: nCols, rowMinHeights: [], colWidths: [] };
    var sumMin = 0;
    for (var rr = 0; rr < nRows; rr++) {
      var h = safe(function () { return t.getRow(rr).getMinimumHeight(); });
      o.table.rowMinHeights.push(r2(h));
      if (typeof h === 'number') sumMin += h;
    }
    for (var cc = 0; cc < nCols; cc++) {
      o.table.colWidths.push(r2(safe(function () { return t.getColumn(cc).getWidth(); })));
    }
    o.table.sumRowMinHeights = r2(sumMin);
    o.table.tableRenderedHeight = r2(pe.getHeight());
    o.table.autoGrowTotal = r2(pe.getHeight() - sumMin); // >0 ⇒ Google grew rows past spec
    // Probe whether a CELL exposes any rendered position (most builds do NOT):
    o.table.cellProbe = safe(function () {
      var cell = t.getCell(0, 0);
      return {
        hasGetLeft: typeof cell.getLeft === 'function',
        hasGetTop: typeof cell.getTop === 'function',
        hasGetWidth: typeof cell.getWidth === 'function',
        hasGetHeight: typeof cell.getHeight === 'function',
        textStyleFontSize: safe(function () { return cell.getText().getTextStyle().getFontSize(); }),
        methods: listMethods(cell),
      };
    });
    o.table.rowMethods = safe(function () { return listMethods(t.getRow(0)); });
  }
  if (type === String(SlidesApp.PageElementType.GROUP)) {
    o.children = [];
    var kids = pe.asGroup().getChildren();
    for (var k = 0; k < kids.length; k++) o.children.push(dumpElement(kids[k], depth + 1));
  }
  return o;
}

function listMethods(obj) {
  // Best-effort: which getters exist so we can see what geometry is readable.
  var out = [];
  for (var key in obj) { try { if (typeof obj[key] === 'function' && key.indexOf('get') === 0) out.push(key); } catch (e) {} }
  return out.sort();
}
function safe(fn) { try { return fn(); } catch (e) { return '<err:' + e.message + '>'; } }
function r2(n) { return typeof n === 'number' ? Math.round(n * 100) / 100 : n; }
function dim(w, h) { return { width: r2(w), height: r2(h) }; }
