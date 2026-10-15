// The chrome harness page's entry: picks the scenario from the address and mounts it, exposing the
// handle the drivers read as `window.sashaHarness`. Explicit resource management first, as in every
// engine entry point (SPEC.md section 16).

import "../../src/platform/explicit-resource-management.ts";
import { HARNESS_SCENARIOS, mountHarness } from "../../src/view/testing/chrome-harness.tsx";
import { PAGE_ROOT_ID } from "../../src/view/application/editor-page.ts";

const requested = new URLSearchParams(window.location.search).get("scenario") ?? "editor";
const scenario = HARNESS_SCENARIOS.find((name) => name === requested) ?? "editor";
const container = document.getElementById(PAGE_ROOT_ID);
if (container !== null) Reflect.set(window, "sashaHarness", mountHarness({ container, scenario }));
