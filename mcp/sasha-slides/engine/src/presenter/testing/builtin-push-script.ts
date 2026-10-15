// ENTRY POINT for the protocol check "a built-in also runs through the runner": esbuild bundles this
// into a script string (the Chrome driver does it at test time), which the scenario page stores as an
// approved transition script and plays through the sandboxed runner like any script Claude writes.
// It proves the runner hands a script the same `TransitionContext` the in-page host does.

import type { TransitionAuthoringGlobal } from "../../contracts/transition-protocol.ts";
import { PUSH_TRANSITION } from "../builtin/push.ts";

// The runner bootstrap installs this global before it evaluates the script (runner/bootstrap.ts).
const authoring = Reflect.get(globalThis, "sashaTransition") as TransitionAuthoringGlobal;
authoring.define(PUSH_TRANSITION);
