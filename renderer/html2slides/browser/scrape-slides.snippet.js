/* Paste in the DevTools console while viewing a Google Slides deck to download
 * every slide as a PNG. Hits the public /export/png endpoint with session
 * cookies (works for any deck you can normally view).
 *
 * Handles HTTP 429 with exponential backoff + jitter, and adaptively slows
 * the baseline throttle each time it hits a limit so the rest of the deck
 * rides out the throttle instead of stalling.
 */
(async () => {
  const presId = location.pathname.split('/d/')[1]?.split('/')[0];
  if (!presId) return alert('open a Google Slides presentation first');

  // Force-render the filmstrip so virtualised thumbnails are in the DOM.
  const film = document.querySelector('.punch-filmstrip-scroll');
  if (film) {
    film.scrollTop = 99999;
    await new Promise(r => setTimeout(r, 700));
    film.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));
  }

  // Scan page source for slide-objectId patterns: pN (pptxgenjs-imported),
  // gXXX_pN_N (native Slides), SLIDES_API*. Real IDs appear many times in
  // bootstrap data; noise appears 1-2x. Filter at >=3.
  const html = document.documentElement.outerHTML;
  const counts = {};
  for (const m of html.matchAll(/(g[a-f0-9]{6,}_p\d+_\d+|SLIDES_API\d+_\d+|p\d+)/g))
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  let ids = Object.keys(counts).filter(k => counts[k] >= 3);

  // For pN-only decks: keep only the contiguous run starting at p1, capped
  // by the filmstrip's actual slide count. Drops p0/p31/p50/p99 noise from
  // pptxgenjs internal layout/master IDs that share the pN format.
  if (ids.every(id => /^p\d+$/.test(id))) {
    const filmCount = document.querySelectorAll('.punch-filmstrip-thumbnail').length;
    const cap = filmCount > 0 ? filmCount : 9999;
    const nums = new Set(ids.map(id => +id.slice(1)));
    ids = [];
    for (let n = 1; n <= cap && nums.has(n); n++) ids.push(`p${n}`);
  }
  console.log(`downloading ${ids.length} slide(s):`, ids);
  if (!ids.length) return alert('no slide IDs found — open the filmstrip and rerun');

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let baseDelay = 350;          // baseline gap between successful slides
  let saved = 0, failed = 0;

  // Fetch one slide with retry on HTTP 429. Exponential backoff with jitter,
  // bumps the persistent baseDelay each time we hit a limit so subsequent
  // slides don't immediately re-trip it.
  async function fetchSlide(id) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const url = `https://docs.google.com/presentation/d/${presId}/export/png?id=${presId}&pageid=${id}`;
      let res;
      try {
        res = await fetch(url, { credentials: 'same-origin' });
      } catch (e) {
        console.warn(`  ${id}: network error ${e.message}; retrying`);
        await sleep(2000 + Math.random() * 1000);
        continue;
      }
      if (res.ok) {
        const blob = await res.blob();
        return blob.size >= 2000 ? blob : null;
      }
      if (res.status !== 429) {
        console.warn(`  ${id}: HTTP ${res.status} (giving up)`);
        return null;
      }
      const wait = Math.min(45000, 1500 * Math.pow(2, attempt)) + Math.random() * 500;
      baseDelay = Math.min(8000, Math.max(baseDelay * 1.4, 1500));
      console.log(`  ${id}: 429 throttled — sleeping ${(wait/1000).toFixed(1)}s (attempt ${attempt+1}/7, new baseline=${Math.round(baseDelay)}ms)`);
      await sleep(wait);
    }
    return null;
  }

  for (let i = 0; i < ids.length; i++) {
    const blob = await fetchSlide(ids[i]);
    if (!blob) { failed++; console.warn(`  ${ids[i]}: skipped`); continue; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `slide_${String(++saved).padStart(2, '0')}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    console.log(`  ${saved}/${ids.length} ✓ ${ids[i]} (${(blob.size/1024).toFixed(1)} KB, delay=${Math.round(baseDelay)}ms)`);
    await sleep(baseDelay);
  }
  console.log(`done — ${saved} PNG(s) downloaded, ${failed} failed`);
})();
