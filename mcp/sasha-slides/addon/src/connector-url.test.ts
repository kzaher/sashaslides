// THE SHIPPED ADD-ON MUST NAME ITS CONNECTOR. Found 2026-10-14: every build run without
// SASHA_CONNECTOR_URL produced a sidebar whose Setup tab said "The Sasha connector address is not
// configured yet", so a user saw no address to give Claude and no walkthrough video. The production
// address is now the default; only an explicit "none" builds the unconfigured panel.
import assert from "node:assert/strict";
import test from "node:test";
import { connectorUrlOf, PRODUCTION_CONNECTOR_URL } from "./connector-url.ts";

test("unset means the production connector", () => {
  assert.equal(PRODUCTION_CONNECTOR_URL, "https://sashaslides.com/mcp");
  assert.equal(connectorUrlOf(undefined), "https://sashaslides.com/mcp");
  assert.equal(connectorUrlOf("  "), "https://sashaslides.com/mcp");
});

test("an explicit https address wins, and 'none' leaves it unconfigured", () => {
  assert.equal(connectorUrlOf("https://sasha.example.com/mcp"), "https://sasha.example.com/mcp");
  assert.equal(connectorUrlOf("none"), null);
});

test("anything that is not an https URL fails the build", () => {
  assert.throws(() => connectorUrlOf("http://sasha.example.com/mcp"), /must be https/);
  assert.throws(() => connectorUrlOf("not a url"), /is not a URL/);
});
