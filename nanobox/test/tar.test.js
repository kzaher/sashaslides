import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTar, parseTar } from "../public/lib/tar.js";
import { toBytes, toText } from "../public/lib/util.js";

function roundtrip(entries) {
  return parseTar(buildTar(entries));
}

test("single file round-trips content and path", () => {
  const [f] = roundtrip([{ path: "hello.txt", type: "file", data: "hello world" }]);
  assert.equal(f.path, "hello.txt");
  assert.equal(f.type, "file");
  assert.equal(toText(f.data), "hello world");
});

test("empty file has zero-length data and no data block", () => {
  const tar = buildTar([{ path: "empty", type: "file", data: "" }]);
  assert.equal(tar.length, 512 /*header*/ + 1024 /*eof*/);
  const [f] = parseTar(tar);
  assert.equal(f.data.length, 0);
});

test("directory entry preserved", () => {
  const out = roundtrip([{ path: "d", type: "dir" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "dir");
  assert.equal(out[0].path, "d");
});

test("nested paths and mixed files/dirs preserve order and content", () => {
  const entries = [
    { path: "a", type: "dir" },
    { path: "a/b.txt", type: "file", data: "bee" },
    { path: "a/c/d.txt", type: "file", data: "dee" },
  ];
  const out = roundtrip(entries);
  assert.deepEqual(out.map((e) => e.path), ["a", "a/b.txt", "a/c/d.txt"]);
  assert.equal(toText(out[1].data), "bee");
  assert.equal(toText(out[2].data), "dee");
});

test("binary data survives exactly, including bytes that look like NUL/space", () => {
  const data = new Uint8Array(1000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
  const [f] = roundtrip([{ path: "blob.bin", type: "file", data }]);
  assert.deepEqual([...f.data], [...data]);
});

test("data is padded to 512-byte boundary but reported size is exact", () => {
  const data = toBytes("x".repeat(513));
  const tar = buildTar([{ path: "p", type: "file", data }]);
  // header + 2 data blocks (1024) + eof (1024)
  assert.equal(tar.length, 512 + 1024 + 1024);
  const [f] = parseTar(tar);
  assert.equal(f.data.length, 513);
});

test("mtime round-trips", () => {
  const [f] = roundtrip([{ path: "t", type: "file", data: "hi", mtime: 1699999999 }]);
  assert.equal(f.mtime, 1699999999);
});

test("checksum is valid (parser trusts headers; corrupt one is detectable)", () => {
  const tar = buildTar([{ path: "f", type: "file", data: "z" }]);
  // Recompute the stored checksum and compare to a fresh sum.
  const stored = parseInt(String.fromCharCode(...tar.subarray(148, 154)), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i];
  assert.equal(stored, sum);
});

test("long nested path uses ustar prefix split and still round-trips", () => {
  const deep = "project/" + "sub/".repeat(30) + "file.txt"; // > 100 chars
  assert.ok(deep.length > 100);
  const [f] = roundtrip([{ path: deep, type: "file", data: "deep" }]);
  assert.equal(f.path, deep);
  assert.equal(toText(f.data), "deep");
});

test("trailing slashes and dot segments normalize", () => {
  const [f] = roundtrip([{ path: "./a//b/", type: "dir" }]);
  assert.equal(f.path, "a/b");
});
