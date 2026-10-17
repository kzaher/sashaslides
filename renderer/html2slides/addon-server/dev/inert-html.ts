// PASTED HTML IS MADE INERT BEFORE IT IS CONVERTED. The converter lays a document out in a
// same-origin staging frame (it must: the extractor reads computed styles through the frame), and
// on this page that origin is sashaslides.com, where the deck session cookie and its CSRF token
// live. A pasted document's own scripts would therefore run with the person's session. So every
// executable part is removed first: scripts (except the inert draw.io source, which the converter
// reads as text), inline event handlers, `javascript:` addresses, nested frames, plugins, <base> and
// meta refreshes. Slides are static pictures of a layout, so nothing a slide needs is lost; a
// document drawn by its own script converts as what it shows without it.

import { DRAWIO_SOURCE_SCRIPT_TYPE } from "../../../../mcp/sasha-slides/converter/index.ts";

export type InertHtml = Readonly<{ html: string; removed: number }>;

const REMOVED_ELEMENTS = "iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]";
const ADDRESS_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "data", "srcdoc"] as const;

export function inertSlideHtml(options: Readonly<{ html: string; parser: DOMParser }>): InertHtml {
  const parsed = options.parser.parseFromString(options.html, "text/html");
  let removed = 0;
  for (const script of [...parsed.querySelectorAll("script")]) {
    if ((script.getAttribute("type") ?? "").trim().toLowerCase() === DRAWIO_SOURCE_SCRIPT_TYPE) continue;
    script.remove();
    removed++;
  }
  for (const element of [...parsed.querySelectorAll(REMOVED_ELEMENTS)]) {
    element.remove();
    removed++;
  }
  for (const element of [...parsed.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (!isExecutableAttribute(attribute)) continue;
      element.removeAttribute(attribute.name);
      removed++;
    }
  }
  const doctype = parsed.doctype === null ? "" : "<!doctype html>";
  return { html: `${doctype}${parsed.documentElement.outerHTML}`, removed };
}

function isExecutableAttribute(attribute: Attr): boolean {
  const name = attribute.name.toLowerCase();
  if (name.startsWith("on")) return true;
  if (name === "srcdoc") return true;
  if (!(ADDRESS_ATTRIBUTES as readonly string[]).includes(name)) return false;
  // Browsers ignore control characters and spaces inside the scheme, so strip them before looking.
  const address = attribute.value.replace(/[\u0000- ]/g, "").toLowerCase();
  return address.startsWith("javascript:") || address.startsWith("vbscript:") || address.startsWith("data:text/html");
}
