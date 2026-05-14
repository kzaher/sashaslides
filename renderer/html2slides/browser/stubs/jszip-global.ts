// Browser stub for `jszip`. The bundled vendor script
// (node_modules/jszip/dist/jszip.min.js) is loaded by html2slides.html before
// main.js and attaches `window.JSZip`. This stub makes
// `import JSZip from "jszip"` resolve to that global, keeping esbuild from
// bundling the ~97 KB jszip source twice.
declare const JSZip: any;
export default (globalThis as any).JSZip ?? JSZip;
