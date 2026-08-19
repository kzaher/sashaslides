// nanobox — "is there input waiting for the guest?" as one bit of shared memory.
//
// xterm-pty's TtyServer/TtyClient protocol makes EVERY guest poll_oneoff, fd_read and fd_write a
// blocking round trip to the PAGE'S MAIN THREAD: TtyClient.req() is `postMessage(...)` followed by
// `Atomics.wait(...)` until the page's event loop turns and answers. The engine's virtio-console rx
// timer polls stdin ~1500 times a second and all but a handful of those polls have nothing to report,
// so the emulator spends its time parked in Atomics.wait waiting for a main thread that has nothing
// to say. Measured on the codex sandbox (work/prof/uilat.md): 6.5 % of wall with an idle main thread,
// but 34 % at 50 % main-thread load and 65 % at 86 %, dragging the guest from 124 MIPS down to 31 —
// a keystroke that costs the guest 40 M instructions then takes >1 s instead of 200 ms, and the
// characters typed meanwhile queue in the pty and land in one burst. The harness has no main thread
// in its tty path, which is why this is invisible there.
//
// The fix is to publish the single bit the worker actually needs — "the server is holding bytes you
// have not taken" — in a SharedArrayBuffer, so a poll with nothing waiting is answered inside the
// worker and never touches the page. Input latency is unchanged: the moment a keystroke lands in the
// server's queue the flag goes up, and the guest's next poll (still ~1500/s) does the real round trip.
//
// Page side. Worker side: web/opt-worker.js wraps TtyClient.onWaitForReadable when cfg.ttySignal is set.
//
// The same protocol makes fd_write blocking too, and once the polls are gone that is what is left:
// the guest's console output is ~110 writes/s and each one parks the emulator until the page answers
// (measured 5.8 ms per write at 86 % main-thread load = 16 % of wall). So stdout gets its own ring
// (web/native/hcring.js): the worker appends and posts a plain non-blocking message, the page drains
// the ring into the pty slave, and the worker only ever waits if the ring actually fills — which is
// real backpressure rather than a round trip per frame.
(function (global) {
  function create(slave) {
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const out = global.NanoboxHcRing.create(1 << 20);
    const rd = global.NanoboxHcRing.reader(out.sab);
    return {
      sab,
      outSab: out.sab,
      // the page side of the output ring: call from the worker's message handler (the worker posts
      // {type:"nanobox-tty-out"} after every append, so a drain is always scheduled behind the data)
      drain() { for (;;) { const b = rd.read(8192); if (!b) return; slave.write(b); } },
      // Wrap a TtyServer before start(): the flag tracks "toWorkerBuf is non-empty". Every push into
      // that queue comes from the slave's onReadable, and the only thing that empties it is a
      // feedToWorker (which acks), so recomputing at those two points cannot miss a keystroke — and
      // a stale 1 only costs one ordinary round trip.
      attach(server) {
        const set = () => Atomics.store(flag, 0, server.toWorkerBuf.length || slave.readable ? 1 : 0);
        slave.onReadable(set);   // registered after the server's own handler, so toWorkerBuf is already filled
        const ack = server.ack.bind(server);
        server.ack = function () { set(); return ack(); };
        return server;
      },
    };
  }
  global.NanoboxTtySignal = { create };
})(self);
