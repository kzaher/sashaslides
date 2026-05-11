// tsxx instrumenter — TypeScript AST transform that inserts a
// `__tsxx.tick(file, line, col, preview)` call before every runtime
// statement, then transpiles the result down to ESM JS via TS itself.
//
// The runtime is imported as a relative file:// URL so it's resolved by
// Node's default loader regardless of where the user's source lives.

import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_URL = pathToFileURL(resolve(__dirname, "runtime.mjs")).href;

function isInstrumentable(stmt) {
  return !(
    ts.isImportDeclaration(stmt) ||
    ts.isExportDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt) ||
    ts.isEmptyStatement(stmt)
  );
}

function makeInstrumentingTransformer(filename) {
  return (context) => {
    const factory = context.factory;

    return (sourceFile) => {
      function makeTick(stmt) {
        const start = stmt.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
        const raw = sourceFile.text.slice(start, Math.min(start + 200, stmt.end));
        const preview = raw.replace(/\s+/g, " ").trim().slice(0, 100);
        return factory.createExpressionStatement(
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier("__tsxx"),
              "tick",
            ),
            undefined,
            [
              factory.createStringLiteral(filename),
              factory.createNumericLiteral(line + 1),
              factory.createNumericLiteral(character + 1),
              factory.createStringLiteral(preview),
            ],
          ),
        );
      }

      function instrumentStmts(stmts) {
        const out = [];
        for (const stmt of stmts) {
          if (isInstrumentable(stmt)) out.push(makeTick(stmt));
          out.push(visit(stmt));
        }
        return out;
      }

      function visit(node) {
        if (ts.isBlock(node)) {
          return factory.updateBlock(node, instrumentStmts(node.statements));
        }
        if (ts.isCaseClause(node)) {
          return factory.updateCaseClause(
            node,
            node.expression,
            instrumentStmts(node.statements),
          );
        }
        if (ts.isDefaultClause(node)) {
          return factory.updateDefaultClause(node, instrumentStmts(node.statements));
        }
        if (ts.isModuleBlock(node)) {
          return factory.updateModuleBlock(node, instrumentStmts(node.statements));
        }
        return ts.visitEachChild(node, visit, context);
      }

      const newStatements = instrumentStmts(sourceFile.statements);
      const runtimeImport = factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
          false,
          undefined,
          factory.createNamedImports([
            factory.createImportSpecifier(
              false,
              undefined,
              factory.createIdentifier("__tsxx"),
            ),
          ]),
        ),
        factory.createStringLiteral(RUNTIME_URL),
      );
      return factory.updateSourceFile(sourceFile, [runtimeImport, ...newStatements]);
    };
  };
}

export function instrument(source, filename) {
  const isTsx = filename.endsWith(".tsx");
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      jsx: isTsx ? ts.JsxEmit.Preserve : undefined,
      sourceMap: false,
      inlineSourceMap: true,
      inlineSources: true,
    },
    transformers: {
      before: [makeInstrumentingTransformer(filename)],
    },
  });
  return result.outputText;
}
