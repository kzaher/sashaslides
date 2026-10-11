// Must be the FIRST import of worker.js: patches the Buffer polyfill (base64url etc.) and the
// string_decoder polyfill BEFORE the other polyfills load — cipher-base (crypto hash.digest(enc)),
// readable-stream (setEncoding) etc. capture `require("string_decoder").StringDecoder` when they load,
// and the polyfill's constructor rejects encodings its own table doesn't know ("Unknown encoding:
// base64url", surfacing in Claude Code as failed writes).
import { Buffer } from "buffer";
import { fixBuffer } from "./buffer-fix.js";
import string_decoder from "string_decoder";
import { reportError } from "./report.js";
fixBuffer(Buffer);
{
  const Orig = string_decoder.StringDecoder;
  const toUrl = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function StringDecoder(enc) {
    const e = String(enc || "utf8").toLowerCase();
    if (e === "base64url") {           // base64 decoder + URL-safe alphabet, no padding (chunk-safe: the
      const d = new Orig("base64");    // padding only ever appears at the very end)
      this.encoding = "base64url";
      this.write = (buf) => toUrl(d.write(buf));
      this.end = (buf) => toUrl(d.end(buf));
      this.text = (buf, i) => toUrl(d.text(buf, i));
      return this;
    }
    try { return new Orig(enc); } catch (e) { reportError("string_decoder-throw", e, { encoding: enc }); throw e; }
  }
  StringDecoder.prototype = Orig.prototype;
  string_decoder.StringDecoder = StringDecoder;
  if (string_decoder.default) string_decoder.default = string_decoder;
}
export { Buffer };
