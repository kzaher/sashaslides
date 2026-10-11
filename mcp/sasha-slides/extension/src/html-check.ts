// PROTOCOL.md: "Slide HTML is a full self-contained 1280x720 document (own <head><style>,
// body{width:1280px;height:720px}) -- not a fragment." This checks a candidate against that, so a
// staging mistake shows up as a labelled warning in the picker instead of as a silently wrong
// conversion.
//
// The check is PURE and the DOM reading is isolated behind SlideDocumentParser, which is both why
// it unit-tests with no browser and why the size extraction lives here: a DOMParser document is not
// in a browsing context, so `getComputedStyle` returns nothing and `body.style.width` sees only the
// inline attribute. The declared size therefore has to be read out of the stylesheet text, and that
// is string work, not DOM work.

export const SLIDE_WIDTH_PX = 1280;
export const SLIDE_HEIGHT_PX = 720;

/** Exactly the facts the check needs, so the dependency is small enough to fake in a test. */
export type ParsedSlideDocument = Readonly<{
  title: string;
  hasHead: boolean;
  /** The text of every inline <style>, concatenated. Empty when there is none. */
  styleText: string;
  bodyInlineStyle: string;
  /** Absolute URLs the document pulls in (img/script/link/iframe). Each one breaks self-containment. */
  externalUrls: readonly string[];
}>;

export type SlideDocumentParser = (html: string) => ParsedSlideDocument | null;

export type HtmlCheck = Readonly<{
  title: string | null;
  declaredWidthPx: number | null;
  declaredHeightPx: number | null;
  warnings: readonly string[];
}>;

export function checkSlideHtml({ html, parse }: { html: string; parse: SlideDocumentParser }): HtmlCheck {
  const parsed = parse(html);
  if (parsed === null) {
    return {
      title: null,
      declaredWidthPx: null,
      declaredHeightPx: null,
      warnings: ["the file did not parse as an HTML document"],
    };
  }
  const css = `${bodyRuleText(parsed.styleText)};${parsed.bodyInlineStyle}`;
  const declaredWidthPx = pixelDeclaration({ css, property: "width" });
  const declaredHeightPx = pixelDeclaration({ css, property: "height" });

  const warnings: string[] = [];
  if (!parsed.hasHead) warnings.push("no <head>: this looks like a fragment, not a document");
  if (parsed.styleText === "" && parsed.bodyInlineStyle === "") warnings.push("no inline <style>: styling may be missing");
  if (declaredWidthPx !== SLIDE_WIDTH_PX) {
    warnings.push(`body width is ${describePx(declaredWidthPx)}, expected ${SLIDE_WIDTH_PX}px`);
  }
  if (declaredHeightPx !== SLIDE_HEIGHT_PX) {
    warnings.push(`body height is ${describePx(declaredHeightPx)}, expected ${SLIDE_HEIGHT_PX}px`);
  }
  for (const url of parsed.externalUrls) warnings.push(`not self-contained: pulls in ${url}`);
  return { title: parsed.title === "" ? null : parsed.title, declaredWidthPx, declaredHeightPx, warnings };
}

/** The real reading. Only an extension PAGE has DOMParser, which is why this runs offscreen. */
export function domSlideDocumentParser(): SlideDocumentParser {
  return (html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const body = parsed.body;
    if (body === null) return null;
    const externalUrls: string[] = [];
    for (const element of parsed.querySelectorAll("img[src], script[src], link[href], iframe[src]")) {
      const url = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
      if (/^(https?:)?\/\//.test(url)) externalUrls.push(url);
    }
    return {
      title: parsed.title,
      hasHead: parsed.head !== null && parsed.head.childElementCount > 0,
      styleText: [...parsed.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n"),
      bodyInlineStyle: body.getAttribute("style") ?? "",
      externalUrls,
    };
  };
}

/**
 * The declaration block of every rule whose selector list mentions `body`, concatenated. Not a CSS
 * parser: it exists only to find `width`/`height` on the slide root, and anything it cannot read
 * surfaces as the "expected 1280px" warning rather than as a wrong answer.
 */
function bodyRuleText(styleText: string): string {
  const blocks: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let matched = rule.exec(styleText); matched !== null; matched = rule.exec(styleText)) {
    const selector = matched[1] ?? "";
    const declarations = matched[2] ?? "";
    if (/(^|[\s,>+~])(body|html)([\s,>+~]|$)/.test(selector)) blocks.push(declarations);
  }
  return blocks.join(";");
}

function pixelDeclaration({ css, property }: { css: string; property: string }): number | null {
  const declaration = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "gi");
  let last: number | null = null;
  for (let matched = declaration.exec(css); matched !== null; matched = declaration.exec(css)) {
    const value = Number(matched[1]);
    // Last declaration wins, the same way the cascade resolves two rules of equal specificity.
    if (Number.isFinite(value)) last = value;
  }
  return last;
}

function describePx(value: number | null): string {
  return value === null ? "undeclared" : `${value}px`;
}
