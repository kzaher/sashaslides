/** @jsxImportSource react */
/**
 * React port of the dependency-free markdown renderer. Same subset as the
 * preact one (fenced code, headings, bold/italic/inline-code, links, lists,
 * paragraphs), but built with React nodes and React style OBJECTS (React
 * rejects the string `style` attribute preact tolerates).
 *
 * Security: never uses dangerouslySetInnerHTML — every node is a real React
 * element, so raw HTML in model output renders as literal text.
 */
import type { ReactNode } from "react";

const codeInlineStyle: React.CSSProperties = {
  background: "#161b22", border: "1px solid #30363d", borderRadius: 3,
  padding: "1px 4px", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
  fontSize: 12, color: "#a5d6ff",
};
const linkStyle: React.CSSProperties = { color: "#58a6ff" };

/** Inline pass: **bold**, *italic* / _italic_, `code`, [text](url), autolinks. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s)]+)/;
  let guard = 0;
  let key = 0;
  while (rest.length > 0 && guard++ < 10000) {
    const m = re.exec(rest);
    if (!m || m.index === undefined) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (m[1]) {
      out.push(<code key={key++} style={codeInlineStyle}>{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (m[3]) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (m[4]) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (lm) out.push(<a key={key++} href={lm[2]} target="_blank" rel="noreferrer" style={linkStyle}>{lm[1]}</a>);
      else out.push(tok);
    } else if (m[5]) {
      out.push(<a key={key++} href={tok} target="_blank" rel="noreferrer" style={linkStyle}>{tok}</a>);
    } else {
      out.push(tok);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const codeBlockStyle: React.CSSProperties = {
  background: "#0d1117", border: "1px solid #30363d", borderRadius: 6,
  padding: "10px 12px", margin: "8px 0", overflow: "auto", fontSize: 12,
  lineHeight: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#c9d1d9", whiteSpace: "pre",
};

/** Block pass: split on fenced code first, then headings / lists / paragraphs. */
export function Markdown({ src }: { src: string }): React.ReactElement {
  const blocks: ReactNode[] = [];
  let key = 0;
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    const isCode = i % 2 === 1;
    if (isCode) {
      const nl = part.indexOf("\n");
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      blocks.push(<pre key={key++} style={codeBlockStyle}>{body.replace(/\n$/, "")}</pre>);
      return;
    }
    const lines = part.split("\n");
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushPara = () => {
      if (para.length) {
        blocks.push(<p key={key++} style={{ margin: "6px 0", lineHeight: 1.55 }}>{renderInline(para.join(" "))}</p>);
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        const items = list.items;
        const listStyle: React.CSSProperties = { margin: "6px 0", paddingLeft: 22, lineHeight: 1.55 };
        blocks.push(
          list.ordered
            ? <ol key={key++} style={listStyle}>{items.map((it, j) => <li key={j} style={{ margin: "2px 0" }}>{renderInline(it)}</li>)}</ol>
            : <ul key={key++} style={listStyle}>{items.map((it, j) => <li key={j} style={{ margin: "2px 0" }}>{renderInline(it)}</li>)}</ul>,
        );
        list = null;
      }
    };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const level = h[1].length;
        const sz = [20, 18, 16, 15, 14, 13][level - 1];
        blocks.push(<div key={key++} style={{ fontWeight: 600, fontSize: sz, margin: "12px 0 4px", color: "#e6edf3" }}>{renderInline(h[2])}</div>);
      } else if (ul) {
        flushPara();
        if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
        list.items.push(ul[1]);
      } else if (ol) {
        flushPara();
        if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
        list.items.push(ol[1]);
      } else if (line.trim() === "") {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
  });
  return <div>{blocks}</div>;
}
