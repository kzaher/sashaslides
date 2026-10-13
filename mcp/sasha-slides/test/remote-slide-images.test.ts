// A REMOTE CALLER NEVER CHOOSES A PATH ON THE SERVER. Found 2026-10-13 reading slide_images while testing
// every tool against https://sashaslides.com: `outDir` is a directory on the machine running the
// connector. Locally that is the user's own machine; remotely it is the production server, so a
// signed-in caller would have Drive images written wherever it named, and get back a path it cannot
// open. A remote connector now answers `unavailable` and downloads nothing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createProposal, downloadSlideImages, type ProposalEnvironment } from "../proposal";
import { createFakeDrive } from "./fake-drive";

async function stagedWithPreview(): Promise<Readonly<{ env: ProposalEnvironment; fake: ReturnType<typeof createFakeDrive>; proposalId: string }>> {
  const fake = createFakeDrive();
  const env: ProposalEnvironment = {
    drive: fake.channel,
    now: () => new Date("2026-10-13T12:00:00.000Z"),
    randomSuffix: () => "aaa111",
    sleep: () => Promise.resolve(),
    statFile: () => ({ bytes: 2048 }),
    warn: () => undefined,
  };
  const staged = await createProposal({ env, slides: [{ html: "<!doctype html><h1>x</h1>", label: null }], presentationId: null });
  if (staged.kind !== "ok") throw new Error("staging failed");
  const folder = fake.files().find((file) => file.mimeType === "application/vnd.google-apps.folder" && file.name === staged.proposalId);
  fake.putForeignFile({
    name: "01.png",
    parentId: folder?.id ?? "",
    mimeType: "image/png",
    text: "",
    appProperties: { proposalId: staged.proposalId },
  });
  return { env, fake, proposalId: staged.proposalId };
}

describe("slide_images on a remote connector", () => {
  test("downloads nothing to the server and says why", async () => {
    const { env, fake, proposalId } = await stagedWithPreview();
    const outcome = await downloadSlideImages({ env, proposalId, indices: null, outDir: "/etc/sasha", remote: true });
    assert.equal(outcome.kind, "unavailable");
    assert.match(outcome.kind === "unavailable" ? outcome.reason : "", /remote/);
    assert.deepEqual(fake.downloads(), []);
  });

  test("a local connector still writes the preview into the caller's directory", async () => {
    const { env, fake, proposalId } = await stagedWithPreview();
    const outcome = await downloadSlideImages({ env, proposalId, indices: null, outDir: "/tmp/out", remote: false });
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(fake.downloads().map((download) => download.destinationPath), ["/tmp/out/01.png"]);
  });
});
