// node test/native-eval.mjs "<js>"  — evaluate code inside the running claude-native worker (tab must be open)
import CDP from "chrome-remote-interface";
const targets = await CDP.List({ port: 9222 });
const t = targets.find((x) => x.url.includes("claude-native.html"));
if (!t) { console.log("no claude-native tab"); process.exit(1); }
const c = await CDP({ target: t, port: 9222 });
const r = await c.Runtime.evaluate({ expression: `window.nanobox.eval(${JSON.stringify(process.argv[2])})`, returnByValue: true, awaitPromise: true });
console.log(r.result.value ?? r.result.description ?? JSON.stringify(r));
if (r.exceptionDetails) console.log(r.exceptionDetails.exception?.description);
await c.close();
