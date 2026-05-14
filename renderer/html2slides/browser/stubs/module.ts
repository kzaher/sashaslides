// Browser stub for Node's `module` builtin. The only thing convert-pptx-lib.ts
// uses from it is `createRequire`, to build a `require` that can pull in
// pptxgenjs. In the browser we route those calls to globals attached by the
// CDN/bundled scripts (`window.PptxGenJS`, `window.JSZip`).
export function createRequire(_path: string): (id: string) => any {
  return (id: string): any => {
    if (id === "pptxgenjs") return (globalThis as any).PptxGenJS;
    if (id === "jszip") return (globalThis as any).JSZip;
    throw new Error(`require("${id}") not available in browser bundle`);
  };
}
