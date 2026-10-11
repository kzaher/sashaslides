// nanobox host channel — the JS end of the guest's /dev/hvc1 (engine: nanoboxVirtioConsole in
// bochs/wasm.cc, hook slots via nanobox_hc_hook_slot(0)=write(ptr,len), (1)=read(ptr,max)->n).
// Byte stream both ways; framing is up to the users (see native/proto.js: length-prefixed JSON +
// binary frames). Works in node (harness) and in the worker (opt-worker.js).
//   const hc = NanoboxHostChan.attach(instance, table, trampoline);   // after instantiate
//   hc.onData = (u8) => ...;   // guest -> host bytes
//   hc.send(u8);               // host -> guest bytes (queued; the engine's rx timer drains it)
(function (global) {
  function attach(inst, table, trampoline) {
    const ex = inst.exports;
    if (!ex.nanobox_hc_hook_slot) return null;
    const mem = () => new Uint8Array(ex.memory.buffer);
    const hc = { onData: null, queue: [], qOff: 0, bytesIn: 0, bytesOut: 0 };
    hc.send = (u8) => { if (u8 && u8.length) hc.queue.push(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)); };
    hc.pending = () => hc.queue.reduce((n, b) => n + b.length, 0) - hc.qOff;
    const write = (ptr, len) => { const b = mem().slice(ptr, ptr + len); hc.bytesIn += len; if (hc.onData) hc.onData(b); };
    const read = (ptr, max) => {
      let n = 0; const m = mem();
      while (n < max && hc.queue.length) {
        const head = hc.queue[0]; const take = Math.min(max - n, head.length - hc.qOff);
        m.set(head.subarray(hc.qOff, hc.qOff + take), ptr + n); n += take; hc.qOff += take;
        if (hc.qOff >= head.length) { hc.queue.shift(); hc.qOff = 0; }
      }
      hc.bytesOut += n; return n;
    };
    table.set(ex.nanobox_hc_hook_slot(0), trampoline([0x7f, 0x7f], [], write));
    table.set(ex.nanobox_hc_hook_slot(1), trampoline([0x7f, 0x7f], [0x7f], read));
    return hc;
  }
  global.NanoboxHostChan = { attach };
})(typeof self !== "undefined" ? self : globalThis);
