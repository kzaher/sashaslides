// Parallel search worker: scans a disjoint byte range of a shared, read-only corpus for a literal
// needle and counts occurrences whose start position falls in [start, end). Because ranges are
// disjoint by start position and the corpus is immutable, no synchronization is needed — this is
// the "read-only shared memory + message-passing results" pattern the browser rewards.

let buf = null;      // Uint8Array view over the shared corpus
let needle = null;   // Uint8Array

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    buf = new Uint8Array(m.sab);
    needle = m.needle;
    postMessage({ type: "ready" });
    return;
  }
  if (m.type === "search") {
    const t0 = performance.now();
    const count = countOcc(buf, needle, m.start, m.end);
    const ms = performance.now() - t0;
    postMessage({ type: "result", id: m.id, count, ms });
  }
};

function countOcc(buf, needle, start, end) {
  const n0 = needle[0];
  const nl = needle.length;
  let c = 0;
  for (let i = start; i < end; i++) {
    if (buf[i] === n0) {
      let k = 1;
      while (k < nl && buf[i + k] === needle[k]) k++;
      if (k === nl) c++;
    }
  }
  return c;
}
