/**
 * attribute-policy.ts — what happens to one attribute, decided by DEFAULT-DENY.
 *
 * This is the file that decides whether the anonymiser is trustworthy, and the rule it implements
 * is the opposite of the obvious one. An anonymiser written as "substitute `alt`, `title`,
 * `aria-label` and `data-*`" is wrong the first time someone puts content in an attribute nobody
 * listed — and people do: `summary`, `abbr`, `download`, `placeholder`, `value`, a `<meta>`
 * description, a framework's `x-tooltip`. So the question asked here is inverted: an attribute is
 * only preserved if it is on an explicit list of attributes that carry GEOMETRY, STYLING OR
 * STRUCTURE. Anything else is substituted, including attributes this file has never heard of, and
 * `known: false` records that it had never heard of it so the preview can say so.
 *
 * The cost of default-deny is that an unlisted presentational attribute gets mangled, which shows
 * up as a geometry difference in the fidelity test rather than as a leak. That is the right way
 * round for this failure: a visible wrong picture, never a silent disclosure.
 */
import type { HtmlAttribute } from "./html-tokens.ts";

export type AttributeAction =
  /** Geometry, styling or structure: emitted byte for byte. */
  | "preserve"
  /** Human-readable content: replaced with same-shaped substitute text. */
  | "substitute-text"
  /** A URL: the scheme survives, nothing after it does. */
  | "substitute-url"
  /** `style="..."`: handed to the CSS transform, not to the text substituter. */
  | "inline-style"
  /**
   * One CSS value, in an attribute: an SVG `fill="url(#grad)"`. Preserved by the CSS transform,
   * which is what keeps the `#grad` reference pointing at the same node after a rename.
   */
  | "css-value"
  /** An image source: discarded and replaced by a generated placeholder of the same size. */
  | "image-source"
  /** Removed from the tag entirely — script, external document and subresource integrity hooks. */
  | "drop"
  /** `class`: a whitespace-separated list of names in the class namespace. */
  | "class-names"
  /** `id`: one name in the id namespace. */
  | "element-id"
  /** `for`, `headers`, `aria-labelledby`: a whitespace-separated list of ids. */
  | "id-references"
  /** `usemap`, an SVG `href`: a `#name` reference to an id. */
  | "id-fragment";

export type AttributePolicy = Readonly<{
  action: AttributeAction;
  /**
   * False when the name is not on any list here, so the attribute is being substituted by the
   * default-deny rule rather than by a decision. Surfaced in the preview.
   */
  known: boolean;
}>;

export function attributePolicyFor({
  tagName,
  attributeName,
  tagAttributes,
  insideSvg,
}: {
  tagName: string;
  attributeName: string;
  tagAttributes: readonly HtmlAttribute[];
  /**
   * True inside an `<svg>` subtree. It narrows the preserve list: `in`, `result`, `values`, `mode`
   * and `orient` are stylesheet inside SVG and could be anything on an unknown HTML element, so
   * they are only trusted where the SVG renderer is the one reading them.
   */
  insideSvg: boolean;
}): AttributePolicy {
  const name = attributeName.toLowerCase();
  const tag = tagName.toLowerCase();

  if (name === "") return { action: "preserve", known: true };
  if (name.startsWith("on")) return { action: "drop", known: true };
  if (name.startsWith("data-")) return { action: "substitute-text", known: true };
  if (name.startsWith("aria-")) return { action: ariaAction(name), known: ARIA_KNOWN.has(name) };

  const fixed = FIXED_ACTIONS[name];
  if (fixed !== undefined) return { action: fixed, known: true };

  const perTag = perTagAction({ tag, name, tagAttributes });
  if (perTag !== null) return { action: perTag, known: true };

  if (PRESERVED_HTML.has(name)) return { action: "preserve", known: true };
  if (insideSvg && SVG_CSS_VALUES.has(name)) return { action: "css-value", known: true };
  if (insideSvg && PRESERVED_SVG.has(name)) return { action: "preserve", known: true };
  if (KNOWN_TEXT_ATTRIBUTES.has(name)) return { action: "substitute-text", known: true };
  return { action: "substitute-text", known: false };
}

/** Names whose treatment never depends on the element they sit on. */
const FIXED_ACTIONS: Readonly<Record<string, AttributeAction>> = {
  class: "class-names",
  id: "element-id",
  style: "inline-style",
  srcset: "image-source",
  poster: "image-source",
  background: "image-source",
  longdesc: "substitute-url",
  cite: "substitute-url",
  action: "substitute-url",
  formaction: "substitute-url",
  ping: "drop",
  srcdoc: "drop",
  integrity: "drop",
  nonce: "drop",
  manifest: "drop",
  for: "id-references",
  headers: "id-references",
  itemref: "id-references",
  usemap: "id-fragment",
  popovertarget: "element-id",
  form: "element-id",
  list: "element-id",
};

/**
 * The cases where the element changes the answer.
 *
 * `src` is the clearest one: on an `<img>` it is a picture to replace, on an `<iframe>` or a
 * `<script>` it is a document to remove. `href` is the other: on an `<a>` it is a link to
 * substitute, on a `<base>` it silently changes how every other URL in the document resolves, and
 * on an SVG `<use>` it is an internal reference that must keep pointing at the same node.
 */
function perTagAction({
  tag,
  name,
  tagAttributes,
}: {
  tag: string;
  name: string;
  tagAttributes: readonly HtmlAttribute[];
}): AttributeAction | null {
  if (name === "src") {
    if (tag === "img" || tag === "source" || tag === "input" || tag === "image") return "image-source";
    return "drop";
  }
  if (name === "href" || name === "xlink:href") {
    if (tag === "base") return "drop";
    if (tag === "image" || tag === "feimage") return "image-source";
    if (tag === "use" || tag === "textpath" || tag === "mpath" || tag === "lineargradient" || tag === "radialgradient") {
      return "id-fragment";
    }
    return "substitute-url";
  }
  if (name === "data") return tag === "object" ? "drop" : null;
  if (name === "name") {
    // On a `<map>` it is the target of `usemap="#..."`; on a `<meta>` or a control it is a label.
    if (tag === "map") return "element-id";
    return null;
  }
  if (name === "content" && tag === "meta") return metaContentAction(tagAttributes);
  return null;
}

/**
 * A `<meta>` `content` is usually prose (`description`, `author`, `generator`) and is substituted,
 * but a handful of names are rendering instructions the browser acts on. Substituting `viewport`
 * would change how the document lays out, which is the one thing this module must not do.
 */
function metaContentAction(tagAttributes: readonly HtmlAttribute[]): AttributeAction {
  const valueOf = (wanted: string): string =>
    (tagAttributes.find((attribute) => attribute.name.toLowerCase() === wanted)?.value ?? "").toLowerCase();
  if (valueOf("http-equiv") !== "") return "preserve";
  return RENDERING_META_NAMES.has(valueOf("name")) ? "preserve" : "substitute-text";
}

const RENDERING_META_NAMES: ReadonlySet<string> = new Set([
  "viewport",
  "color-scheme",
  "theme-color",
  "referrer",
  "robots",
  "format-detection",
  "supported-color-schemes",
]);

function ariaAction(name: string): AttributeAction {
  if (ARIA_ID_REFERENCES.has(name)) return "id-references";
  return ARIA_RENDERING.has(name) ? "preserve" : "substitute-text";
}

const ARIA_ID_REFERENCES: ReadonlySet<string> = new Set([
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
]);

/** ARIA attributes whose values are enumerations, booleans or numbers — never prose. */
const ARIA_RENDERING: ReadonlySet<string> = new Set([
  "aria-atomic", "aria-autocomplete", "aria-busy", "aria-checked", "aria-colcount", "aria-colindex",
  "aria-colspan", "aria-current", "aria-disabled", "aria-dropeffect", "aria-expanded", "aria-grabbed",
  "aria-haspopup", "aria-hidden", "aria-invalid", "aria-level", "aria-live", "aria-modal",
  "aria-multiline", "aria-multiselectable", "aria-orientation", "aria-posinset", "aria-pressed",
  "aria-readonly", "aria-relevant", "aria-required", "aria-rowcount", "aria-rowindex", "aria-rowspan",
  "aria-selected", "aria-setsize", "aria-sort", "aria-valuemax", "aria-valuemin", "aria-valuenow",
]);

const ARIA_KNOWN: ReadonlySet<string> = new Set([
  ...ARIA_ID_REFERENCES,
  ...ARIA_RENDERING,
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "aria-keyshortcuts",
]);

/**
 * SVG presentation attributes whose value can be a `url(#...)` reference to another node in the
 * same document. They go through the CSS transform rather than being copied, so that a renamed id
 * is renamed here too and the gradient, clip path or filter still resolves.
 */
const SVG_CSS_VALUES: ReadonlySet<string> = new Set([
  "fill", "stroke", "clip-path", "mask", "filter", "marker", "marker-start", "marker-mid",
  "marker-end", "cursor",
]);

/**
 * Attributes this file KNOWS carry human-readable content. They are substituted exactly like an
 * unlisted attribute would be — the list exists only so `known` can tell the preview the
 * difference between "handled" and "handled because nothing recognised it".
 */
const KNOWN_TEXT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "abbr", "accesskey", "alt", "content", "download", "label", "name", "pattern", "placeholder",
  "srclang", "summary", "title", "value", "itemid", "itemprop", "itemtype", "prompt",
]);

/**
 * Geometry, styling and structure, for HTML elements. Nothing on this list may carry prose, and
 * that is the only question asked when adding to it.
 */
const PRESERVED_HTML: ReadonlySet<string> = new Set([
  "accept", "accept-charset", "align", "allowfullscreen", "async", "autocapitalize", "autocomplete",
  "autocorrect", "autofocus", "autoplay", "bgcolor", "blocking", "border", "capture", "cellpadding",
  "cellspacing", "charset", "checked", "clear", "color", "cols", "colspan", "compact", "controls",
  "coords", "crossorigin", "decoding", "defer", "dir", "dirname", "disabled",
  "disablepictureinpicture", "disableremoteplayback", "draggable", "enctype", "enterkeyhint",
  "face", "fetchpriority", "frameborder", "height", "hidden", "high", "hreflang", "hspace",
  "http-equiv", "inert", "inputmode", "is", "ismap", "itemscope", "lang", "loading", "loop", "low",
  "max", "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "nomodule",
  "novalidate", "nowrap", "open", "optimum", "part", "playsinline", "popover", "preload", "readonly",
  "referrerpolicy", "rel", "required", "reversed", "role", "rows", "rowspan", "rules", "sandbox",
  "scope", "scrolling", "selected", "shadowrootmode", "shape", "size", "sizes", "slot", "span",
  "spellcheck", "start", "step", "tabindex", "target", "translate", "type", "valign", "vspace",
  "width", "wrap", "writingsuggestions",
]);

/**
 * The SVG presentation and geometry attributes, trusted only inside an `<svg>` subtree. An inline
 * `<svg>` reaches the same renderer the CSS does, so these are stylesheet rather than content — but
 * several of them (`in`, `result`, `values`, `mode`, `side`) are ordinary English words that an
 * unknown HTML element could perfectly well use to carry prose, which is why the gate exists.
 */
const PRESERVED_SVG: ReadonlySet<string> = new Set([
  // document and geometry
  "xmlns", "xmlns:xlink", "xml:space", "xml:lang", "version", "baseprofile", "viewbox",
  "preserveaspectratio", "zoomandpan", "focusable", "requiredextensions", "requiredfeatures",
  "systemlanguage", "externalresourcesrequired", "d", "pathlength", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "fx", "fy", "fr", "r", "rx", "ry", "dx", "dy", "points", "rotate", "transform",
  "transform-origin", "gradienttransform", "patterntransform", "textlength", "lengthadjust",
  "startoffset", "spacing", "side", "markerwidth", "markerheight", "markerunits", "refx", "refy",
  "orient", "offset", "gradientunits", "spreadmethod", "patternunits", "patterncontentunits",
  "maskunits", "maskcontentunits", "clippathunits", "filterunits", "primitiveunits", "overflow",
  // paint and text presentation
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity",
  "stop-color", "stop-opacity", "display", "visibility", "clip", "clip-path", "clip-rule", "mask",
  "filter", "marker", "marker-start", "marker-mid", "marker-end", "paint-order", "vector-effect",
  "shape-rendering", "text-rendering", "image-rendering", "color-rendering", "color-interpolation",
  "color-interpolation-filters", "isolation", "mix-blend-mode", "pointer-events", "cursor", "font",
  "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant",
  "font-weight", "letter-spacing", "word-spacing", "text-anchor", "text-decoration",
  "text-overflow", "white-space", "dominant-baseline", "alignment-baseline", "baseline-shift",
  "direction", "unicode-bidi", "writing-mode", "glyph-orientation-horizontal",
  "glyph-orientation-vertical", "kerning", "enable-background",
  // filter primitives: numeric or enumerated
  "in", "in2", "result", "mode", "operator", "k1", "k2", "k3", "k4", "stddeviation", "tablevalues",
  "slope", "intercept", "amplitude", "exponent", "scale", "xchannelselector", "ychannelselector",
  "basefrequency", "numoctaves", "seed", "stitchtiles", "surfacescale", "specularconstant",
  "specularexponent", "diffuseconstant", "azimuth", "elevation", "pointsatx", "pointsaty",
  "pointsatz", "limitingconeangle", "kernelmatrix", "kernelunitlength", "order", "divisor", "bias",
  "targetx", "targety", "edgemode", "preservealpha", "values",
]);
