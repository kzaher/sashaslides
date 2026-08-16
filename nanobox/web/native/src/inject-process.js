// esbuild `inject`: free `process` identifiers inside the bundled polyfills -> the forwarder
import { processForwarder } from "./process-forward.js";
export { processForwarder as process };
