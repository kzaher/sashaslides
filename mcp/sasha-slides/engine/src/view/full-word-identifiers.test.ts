// FULL WORDS IN EVERY NAME WE CHOOSE (SPEC.md 21.9, review fix 7). The milestone 1 review found
// about thirty functions ending in "Css", plus `sameJson`, `withUi` and `state.ui`; this test keeps
// them from coming back. It parses every source file under src/ with the TypeScript compiler and
// looks at the names the engine DECLARES -- functions, variables, parameters, properties, types,
// enum members, binding elements, aliased imports -- and fails on any whose words include one of
// the abbreviations below. A name the engine only USES (`JSON.parse`, `element.innerHTML`,
// `SVGElement`, an un-aliased import of React's `CSSProperties`) is someone else's and passes.
//
// The scanner is tested first, as a table with control rows, so a scanner that silently finds
// nothing cannot pass the real check.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The abbreviations a declared name may not contain as a word (compared without case). */
const FORBIDDEN_WORDS: readonly string[] = ["css", "json", "ui", "svg", "html", "dom"];

/**
 * Names the engine must declare because an outside interface dictates them: React's
 * `dangerouslySetInnerHTML={{ __html: markup }}` reads exactly that key.
 */
const DICTATED_NAMES: ReadonlySet<string> = new Set(["__html"]);

/**
 * Files this module does not own, whose names its owner must still change. The presenter is frozen
 * for milestone 2 (SPEC.md 21.17); the architect clears this entry with the presenter's next
 * change. The test also fails when an entry no longer occurs, so the list can only shrink.
 */
const KNOWN_ELSEWHERE: Readonly<Record<string, readonly string[]>> = {
  "presenter/testing/demo-renderer.tsx": ["cornerRadiusCss", "fillCss", "colourCss"],
};

type Finding = Readonly<{ file: string; line: number; name: string }>;

describe("the identifier scanner", () => {
  const rows: readonly Readonly<{ label: string; source: string; expected: readonly string[] }>[] = [
    { label: "a function ending in Css is found", source: "export function colourCss(): string { return ''; }", expected: ["colourCss"] },
    { label: "a variable named sameJson is found", source: "const sameJson = 1; export { sameJson };", expected: ["sameJson"] },
    { label: "a property ui is found", source: "export type State = { ui: number };", expected: ["ui"] },
    { label: "a parameter html is found", source: "export function parse(html: string): string { return html; }", expected: ["html"] },
    { label: "an all-capitals constant with a Svg word is found", source: "export const SVG_NAMESPACE = 'x';", expected: ["SVG_NAMESPACE"] },
    { label: "an aliased import is a declaration", source: "import { CSSProperties as StyleCss } from 'react'; export type Kept = StyleCss;", expected: ["StyleCss"] },
    { label: "control: JSON.parse is a use, not a declaration", source: "export const value: unknown = JSON.parse('1');", expected: [] },
    { label: "control: innerHTML and SVGElement are uses", source: "export function fill(element: SVGElement): void { element.innerHTML = ''; }", expected: [] },
    { label: "control: an un-aliased import of React's CSSProperties is React's name", source: "import type { CSSProperties } from 'react'; export type Kept = CSSProperties;", expected: [] },
    { label: "control: a word merely containing the letters passes (build, guide, quit, random)", source: "export function buildGuide(quit: boolean, random: number): number { return quit ? random : 0; }", expected: [] },
    { label: "control: React's __html key is dictated", source: "export const markup = { __html: '<b></b>' };", expected: [] },
  ];
  for (const row of rows) {
    it(row.label, () => {
      assert.deepEqual(
        forbiddenDeclarations({ file: "row.tsx", text: row.source }).map((finding) => finding.name),
        row.expected,
      );
    });
  }
});

describe("full-word identifiers in src/", () => {
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const findings = sourceFiles(sourceRoot).flatMap((file) => forbiddenDeclarations({ file: relative(sourceRoot, file), text: readFileSync(file, "utf8") }));

  it("no declared name contains an abbreviation as a word, outside the known list", () => {
    const unexpected = findings.filter((finding) => !(KNOWN_ELSEWHERE[finding.file] ?? []).includes(finding.name));
    assert.deepEqual(unexpected.map((finding) => `${finding.file}:${finding.line} ${finding.name}`), []);
  });

  it("every entry of the known list still occurs (fixed names leave the list)", () => {
    for (const [file, names] of Object.entries(KNOWN_ELSEWHERE)) {
      for (const name of names) assert.ok(findings.some((finding) => finding.file === file && finding.name === name), `${file} no longer declares ${name}: remove it from KNOWN_ELSEWHERE`);
    }
  });
});

/** The declared names in one file whose words include a forbidden abbreviation. */
function forbiddenDeclarations(options: Readonly<{ file: string; text: string }>): readonly Finding[] {
  const kind = options.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(options.file, options.text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    const name = declaredName(node);
    if (name !== null && !DICTATED_NAMES.has(name.text) && nameWords(name.text).some((word) => FORBIDDEN_WORDS.includes(word))) {
      findings.push({ file: options.file, line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1, name: name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** `colourCss` -> colour, css; `SVG_NAMESPACE` -> svg, namespace; `parseHTMLText` -> parse, html, text. */
function nameWords(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** The identifier a node introduces, or null when it introduces none of ours. */
function declaredName(node: ts.Node): ts.Identifier | ts.StringLiteral | null {
  if (ts.isImportSpecifier(node)) return node.propertyName === undefined ? null : node.name;
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isBindingElement(node) ||
    ts.isTypeParameterDeclaration(node)
  ) {
    const name = node.name;
    if (name === undefined) return null;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name : null;
  }
  return null;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [path] : [];
  });
}
