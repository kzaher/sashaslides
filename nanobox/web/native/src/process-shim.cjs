// `require('process')` / `require('process/')` inside the bundled polyfills -> the forwarder itself
const { processForwarder } = require("./process-forward.js");
module.exports = processForwarder;
