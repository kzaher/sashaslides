// GENERATED FILE — do not edit. Compiled from extension/src/offscreen-codec.ts by build-proxy-extension.sh
// (tsc -p extension/tsconfig.json). Change the TypeScript source and rebuild; 'npm run typecheck' is the gate.
// nanobox proxy — base64 framing worker (MIT License, see README.md)
//
// The chrome.runtime port leg is JSON-only, so every response byte is base64-encoded before it can
// cross it. For a 250 MB install that is enough string building to stall the offscreen document's
// event loop, which is also pumping the SSE streams and the tunnelled sockets — so it happens here.
// Messages are answered in arrival order, which is also the order the chunks must reach the page.
//
// It does NOT load wire.js (one `new Worker` + one importScripts for three lines of base64 is not
// a trade worth making), hence the local copy of bytesToBase64.
"use strict";
(function () {
    // `self` is typed as a Window because lib.dom is the only lib @types/chrome compiles against
    // (see ../../tsconfig.json), but this file is loaded with `new Worker`, where the scope is a
    // DedicatedWorkerGlobalScope. Both declare onmessage and postMessage, and those two members are
    // all this file touches — so narrowing to them is sound and it is what gives the payload a type.
    const scope = self;
    scope.onmessage = (event) => {
        scope.postMessage({ ticket: event.data.ticket, b64: bytesToBase64(event.data.bytes) });
    };
    function bytesToBase64(bytes) {
        let binary = "";
        // Spread, not .apply(null, …): under strictBindCallApply `apply` wants String.fromCharCode's
        // declared number[] and a Uint8Array is not one. Same 0x8000-element batches, same result.
        for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return btoa(binary);
    }
})();