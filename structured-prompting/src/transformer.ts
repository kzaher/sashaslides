/**
 * Build-time AST transform that lets users write
 *
 *   .send<Measured>({ prompt: "..." })
 *
 * and get a structured-output call — without typing
 * `schema: typia.json.schema<Measured>()` themselves.
 *
 * For every call-expression of the shape
 *     <receiver>.send<T>({ ...props })
 * whose first argument is an object literal NOT already carrying a `schema:`
 * property, the transformer injects
 *     schema: typia.json.schema<T>()
 * at the front of the literal. It also ensures `import typia from "typia";`
 * is present at the top of the file.
 *
 * `@typia/unplugin/esbuild` then sees the injected `typia.json.schema<T>()`
 * call at its own pass and inlines a literal JSON Schema object. By the time
 * the bundle reaches Node, there is no runtime reflection — the schema is
 * static data.
 *
 * The transform is a pure text-level rewrite driven by the TypeScript AST,
 * so it:
 *   - handles template literals inside prompts correctly,
 *   - leaves `.send<T>({ schema: ..., ...})` alone when the user opted out,
 *   - leaves `.send({...})` (no type arg) alone,
 *   - never rewrites node_modules code.
 */

import * as ts from "typescript";

export interface TransformResult {
  code: string;
  changed: boolean;
}

export function injectSchemaIntoSendCalls(source: string, filename: string): TransformResult {
  // Fast path: cheap negative test so we don't invoke the TS parser on files
  // that obviously have no `.send<...>(` pattern.
  if (!/\.send\s*</.test(source)) return { code: source, changed: false };

  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ESNext,
    /*setParentNodes*/ true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const edits: Array<{ start: number; end: number; text: string }> = [];
  let changed = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "send" &&
      node.typeArguments &&
      node.typeArguments.length === 1 &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const typeArg = node.typeArguments[0];
      const typeText = typeArg.getText(sourceFile).trim();
      const objLit = node.arguments[0] as ts.ObjectLiteralExpression;
      const hasSchema = objLit.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name &&
          ts.isIdentifier(p.name) &&
          p.name.text === "schema",
      );
      if (!hasSchema) {
        // Insert just after the opening `{` of the object literal.
        const openBrace = objLit.getStart(sourceFile);
        const insertPos = openBrace + 1;
        const injection = ` schema: typia.json.schema<${typeText}>(),`;
        edits.push({ start: insertPos, end: insertPos, text: injection });
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!changed) return { code: source, changed: false };

  // Apply edits right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const e of edits) {
    result = result.slice(0, e.start) + e.text + result.slice(e.end);
  }

  // Ensure `typia` is imported. Default import is the standard typia entry.
  const hasTypiaImport =
    /^\s*import\s+typia\b/m.test(result) ||
    /^\s*import\s+[^;]*\bfrom\s+['"]typia['"]/m.test(result);
  if (!hasTypiaImport) {
    result = `import typia from "typia";\n` + result;
  }

  return { code: result, changed: true };
}
