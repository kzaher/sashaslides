// Browser stub for `pptxgenjs`. The bundled vendor script
// (node_modules/pptxgenjs/dist/pptxgen.bundle.js) is loaded by html2slides.html
// before main.js and attaches the constructor as `window.PptxGenJS`. This stub
// makes `import * as pptxgenModule from "pptxgenjs"` resolve to that global,
// keeping esbuild from bundling the ~460 KB pptxgenjs source twice.
declare const PptxGenJS: any;
export default (globalThis as any).PptxGenJS ?? PptxGenJS;
