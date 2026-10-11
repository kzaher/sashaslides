// The `buffer` polyfill (6.0.3) has no "base64url" encoding (Node ≥ 15.7 does; Claude Code uses it
// when writing files: "Unknown encoding: base64url"). Add it on top of base64 with the URL-safe
// alphabet and no padding, for from/toString/write/byteLength/isEncoding/compare-by-string paths.
export function fixBuffer(Buffer) {
  const isB64u = (e) => typeof e === "string" && e.toLowerCase() === "base64url";
  const toStd = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); return s + "=".repeat((4 - (s.length % 4)) % 4); };
  const toUrl = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const from = Buffer.from;
  Buffer.from = function (v, enc, ...r) { return typeof v === "string" && isB64u(enc) ? from.call(Buffer, toStd(v), "base64") : from.call(Buffer, v, enc, ...r); };
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (enc, ...r) { return isB64u(enc) ? toUrl(toString.call(this, "base64", ...r)) : toString.call(this, enc, ...r); };
  const write = Buffer.prototype.write;
  Buffer.prototype.write = function (string, offset, length, encoding) {
    // (string, encoding) | (string, offset, encoding) | (string, offset, length, encoding)
    if (isB64u(offset)) return write.call(this, toStd(string), "base64");
    if (isB64u(length)) return write.call(this, toStd(string), offset, "base64");
    if (isB64u(encoding)) return write.call(this, toStd(string), offset, length, "base64");
    return write.call(this, string, offset, length, encoding);
  };
  const isEncoding = Buffer.isEncoding; Buffer.isEncoding = (e) => isB64u(e) || isEncoding.call(Buffer, e);
  const byteLength = Buffer.byteLength; Buffer.byteLength = (s, enc, ...r) => (typeof s === "string" && isB64u(enc)) ? byteLength.call(Buffer, toStd(s), "base64") : byteLength.call(Buffer, s, enc, ...r);
  const alloc = Buffer.alloc; Buffer.alloc = (n, fill, enc) => isB64u(enc) ? alloc.call(Buffer, n, Buffer.from(fill, "base64url")) : alloc.call(Buffer, n, fill, enc);
  const fill = Buffer.prototype.fill; Buffer.prototype.fill = function (v, a, b, enc) { if (isB64u(enc)) return fill.call(this, Buffer.from(v, "base64url"), a, b); if (isB64u(b)) return fill.call(this, Buffer.from(v, "base64url"), a); if (isB64u(a)) return fill.call(this, Buffer.from(v, "base64url")); return fill.call(this, v, a, b, enc); };
  // report encodings/arguments the polyfill rejects (they surface in the CLI as generic errors)
  for (const name of ["from", "alloc", "byteLength", "concat"]) { const f = Buffer[name]; Buffer[name] = function (...a) { try { return f.apply(Buffer, a); } catch (e) { onThrow && onThrow(e, "Buffer." + name); throw e; } }; }
  for (const name of ["toString", "write", "fill"]) { const f = Buffer.prototype[name]; Buffer.prototype[name] = function (...a) { try { return f.apply(this, a); } catch (e) { onThrow && onThrow(e, "Buffer#" + name); throw e; } }; }
  return Buffer;
}
let onThrow = null;
export function setBufferThrowHook(f) { onThrow = f; }
