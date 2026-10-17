// EACH SURFACE SHIPS THE RULES ITS CODE CAN USE -- ALL OF THEM, AND NO OTHERS.
//
// Until 2026-10-17 one stylesheet shipped on all three pages, and measured against what each bundle
// can match it carried 8 KB of dead rules on Dialog.html, 15 KB on Report.html and 14 KB on
// Sidebar.html. It is now one sheet per surface on a shared base (surface-stylesheets.ts), and this
// file is what keeps the split honest in both directions:
//
//   * COVERED: every rule in any of the split sheets that a class in a surface's bundle can match
//     is in that surface's sheets. A component moved to another surface without its rules fails.
//   * NOTHING DEAD: every rule in a surface's split sheets can be matched by its bundle. A rule only
//     one surface uses belongs in that surface's sheet, not in the base.
//   * SHIPPED: the bundle carries exactly the sheets its list names, so an import that drags another
//     surface's sheet in fails too.
//
// WHAT "CAN MATCH" MEANS. Each surface is bundled exactly as build-addon.ts bundles it, but every
// stylesheet module is replaced by a marker string, so the only `sasha-*` names left in the bundle
// are the ones its code uses: JSX classNames, query selectors, built names. A name built at runtime
// (`sasha-el-${kind}`, `"sasha-c-" + tone`) counts as a PREFIX that covers every class it starts.
// A rule can match when every class in one of its selectors is used. Classless rules (`*`,
// `@keyframes`) always can.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build, transformSync, type Plugin } from "esbuild";
import { BASE_CSS } from "./base-styles.ts";
import { DIALOG_CSS } from "./dialog-styles.ts";
import { REPORT_CSS } from "./report-styles.ts";
import { SIDEBAR_CSS } from "./sidebar-styles.ts";
import { DIALOG_STYLESHEETS, REPORT_STYLESHEETS, SIDEBAR_STYLESHEETS } from "./surface-stylesheets.ts";
import { WINDOW_CSS } from "./window-styles.ts";

const HERE = import.meta.dirname;
const STYLESHEET_MODULE = /[\\/]src[\\/][a-z-]+-styles\.ts$/;

/** The split sheets, by the marker each becomes in a bundle. */
const SPLIT_SHEETS: Readonly<Record<string, string>> = {
  BASE_CSS,
  WINDOW_CSS,
  DIALOG_CSS,
  REPORT_CSS,
  SIDEBAR_CSS,
};

type Surface = Readonly<{ entry: string; stylesheets: readonly string[] }>;
const SURFACES: Readonly<Record<string, Surface>> = {
  "Dialog.html": { entry: "dialog.tsx", stylesheets: DIALOG_STYLESHEETS },
  "Report.html": { entry: "report.tsx", stylesheets: REPORT_STYLESHEETS },
  "Sidebar.html": { entry: "sidebar.tsx", stylesheets: SIDEBAR_STYLESHEETS },
};

/** One rule, as the minifier prints it, with the at-rules it sits in. */
type Rule = Readonly<{ key: string; selectors: string }>;

/** The rules of a stylesheet, one per selector block; `@media` blocks are opened. */
function rulesOf(css: string): readonly Rule[] {
  const minified = transformSync(css, { loader: "css", minify: true }).code;
  const rules: Rule[] = [];
  const walk = ({ text, context }: Readonly<{ text: string; context: string }>): void => {
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf("{", at);
      const semicolon = text.indexOf(";", at);
      if (text.startsWith("@", at) && semicolon !== -1 && (open === -1 || semicolon < open)) {
        rules.push({ key: context + text.slice(at, semicolon + 1), selectors: "" }); // @import
        at = semicolon + 1;
        continue;
      }
      if (open === -1) return;
      const close = closingBrace({ text, open });
      const head = text.slice(at, open).trim();
      if (head.startsWith("@media") || head.startsWith("@supports")) {
        walk({ text: text.slice(open + 1, close), context: `${context}${head}{` });
      } else {
        rules.push({ key: context + text.slice(at, close + 1), selectors: head.startsWith("@") ? "" : head });
      }
      at = close + 1;
    }
  };
  walk({ text: minified, context: "" });
  return rules;
}

function closingBrace({ text, open }: Readonly<{ text: string; open: number }>): number {
  let depth = 0;
  let quote = "";
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      return at;
    }
  }
  throw new Error(`unbalanced braces after ${text.slice(open - 40, open)}`);
}

/** The `sasha-*` names a bundle uses, and the prefixes it builds names from at runtime. */
type ClassUse = Readonly<{ names: ReadonlySet<string>; prefixes: readonly string[] }>;

function classUseOf(bundle: string): ClassUse {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const match of bundle.matchAll(/sasha-[a-z0-9-]*/g)) {
    const name = match[0];
    const next = bundle.slice(match.index + name.length, match.index + name.length + 2);
    if (name.endsWith("-") || next === "${" || /^["'`]\+/.test(next)) prefixes.add(name);
    names.add(name);
  }
  return { names, prefixes: [...prefixes] };
}

function canMatch({ rule, use }: Readonly<{ rule: Rule; use: ClassUse }>): boolean {
  if (rule.selectors === "") return true;
  return rule.selectors.split(",").some((selector) =>
    [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].every(([, name = ""]) =>
      use.names.has(name) || use.prefixes.some((prefix) => name.startsWith(prefix)),
    ),
  );
}

/** Every stylesheet module becomes `export const X_CSS = "@sheet:X_CSS@"`, so no CSS is in the bundle. */
const SHEETS_AS_MARKERS: Plugin = {
  name: "sheets-as-markers",
  setup(builder) {
    builder.onLoad({ filter: STYLESHEET_MODULE }, async ({ path }) => {
      // Imported here and not at the top: which module is only known once esbuild asks for it.
      const sheet: Readonly<Record<string, unknown>> = await import(pathToFileURL(path).href);
      const exports = Object.keys(sheet).map((name) => `export const ${name} = ${JSON.stringify(`@sheet:${name}@`)};`);
      return { contents: exports.join("\n"), loader: "ts" };
    });
  },
};

async function bundleOf(entry: string): Promise<string> {
  const bundled = await build({
    entryPoints: [join(HERE, entry)],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    minify: true,
    legalComments: "none",
    logLevel: "error",
    define: {
      "process.env.NODE_ENV": '"production"',
      __SASHA_EXTRACTOR_JS_B64__: '""',
      __SASHA_REPO_ROOT__: '""',
      __SASHA_CONNECTOR_URL__: "null",
    },
    plugins: [SHEETS_AS_MARKERS],
  });
  const text = bundled.outputFiles[0]?.text;
  if (text === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  return text;
}

const ALL_SPLIT_RULES = Object.values(SPLIT_SHEETS).flatMap(rulesOf);
const SPLIT_SHEET_TEXTS = new Set(Object.values(SPLIT_SHEETS));

for (const [page, surface] of Object.entries(SURFACES)) {
  test(`${page} ships every rule its code can match, nothing it cannot, and no other surface's sheet`, async () => {
    const bundle = await bundleOf(surface.entry);
    const use = classUseOf(bundle);

    const named = Object.entries(SPLIT_SHEETS)
      .filter(([, css]) => surface.stylesheets.includes(css))
      .map(([name]) => name);
    const carried = Object.keys(SPLIT_SHEETS).filter((name) => bundle.includes(`@sheet:${name}@`));
    assert.deepEqual(carried, named, `${page} carries other sheets than surface-stylesheets.ts lists for it`);

    const shipped = surface.stylesheets.filter((css) => SPLIT_SHEET_TEXTS.has(css)).flatMap(rulesOf);
    const shippedKeys = new Set(shipped.map((rule) => rule.key));
    const missing = ALL_SPLIT_RULES.filter((rule) => canMatch({ rule, use }) && !shippedKeys.has(rule.key));
    assert.deepEqual(
      missing.map((rule) => rule.key),
      [],
      `${page} uses these classes but not the sheet with their rules`,
    );
    const dead = shipped.filter((rule) => !canMatch({ rule, use }));
    assert.deepEqual(
      dead.map((rule) => rule.key),
      [],
      `${page} ships rules nothing in it can match -- move each to the sheet of the surface that uses it`,
    );
  });
}

test("the class-use reader sees literal names and the prefixes of built ones", () => {
  const use = classUseOf('a="sasha-tab";b=`sasha-el-${k}`;c="sasha-c-"+t;d="sasha-pin"+x');
  assert.ok(use.names.has("sasha-tab"));
  assert.deepEqual([...use.prefixes].sort(), ["sasha-c-", "sasha-el-", "sasha-pin"]);
  assert.ok(canMatch({ rule: { key: "", selectors: ".sasha-el-table" }, use }));
  assert.ok(canMatch({ rule: { key: "", selectors: ".sasha-nope,.sasha-tab:hover" }, use }));
  assert.ok(!canMatch({ rule: { key: "", selectors: ".sasha-tab .sasha-nope" }, use }));
});

test("the rule reader opens @media blocks and keeps @keyframes whole", () => {
  const rules = rulesOf("@media (max-width: 9px) { .a { color: red } .b { color: blue } } @keyframes k { to { opacity: 0 } } .c { content: '}' }");
  assert.deepEqual(
    rules.map((rule) => rule.selectors),
    [".a", ".b", "", ".c"],
  );
});
