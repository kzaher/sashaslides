// THE ADD-ON WRITES THE PICK WHERE A REMOTE CONNECTOR CAN READ IT. Runs the BUILT Code.gs's
// sashaWritePick in a vm with a fake DriveApp, so build first:
//
//   npm run -s build && node --test --import tsx src/pick-slot.e2e.ts
//
// Measured 2026-10-12 on sashaslides.com: the pick was inserted, but claude.ai's await_pick waited 7.5
// minutes, because the PICK this function created belongs to the Apps Script project and the remote
// connector (drive.file) can only see files it created itself. The connector now stages an empty
// PICK.slot; this function must write into it and rename it PICK, and create PICK only when no slot
// exists (proposals staged by an older connector).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const CODE_GS = join(import.meta.dirname, "..", "..", "..", "..", "dist", "mcp", "sasha-slides", "addon", "Code.gs");

type FakeFile = { id: string; name: string; content: string };

function run(options: Readonly<{ folderFiles: FakeFile[] }>): Readonly<{ result: unknown; files: FakeFile[]; tagged: string[] }> {
  const files = options.folderFiles;
  const tagged: string[] = [];
  const iterator = (list: FakeFile[]) => {
    let at = 0;
    const handle = (file: FakeFile) => ({
      getId: () => file.id,
      setContent: (text: string) => void (file.content = text),
      setName: (name: string) => void (file.name = name),
    });
    return { hasNext: () => at < list.length, next: () => handle(list[at++] as FakeFile) };
  };
  const sandbox = {
    DriveApp: {
      getFolderById: () => ({
        getFilesByName: (name: string) => iterator(files.filter((file) => file.name === name)),
        createFile: (blob: { name: string; body: string }) => {
          const file = { id: `created-${String(files.length)}`, name: blob.name, content: blob.body };
          files.push(file);
          return { getId: () => file.id };
        },
      }),
    },
    Utilities: { newBlob: (body: string, _mime: string, name: string) => ({ body, name }) },
    sashaTag_: (fileId: string) => void tagged.push(fileId),
    result: null as unknown,
  };
  const source = readFileSync(CODE_GS, "utf8");
  const fn = source.match(/function sashaWritePick\(spec\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(fn !== undefined, `sashaWritePick not found in ${CODE_GS} (run npm run -s build first)`);
  vm.runInNewContext(`${fn}\nresult = sashaWritePick({ folderId: "f", name: "PICK", mimeType: "application/json", body: "{\\"picked\\":1}", appProperties: {} });`, sandbox);
  // Through JSON: objects made inside the vm have its own Object prototype, which strict deepEqual rejects.
  return { result: JSON.parse(JSON.stringify(sandbox.result)) as unknown, files, tagged };
}

test("writes into the connector's PICK.slot and renames it PICK, creating nothing", () => {
  const slot = { id: "slot-1", name: "PICK.slot", content: "" };
  const { result, files, tagged } = run({ folderFiles: [{ id: "s1", name: "01.html", content: "<h1>" }, slot] });
  assert.deepEqual(result, { fileId: "slot-1" });
  assert.equal(slot.name, "PICK");
  assert.equal(slot.content, '{"picked":1}');
  assert.equal(files.length, 2, "no new file");
  assert.deepEqual(tagged, ["slot-1"]);
});

test("without a slot (an older connector's proposal) it creates PICK as before", () => {
  const { result, files } = run({ folderFiles: [{ id: "s1", name: "01.html", content: "<h1>" }] });
  assert.deepEqual(result, { fileId: "created-1" });
  assert.equal(files.find((file) => file.id === "created-1")?.name, "PICK");
});
