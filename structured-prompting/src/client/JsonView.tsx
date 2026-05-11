/**
 * Pretty-printed JSON renderer. Long strings get a per-string expand
 * button (`StringReveal`) so a 10 KB stderr blob doesn't blow out the
 * detail panel. Component-local state survives the 250 ms graph poll
 * because Preact reconciles by position + type.
 */
import { useState } from "preact/hooks";

function StringReveal(props: { value: string }) {
  const { value } = props;
  const [shown, setShown] = useState(false);
  const isLong = value.length > 200;
  const preview = isLong
    ? JSON.stringify(value.slice(0, 180) + "…")
    : JSON.stringify(value);
  return (
    <span class="json-str">
      {!shown && <span>{preview}</span>}
      {shown && <pre class="lsfull-body">{value}</pre>}
      <button
        class="revealBtn"
        title={value.length + " chars"}
        onClick={() => setShown(!shown)}
      >{shown ? "hide" : "show"}</button>
    </span>
  );
}

export function JsonView(props: { value: unknown; indent?: number }): preact.JSX.Element {
  const { value } = props;
  const indent = props.indent || 0;
  if (value === null) return <span class="json-null">null</span>;
  if (value === undefined) return <span class="json-null">undefined</span>;
  const t = typeof value;
  if (t === "string") return <StringReveal value={value as string} />;
  if (t === "number" || t === "boolean") return <span class="json-prim">{String(value)}</span>;
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    return (
      <span>
        {"[\n"}
        {value.map((x, i) => (
          <span key={i}>
            {pad}
            <JsonView value={x} indent={indent + 1} />
            {i < value.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {close}
        {"]"}
      </span>
    );
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return <span>{"{}"}</span>;
    return (
      <span>
        {"{\n"}
        {keys.map((k, i) => (
          <span key={k}>
            {pad}
            <span class="json-key">{JSON.stringify(k)}</span>
            {": "}
            <JsonView value={obj[k]} indent={indent + 1} />
            {i < keys.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {close}
        {"}"}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}
