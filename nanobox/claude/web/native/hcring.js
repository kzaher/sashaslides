// Single-producer / single-consumer byte ring over a SharedArrayBuffer — the host->guest half of the
// host channel between the runtime worker (writes) and the VM worker (reads inside the engine's
// hook, which runs while the VM loop never yields to its event loop, hence no postMessage there).
//   const ring = NanoboxHcRing.create(1 << 20);          // in the page: ring.sab is transferable-by-sharing
//   const w = NanoboxHcRing.writer(sab); w.write(u8);    // runtime worker (blocks with Atomics.wait if full)
//   const r = NanoboxHcRing.reader(sab); r.read(max) -> Uint8Array | null   // VM worker (non-blocking)
// layout: Int32 [0]=head (read pos), [1]=tail (write pos), [2]=capacity; bytes from offset 16
(function (global) {
  const HDR = 16;
  function create(cap) { const sab = new SharedArrayBuffer(HDR + cap); new Int32Array(sab, 0, 3)[2] = cap; return { sab }; }
  function writer(sab) {
    const ctl = new Int32Array(sab, 0, 3), data = new Uint8Array(sab, HDR); const cap = ctl[2];
    return {
      write(u8) {
        let o = 0;
        while (o < u8.length) {
          const head = Atomics.load(ctl, 0), tail = Atomics.load(ctl, 1);
          const used = (tail - head + cap) % cap, free = cap - 1 - used;
          if (free === 0) { Atomics.wait(ctl, 0, head, 5); continue; }   // consumer will move head; re-check every 5 ms
          const n = Math.min(free, u8.length - o, cap - tail);
          data.set(u8.subarray(o, o + n), tail); o += n;
          Atomics.store(ctl, 1, (tail + n) % cap); Atomics.notify(ctl, 1);
        }
      },
      pending() { const head = Atomics.load(ctl, 0), tail = Atomics.load(ctl, 1); return (tail - head + cap) % cap; },
    };
  }
  function reader(sab) {
    const ctl = new Int32Array(sab, 0, 3), data = new Uint8Array(sab, HDR); const cap = ctl[2];
    return {
      read(max) {
        const head = Atomics.load(ctl, 0), tail = Atomics.load(ctl, 1);
        const avail = (tail - head + cap) % cap; if (!avail) return null;
        const n = Math.min(avail, max, cap - head);
        const out = data.slice(head, head + n);
        Atomics.store(ctl, 0, (head + n) % cap); Atomics.notify(ctl, 0);
        return out;
      },
      pending() { const head = Atomics.load(ctl, 0), tail = Atomics.load(ctl, 1); return (tail - head + cap) % cap; },
    };
  }
  global.NanoboxHcRing = { create, writer, reader };
})(typeof self !== "undefined" ? self : globalThis);
