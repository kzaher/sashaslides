import { writeFileSync } from "node:fs";
const MiB = 1048576, CORPUS = 256 * MiB, B = 65536;
const line = Buffer.from("2026-08-13T00:00:00Z INFO service=api req=GET /v1/things status=200 latency=12ms trace=abc123 msg=ok\n");
const NEEDLE = Buffer.from("NEEDLE");

const block = Buffer.alloc(B, 0x2e); // '.' filler → no NUL bytes
let o = 0;
while (o + line.length <= B) { line.copy(block, o); o += line.length; }
block[B - 1] = 0x0a; // end block on a newline
for (const p of [1024, 17000, 33000, 49000]) NEEDLE.copy(block, p);

const buf = Buffer.allocUnsafe(CORPUS);
for (let i = 0; i < CORPUS; i += B) block.copy(buf, i);
writeFileSync("public/bench/corpus.bin", buf);

let c = 0, idx = buf.indexOf(NEEDLE, 0);
while (idx !== -1) { c++; idx = buf.indexOf(NEEDLE, idx + 1); }
console.log(JSON.stringify({ bytes: CORPUS, mib: CORPUS / MiB, occurrences: c, hasNUL: buf.includes(0), blockLineLen: line.length }));
