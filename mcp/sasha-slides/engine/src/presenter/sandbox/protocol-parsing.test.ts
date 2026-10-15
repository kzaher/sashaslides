// Message validation at the protocol boundary: every runner message kind parses into a fresh value
// carrying only the contract's fields; anything malformed is reported as invalid (the host then
// counts it as rejected). The runner side parses the host's messages the same way.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TRANSITION_LIMITS, TRANSITION_PROTOCOL } from "../../contracts/transition-protocol.ts";
import { parseHostToRunnerMessage, parseRunnerToHostMessage } from "./protocol-parsing.ts";

const envelope = { protocol: TRANSITION_PROTOCOL, runId: "rn_Test00001" };

describe("parsing runner messages", () => {
  const valid = [
    { ...envelope, kind: "prepared" },
    { ...envelope, kind: "started" },
    { ...envelope, kind: "finished" },
    { ...envelope, kind: "pong", sequence: 3, progress: 0.4 },
    { ...envelope, kind: "failed", stage: "run", message: "TypeError" },
    { ...envelope, kind: "log", level: "warning", message: "careful" },
  ];
  for (const message of valid) {
    it(`accepts ${message.kind}`, () => {
      const parsed = parseRunnerToHostMessage(message);
      assert.equal(parsed.kind, "valid");
      assert.deepEqual(parsed.kind === "valid" ? parsed.message : null, message);
    });
  }

  const invalid = [
    { label: "another protocol", data: { ...envelope, protocol: "sasha-transition/1", kind: "finished" } },
    { label: "no runId", data: { protocol: TRANSITION_PROTOCOL, kind: "finished" } },
    { label: "an unknown kind", data: { ...envelope, kind: "takeOver" } },
    { label: "a pong without a sequence", data: { ...envelope, kind: "pong", progress: 0.1 } },
    { label: "a pong with an infinite progress", data: { ...envelope, kind: "pong", sequence: 1, progress: Number.POSITIVE_INFINITY } },
    { label: "a failure at an unknown stage", data: { ...envelope, kind: "failed", stage: "later", message: "x" } },
    { label: "a log at an unknown level", data: { ...envelope, kind: "log", level: "debug", message: "x" } },
    { label: "not an object", data: "finished" },
    { label: "null", data: null },
  ];
  for (const row of invalid) {
    it(`rejects ${row.label}`, () => {
      assert.equal(parseRunnerToHostMessage(row.data).kind, "invalid");
    });
  }

  it("drops fields the contract does not name and truncates long messages", () => {
    const parsed = parseRunnerToHostMessage({ ...envelope, kind: "log", level: "error", message: "x".repeat(2000), smuggled: { password: "hunter2" } });
    assert.equal(parsed.kind, "valid");
    if (parsed.kind !== "valid") return;
    assert.equal(Reflect.has(parsed.message, "smuggled"), false);
    assert.equal(parsed.message.kind === "log" ? parsed.message.message.length : 0, TRANSITION_LIMITS.maximumLogMessageLength);
  });
});

describe("parsing host messages in the runner", () => {
  it("accepts a prepare with markup, parameters and transferred bytes", () => {
    const prepare = {
      ...envelope,
      kind: "prepare",
      bundle: { script: "sashaTransition.define({ run() {} })", stylesheet: "", markup: "" },
      outgoing: null,
      incoming: { markup: "<div></div>", elements: [], assetIds: [], fontFaces: [] },
      assets: [],
      fonts: [{ family: "Manrope", weight: 400, style: "normal", bytes: new ArrayBuffer(4) }],
      pageHeight: 720,
      durationMilliseconds: 600,
      direction: "forward",
      parameters: { easing: "linear", nested: [1, "two", { three: true }] },
      reducedMotion: false,
    };
    const parsed = parseHostToRunnerMessage(prepare);
    assert.equal(parsed.kind, "valid");
  });

  const invalid = [
    { label: "a prepare without a bundle", data: { ...envelope, kind: "prepare" } },
    { label: "a ping with a negative sequence", data: { ...envelope, kind: "ping", sequence: -1 } },
    { label: "a cancel for an unknown reason", data: { ...envelope, kind: "cancel", reason: "bored" } },
  ];
  for (const row of invalid) {
    it(`rejects ${row.label}`, () => {
      assert.equal(parseHostToRunnerMessage(row.data).kind, "invalid");
    });
  }
});
