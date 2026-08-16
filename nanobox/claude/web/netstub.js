// nanobox/claude — a deterministic stand-in for container2wasm's network stack.
//
// The engine's `--net=socket=listenfd=N` backend talks length-prefixed Ethernet frames (4-byte
// big-endian size + frame) over one accepted WASI socket: accept4(listenfd) -> connfd, then
// send()/recv()/select() on connfd. container2wasm bridges that to a gvisor netstack in another
// worker; the replies arrive whenever that worker gets around to it, which makes guest state depend
// on host scheduling. This stub answers synchronously and always the same way, so guest RAM stays a
// pure function of the guest's own instruction stream:
//   ARP        any address -> our MAC (proxy ARP)
//   DHCP       DISCOVER/REQUEST -> OFFER/ACK  guest 192.168.127.3/24, router+dns 192.168.127.1
//   DNS (udp/53)  -> NXDOMAIN (fast, deterministic failure)
//   TCP SYN    -> RST/ACK (connections are refused immediately; nothing ever connects)
//   ICMP echo  -> echo reply
//   anything else is dropped
// Same subnet numbers as container2wasm, so the guest init's expectations (proxy at .253, 9p at
// .252) are unchanged — they are simply unreachable.
//
//   const net = NanoboxNet.create({ mac: [2,0,0,0,0,2] });
//   net.attach(wasiImport, { listenfd: 4, connfd: 5, memory: () => inst.exports.memory });
// attach() wraps sock_accept / sock_send / sock_recv / fd_fdstat_get / fd_fdstat_set_flags /
// fd_close / poll_oneoff for those two fds and leaves everything else to whatever was there.
// Works in a classic worker (self.NanoboxNet) and node (globalThis.NanoboxNet).
(function (global) {
  const E = { SUCCESS: 0, AGAIN: 6, BADF: 8, INVAL: 28, NOTSUP: 58 };
  const GUEST_IP = [192, 168, 127, 3], HOST_IP = [192, 168, 127, 1], MASK = [255, 255, 255, 0];
  const BCAST_MAC = [255, 255, 255, 255, 255, 255];

  function csum16(bytes, off, len, seed) {
    let s = seed || 0;
    for (let i = 0; i < len - 1; i += 2) s += (bytes[off + i] << 8) | bytes[off + i + 1];
    if (len & 1) s += bytes[off + len - 1] << 8;
    while (s >>> 16) s = (s & 0xffff) + (s >>> 16);
    return (~s) & 0xffff;
  }
  function put16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
  function put32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function get16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function get32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  const eq = (a, o, b) => b.every((v, i) => a[o + i] === v);

  function create(opts) {
    opts = opts || {};
    const MAC = opts.mac || [2, 0, 0, 0, 0, 2];
    const stats = { framesIn: 0, framesOut: 0, arp: 0, dhcp: 0, dns: 0, tcpRst: 0, icmp: 0, dropped: 0, bytesIn: 0, bytesOut: 0 };
    let outQueue = [];      // Uint8Array frames (each already length-prefixed) waiting for the guest
    let outOff = 0;         // read offset into outQueue[0]
    let inBuf = new Uint8Array(0); // partial stream from the guest
    let accepted = false;   // the guest's accept4(listenfd) happened (one connection, ever)
    const log = opts.log || null;

    function emit(frame) { const f = new Uint8Array(4 + frame.length); put32(f, 0, frame.length); f.set(frame, 4); outQueue.push(f); stats.framesOut++; stats.bytesOut += frame.length; }
    function ethHeader(dstMac, type) { const b = new Uint8Array(14); b.set(dstMac, 0); b.set(MAC, 6); put16(b, 12, type); return b; }
    function cat(...parts) { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
    function ipv4(proto, src, dst, payload) {
      const h = new Uint8Array(20);
      h[0] = 0x45; put16(h, 2, 20 + payload.length); put16(h, 4, 0); put16(h, 6, 0x4000); h[8] = 64; h[9] = proto; h.set(src, 12); h.set(dst, 16);
      put16(h, 10, csum16(h, 0, 20));
      return cat(h, payload);
    }
    function udp(sport, dport, src, dst, payload) {
      const u = new Uint8Array(8 + payload.length);
      put16(u, 0, sport); put16(u, 2, dport); put16(u, 4, u.length); put16(u, 6, 0); u.set(payload, 8); // checksum 0 = none (IPv4)
      return ipv4(17, src, dst, u);
    }
    function l4csum(proto, src, dst, seg) {
      const ph = new Uint8Array(12 + seg.length); ph.set(src, 0); ph.set(dst, 4); ph[9] = proto; put16(ph, 10, seg.length); ph.set(seg, 12);
      return csum16(ph, 0, ph.length);
    }

    function onArp(f) {
      const a = 14;
      if (get16(f, a + 6) !== 1) return; // request only
      stats.arp++;
      const r = new Uint8Array(28);
      put16(r, 0, 1); put16(r, 2, 0x0800); r[4] = 6; r[5] = 4; put16(r, 6, 2);
      r.set(MAC, 8); r.set(f.subarray(a + 24, a + 28), 14);         // sender = us, at the asked-for IP
      r.set(f.subarray(a + 8, a + 14), 18); r.set(f.subarray(a + 14, a + 18), 24); // target = asker
      emit(cat(ethHeader(Array.from(f.subarray(6, 12)), 0x0806), r));
    }
    function onDhcp(f, ip, udpOff) {
      const d = udpOff + 8;
      if (f[d] !== 1 || !eq(f, d + 236, [0x63, 0x82, 0x53, 0x63])) return;
      let type = 0; for (let o = d + 240; o < f.length && f[o] !== 255;) { const c = f[o], l = f[o + 1]; if (c === 0) { o++; continue; } if (c === 53) type = f[o + 2]; o += 2 + l; }
      if (type !== 1 && type !== 3) return;
      stats.dhcp++;
      const opt = [53, 1, type === 1 ? 2 : 5, 54, 4, ...HOST_IP, 51, 4, 0x7f, 0xff, 0xff, 0xff, 1, 4, ...MASK, 3, 4, ...HOST_IP, 6, 4, ...HOST_IP, 255];
      const r = new Uint8Array(240 + opt.length);
      r[0] = 2; r[1] = 1; r[2] = 6; r.set(f.subarray(d + 4, d + 8), 4);   // xid
      r.set(f.subarray(d + 10, d + 12), 10);                               // flags
      r.set(GUEST_IP, 16); r.set(HOST_IP, 20);                              // yiaddr, siaddr
      r.set(f.subarray(d + 28, d + 44), 28);                               // chaddr
      r.set([0x63, 0x82, 0x53, 0x63], 236); r.set(opt, 240);
      emit(cat(ethHeader(BCAST_MAC, 0x0800), udp(67, 68, HOST_IP, [255, 255, 255, 255], r)));
    }
    function onDns(f, ipOff, udpOff) {
      stats.dns++;
      const q = f.subarray(udpOff + 8);
      const r = new Uint8Array(q); if (r.length < 12) return;
      put16(r, 2, 0x8000 | (get16(r, 2) & 0x0100) | 0x0080 | 3); put16(r, 6, 0); put16(r, 8, 0); // QR|RD|RA, NXDOMAIN, no answers
      const src = Array.from(f.subarray(ipOff + 16, ipOff + 20)), dst = Array.from(f.subarray(ipOff + 12, ipOff + 16));
      emit(cat(ethHeader(Array.from(f.subarray(6, 12)), 0x0800), udp(get16(f, udpOff + 2), get16(f, udpOff), src, dst, r)));
    }
    function onTcp(f, ipOff, tOff) {
      const flags = f[tOff + 13];
      if (flags & 0x04) return; // never answer a RST
      stats.tcpRst++;
      const src = Array.from(f.subarray(ipOff + 16, ipOff + 20)), dst = Array.from(f.subarray(ipOff + 12, ipOff + 16));
      const dataOff = (f[tOff + 12] >> 4) * 4;
      const seg = get16(f, ipOff + 2) - (f[ipOff] & 15) * 4 - dataOff + ((flags & 0x02) ? 1 : 0) + ((flags & 0x01) ? 1 : 0);
      const t = new Uint8Array(20);
      put16(t, 0, get16(f, tOff + 2)); put16(t, 2, get16(f, tOff));
      if (flags & 0x10) { put32(t, 4, get32(f, tOff + 8)); t[13] = 0x04; }        // ACK set: RST with seq = their ack
      else { put32(t, 4, 0); put32(t, 8, (get32(f, tOff + 4) + seg) >>> 0); t[13] = 0x14; } // else RST/ACK
      t[12] = 5 << 4; put16(t, 14, 0);
      put16(t, 16, l4csum(6, src, dst, t));
      emit(cat(ethHeader(Array.from(f.subarray(6, 12)), 0x0800), ipv4(6, src, dst, t)));
    }
    function onIcmp(f, ipOff, iOff) {
      if (f[iOff] !== 8) return;
      stats.icmp++;
      const p = new Uint8Array(f.subarray(iOff)); p[0] = 0; put16(p, 2, 0); put16(p, 2, csum16(p, 0, p.length));
      const src = Array.from(f.subarray(ipOff + 16, ipOff + 20)), dst = Array.from(f.subarray(ipOff + 12, ipOff + 16));
      emit(cat(ethHeader(Array.from(f.subarray(6, 12)), 0x0800), ipv4(1, src, dst, p)));
    }
    function onFrame(f) {
      stats.framesIn++; stats.bytesIn += f.length;
      if (f.length < 14) { stats.dropped++; return; }
      const type = get16(f, 12);
      if (type === 0x0806) return onArp(f);
      if (type !== 0x0800) { stats.dropped++; return; }
      const ip = 14; if ((f[ip] >> 4) !== 4) { stats.dropped++; return; }
      const ihl = (f[ip] & 15) * 4, proto = f[ip + 9], l4 = ip + ihl;
      if (proto === 17) {
        const dport = get16(f, l4 + 2);
        if (dport === 67) return onDhcp(f, ip, l4);
        if (dport === 53) return onDns(f, ip, l4);
        stats.dropped++; return;
      }
      if (proto === 6) return onTcp(f, ip, l4);
      if (proto === 1) return onIcmp(f, ip, l4);
      stats.dropped++;
    }
    // bytes from the guest: split the stream into frames
    function feed(bytes) {
      inBuf = inBuf.length ? cat(inBuf, bytes) : new Uint8Array(bytes);
      while (inBuf.length >= 4) {
        const n = get32(inBuf, 0);
        if (inBuf.length < 4 + n) break;
        onFrame(inBuf.subarray(4, 4 + n));
        inBuf = inBuf.slice(4 + n);
      }
    }
    // hand up to `len` queued bytes to the guest
    function take(dst, off, len) {
      let n = 0;
      while (n < len && outQueue.length) {
        const f = outQueue[0]; const k = Math.min(len - n, f.length - outOff);
        dst.set(f.subarray(outOff, outOff + k), off + n); n += k; outOff += k;
        if (outOff >= f.length) { outQueue.shift(); outOff = 0; }
      }
      return n;
    }
    const readable = () => outQueue.length > 0;

    function attach(wasiImport, cfg) {
      const LFD = cfg.listenfd, CFD = cfg.connfd, memory = cfg.memory;
      const view = () => new DataView(memory().buffer), u8 = () => new Uint8Array(memory().buffer);
      const impl = {
        sock_accept(fd, flags, fdPtr) { if (fd !== LFD) return undefined; if (accepted) return E.AGAIN; accepted = true; view().setUint32(fdPtr, CFD, true); return E.SUCCESS; },
        sock_send(fd, iovs, iovsLen, flags, nPtr) {
          if (fd !== CFD) return undefined;
          const v = view(), h = u8(); let n = 0;
          for (let i = 0; i < iovsLen; i++) { const b = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); feed(h.subarray(b, b + l)); n += l; }
          v.setUint32(nPtr, n, true); return E.SUCCESS;
        },
        sock_recv(fd, iovs, iovsLen, flags, nPtr, roFlagsPtr) {
          if (fd !== CFD) return undefined;
          if (!readable()) return E.AGAIN;
          const v = view(), h = u8(); let n = 0;
          for (let i = 0; i < iovsLen && readable(); i++) { const b = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true); n += take(h, b, l); }
          v.setUint32(nPtr, n, true); v.setUint16(roFlagsPtr, 0, true); return E.SUCCESS;
        },
        fd_fdstat_get(fd, buf) { if (fd !== LFD && fd !== CFD) return undefined; const v = view(); v.setUint8(buf, 6 /* SOCKET_STREAM */); v.setUint16(buf + 2, 4 /* NONBLOCK */, true); v.setBigUint64(buf + 8, 0x1fffffffn, true); v.setBigUint64(buf + 16, 0x1fffffffn, true); return E.SUCCESS; },
        fd_fdstat_set_flags(fd) { if (fd !== LFD && fd !== CFD) return undefined; return E.SUCCESS; },
        fd_close(fd) { if (fd !== CFD) return undefined; accepted = false; outQueue = []; outOff = 0; inBuf = new Uint8Array(0); return E.SUCCESS; },
        poll_oneoff(inPtr, outPtr, n, nevPtr) {
          // if the guest waits for connfd to become readable and a reply is queued, say so now
          if (!readable()) return undefined;
          const v = view();
          for (let i = 0; i < n; i++) {
            const base = inPtr + i * 48; const tag = v.getUint8(base + 8);
            if (tag === 1 && v.getUint32(base + 16, true) === CFD) {
              v.setBigUint64(outPtr, v.getBigUint64(base, true), true); v.setUint16(outPtr + 8, 0, true); v.setUint8(outPtr + 10, 1);
              v.setBigUint64(outPtr + 16, BigInt(outQueue.length), true); v.setUint16(outPtr + 24, 0, true);
              v.setUint32(nevPtr, 1, true); return E.SUCCESS;
            }
          }
          return undefined;
        },
      };
      for (const name of Object.keys(impl)) {
        const orig = wasiImport[name], f = impl[name];
        wasiImport[name] = function () { const r = f.apply(null, arguments); if (r !== undefined) return r; return orig ? orig.apply(this, arguments) : E.NOTSUP; };
      }
      return { stats };
    }
    // checkpoint support (harness): everything above that outlives a call, as plain data
    function snapshot() { return { accepted, outOff, outQueue: outQueue.map((f) => f.slice()), inBuf: inBuf.slice(), stats: Object.assign({}, stats) }; }
    function restore(s) { accepted = s.accepted; outOff = s.outOff; outQueue = s.outQueue.map((f) => new Uint8Array(f)); inBuf = new Uint8Array(s.inBuf); if (s.stats) Object.assign(stats, s.stats); }
    return { attach, stats, feed, take, readable, onFrame, MAC, GUEST_IP, HOST_IP, snapshot, restore };
  }
  global.NanoboxNet = { create };
})(typeof self !== "undefined" ? self : globalThis);
