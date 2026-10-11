// Content-addressed store (CAS) planner for nanobox JIT bundles — FEASIBILITY PROTOTYPE, off by
// default. Nothing in the build, the server or the sandbox page calls this; it is driven only by
// test/jit-cas-unit.mjs and by hand. See docs/engine.md on bundles and web/jit-bundle.js for the
// .nbjb format this reasons about.
//
// WHY. Today web/sandbox.html:325-334 asks for bundles by NAME ("kernel.nbjb", image + ".nbjb",
// cli + "-slim.nbjb", ...) and drops whatever is missing, so a CLI nobody has recorded a bundle for
// gets nothing from the curated list. But an individual translation is already addressed by the
// engine's own 64-bit CONTENT key (a hash of the decoded instruction stream — nanobox_jit.cc's
// nanobox_jit_hash), and a module is position independent within one engine build. So the name is
// the only thing that is workload-specific: the CONTENTS are shareable across workloads that embed
// the same libc / libstdc++ / JavaScriptCore / kernel pages.
//
// This module quantifies that: given the per-bundle key sets, how much of a new workload would a
// merged store already answer, and how much smaller is the merged store than the sum of its parts.
// It is deliberately PURE — no file or network I/O, no engine, no wasm — so it is cheap to check
// and to test. The caller (a test/*.mjs harness) decodes the .nbjb files and hands the summaries in.
const distinctKeys = (b) => {
    const s = new Set();
    for (const m of b.modules)
        for (const k of m.keys)
            s.add(k);
    return s;
};
function overlapsOf(bundles) {
    const sets = bundles.map((b) => ({ name: b.name, keys: distinctKeys(b) }));
    const out = [];
    for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
            const x = sets[i], y = sets[j];
            if (!x || !y)
                continue;
            const small = x.keys.size <= y.keys.size ? x.keys : y.keys;
            const large = x.keys.size <= y.keys.size ? y.keys : x.keys;
            let shared = 0;
            for (const k of small)
                if (large.has(k))
                    shared++;
            out.push({ a: x.name, b: y.name, shared, fractionOfSmaller: small.size === 0 ? 0 : shared / small.size });
        }
    }
    return out;
}
function groupFor(tag, bundles) {
    const served = new Set();
    let uniqueKeys = 0, summedKeys = 0, uniqueBytes = 0, summedBytes = 0;
    let redundantModules = 0, redundantBytes = 0;
    for (const b of bundles) {
        summedKeys += distinctKeys(b).size;
        for (const m of b.modules) {
            summedBytes += m.byteLength;
            // A module earns its place only if it brings at least one key the store cannot answer yet.
            const fresh = m.keys.filter((k) => !served.has(k));
            if (fresh.length === 0 && m.keys.length > 0) {
                redundantModules++;
                redundantBytes += m.byteLength;
                continue;
            }
            uniqueBytes += m.byteLength;
            uniqueKeys += fresh.length;
            for (const k of fresh)
                served.add(k);
        }
    }
    return {
        tag,
        bundles: bundles.map((b) => b.name),
        uniqueKeys,
        summedKeys,
        keyDedupeFraction: summedKeys === 0 ? 0 : 1 - uniqueKeys / summedKeys,
        uniqueBytes,
        summedBytes,
        redundantModules,
        redundantBytes,
        overlaps: overlapsOf(bundles),
    };
}
/** Group by engine tag (the only interchangeability boundary) and cost out a merged store per tag. */
export function planCas(bundles) {
    const byTag = new Map();
    for (const b of bundles) {
        const list = byTag.get(b.tag);
        if (list)
            list.push(b);
        else
            byTag.set(b.tag, [b]);
    }
    const groups = [];
    for (const [tag, list] of byTag)
        groups.push(groupFor(tag, list));
    return { groups, tagSplit: byTag.size > 1 };
}
/**
 * How much of `candidate` a store built from `have` could already answer — the number that decides
 * whether a never-recorded workload (e.g. ?cli=claude-bin) is worth serving from a shared store
 * instead of the curated name list.
 */
export function coverageOf(candidate, have) {
    const served = new Set();
    for (const b of have) {
        if (b.tag !== candidate.tag)
            continue; // a foreign tag is dropped by the host, so it cannot help
        for (const k of distinctKeys(b))
            served.add(k);
    }
    const want = distinctKeys(candidate);
    let hits = 0;
    for (const k of want)
        if (served.has(k))
            hits++;
    return { hits, total: want.size, fraction: want.size === 0 ? 0 : hits / want.size };
}
