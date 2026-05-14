// Browser stub for Node-only modules pulled in by convert-pptx-lib.ts.
// None of these functions ever execute in the browser bundle: extractFromHtml
// (CDP), getAuth/runConvertPptx (googleapis + fs), and the file-based
// injectGradients/injectStrokeAlignment are never called from main.ts.
// Aliased via esbuild for `fs`, `path`, `stream`, `chrome-remote-interface`,
// `googleapis`, `esbuild`. The exports below cover every name those modules
// destructure-import in convert-pptx-lib.ts.
const NOT_AVAIL = (name: string) => () => { throw new Error(`${name} not available in browser bundle`); };
export const readFileSync = NOT_AVAIL("readFileSync");
export const writeFileSync = NOT_AVAIL("writeFileSync");
export const existsSync = () => false;
export const readdirSync = () => [];
export const join = (...args: string[]) => args.join("/");
export const resolve = (...args: string[]) => args.join("/");
export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");
export const Readable = class { static from() { return null as any; } };
export const google = {
  auth: { OAuth2: class { setCredentials() {} on() {} } },
  drive: () => ({ files: { create: NOT_AVAIL("drive.files.create") } }),
  slides: () => ({ presentations: { get: NOT_AVAIL("slides.presentations.get") } }),
} as any;
export const transformSync = NOT_AVAIL("transformSync");
export default {};
// `chrome-remote-interface` is imported default-style: `import CDP from ...`.
// Re-export default as an empty callable that errors if invoked.
