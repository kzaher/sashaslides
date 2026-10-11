// Worker supporting two dispatch modes over the same read-only corpus:
//   range: scan a fixed [start,end)  (static equal-split)
//   go:    work-steal chunks via one atomic cursor in a control SAB (dynamic load balancing)
// The atomic cursor is the ONLY shared mutable state; every worker advances it with Atomics.add,
// so no two workers ever scan the same chunk and none is missed.

let buf = null, needle = null, ctrl = null, chunkSize = 0, numChunks = 0, corpus = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    buf = new Uint8Array(m.sab);
    needle = m.needle;
    ctrl = new Int32Array(m.ctrlSab);   // ctrl[0] = next chunk index
    chunkSize = m.chunkSize; numChunks = m.numChunks; corpus = m.corpus;
    postMessage({ type: "ready" });
    return;
  }
  if (m.type === "range") {
    const t0 = performance.now();
    const count = countOcc(buf, needle, m.start, m.end);
    postMessage({ type: "result", id: m.id, count, ms: performance.now() - t0 });
    return;
  }
  if (m.type === "go") {
    const t0 = performance.now();
    let count = 0, chunks = 0;
    for (;;) {
      const i = Atomics.add(ctrl, 0, 1);   // claim the next chunk
      if (i >= numChunks) break;
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, corpus);
      count += countOcc(buf, needle, start, end);
      chunks++;
    }
    postMessage({ type: "result", id: m.id, count, ms: performance.now() - t0, chunks });
  }
};

function countOcc(buf, needle, start, end) {
  const n0 = needle[0], nl = needle.length;
  let c = 0;
  for (let i = start; i < end; i++) {
    if (buf[i] === n0) { let k = 1; while (k < nl && buf[i + k] === needle[k]) k++; if (k === nl) c++; }
  }
  return c;
}
