/**
 * Helpers shared by both interpreters: the legacy engine (engine.ts) and the
 * state-machine scheduler (scheduler.ts), plus the description builder
 * (session.ts). One copy, so the two interpreters cannot drift apart again.
 */
import { StructuredError } from "./errors.js";

/** A JSON-Schema fragment is an untyped object tree keyed by string. */
export type JsonSchemaObject = Record<string, unknown>;

/** typia's schema unit: a root schema plus the components it may $ref into. */
export interface SchemaUnit {
  schema: JsonSchemaObject;
  components?: JsonSchemaObject;
}

/**
 * Typia's `typia.json.schema<T>()` returns a unit with the shape:
 *   { version: "3.1", schema: { $ref: "#/components/schemas/Foo" }, components: {schemas: {...}} }
 * Claude CLI's `--json-schema` flag wants a single self-contained JSON Schema
 * object. This helper inlines a top-level `$ref` against the unit's components
 * so the resulting object is standalone.
 */
export function flattenSchemaUnit(unit: SchemaUnit): JsonSchemaObject {
  const root = unit.schema;
  if (!root || typeof root !== "object") return root ?? {};
  if (typeof root.$ref === "string" && unit.components) {
    const resolved = resolveRef(root.$ref, unit.components);
    if (resolved) return resolved;
  }
  return root;
}

function resolveRef(ref: string, components: JsonSchemaObject): JsonSchemaObject | null {
  // "#/components/schemas/Foo" → components.schemas.Foo
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = { components };
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur != null && typeof cur === "object" ? (cur as JsonSchemaObject) : null;
}

/**
 * A Session API PromptInput<T> is either a string or `(upstream: T) => string`.
 * Evaluate it against the real upstream value at execution time. A throwing
 * prompt function surfaces as a StructuredError on the send node.
 */
export function resolvePrompt(p: unknown, upstream: unknown): string {
  if (typeof p === "function") {
    try {
      const v = (p as (u: unknown) => unknown)(upstream);
      return typeof v === "string" ? v : String(v);
    } catch (e) {
      throw new StructuredError(
        `prompt function threw: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
  return typeof p === "string" ? p : "";
}

/** The value itself when it serializes to JSON, else its string form (for node output). */
export function safeValue(v: unknown): unknown {
  try { JSON.stringify(v); return v; } catch { return String(v); }
}

export function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return "sp_" + Math.random().toString(36).slice(2, 10);
}
