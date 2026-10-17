// A SMALL STAND-IN RENDERER for the presenter's Chrome checks: the view module owns the real
// `StaticSlide` and `renderSlideMarkup` (render.ts), and the presenter receives them by injection,
// so its own end-to-end pages need something that honours the same rendering contract -- a
// `.sasha-slide-root` of 1280 x pageHeight, leaves absolutely positioned at their unrotated frame and
// turned about their centre, groups as `inset: 0` wrappers, the stable data attributes, and asset
// tokens in markup. It draws solid fills, corner radii and plain text; that is all a transition
// needs to be seen.

import type { CSSProperties, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assertNever } from "../../contracts/assert-never.ts";
import { plainText, type DocumentSnapshot, type ElementSnapshot, type SlideSnapshot } from "../../contracts/document.ts";
import {
  ELEMENT_ID_ATTRIBUTE,
  ELEMENT_KIND_ATTRIBUTE,
  MORPH_KEY_ATTRIBUTE,
  SLIDE_ID_ATTRIBUTE,
  SLIDE_ROOT_CLASS,
  assetAddressToken,
  type AssetAddressResolver,
  type RenderSlideMarkup,
  type StaticSlideComponent,
} from "../../contracts/render.ts";
import type { Colour, CornerRadius, Fill } from "../../contracts/style.ts";
import { stageElementRecordsOf } from "../../shared/stage-elements.ts";

export const DemoStaticSlide: StaticSlideComponent = (properties) => (
  <div style={{ width: properties.document.pageSize.width * properties.scale, height: properties.document.pageSize.height * properties.scale, overflow: "hidden", position: "relative" }}>
    <DemoSlideRoot slide={properties.slide} document={properties.document} slideNumber={properties.slideNumber} assetAddress={properties.assetAddress} scale={properties.scale} />
  </div>
);

export const demoRenderSlideMarkup: RenderSlideMarkup = (input) => ({
  markup: renderToStaticMarkup(<DemoSlideRoot slide={input.slide} document={input.document} slideNumber={input.slideNumber} assetAddress={assetAddressToken} scale={1} />),
  elements: stageElementRecordsOf(input.slide),
  assetIds: [],
  fontFaces: [],
});

function DemoSlideRoot(
  properties: Readonly<{ slide: SlideSnapshot; document: DocumentSnapshot; slideNumber: number; assetAddress: AssetAddressResolver; scale: number }>,
): ReactElement {
  const page = properties.document.pageSize;
  const background = properties.slide.background ?? properties.document.theme.background;
  const attributes = { [SLIDE_ID_ATTRIBUTE]: properties.slide.id };
  return (
    <div
      className={SLIDE_ROOT_CLASS}
      {...attributes}
      style={{
        display: "block",
        position: "relative",
        width: page.width,
        height: page.height,
        overflow: "hidden",
        background: fillCss({ fill: background, document: properties.document }),
        transform: properties.scale === 1 ? "none" : `scale(${properties.scale})`,
        transformOrigin: "0 0",
        fontFamily: "Arial, sans-serif",
      }}
    >
      {properties.slide.elements.map((element) => (
        <DemoElement key={element.id} element={element} document={properties.document} slideNumber={properties.slideNumber} />
      ))}
    </div>
  );
}

function DemoElement(properties: Readonly<{ element: ElementSnapshot; document: DocumentSnapshot; slideNumber: number }>): ReactElement {
  const element = properties.element;
  const attributes = { [ELEMENT_ID_ATTRIBUTE]: element.id, [ELEMENT_KIND_ATTRIBUTE]: element.kind, [MORPH_KEY_ATTRIBUTE]: element.morphKey };
  switch (element.kind) {
    case "group":
      return (
        <div {...attributes} style={{ display: "block", position: "absolute", inset: 0 }}>
          {element.children.map((child) => (
            <DemoElement key={child.id} element={child} document={properties.document} slideNumber={properties.slideNumber} />
          ))}
        </div>
      );
    case "shape": {
      const radius = cornerRadiusCss(element.box.cornerRadius);
      const text = plainText({ body: element.text, slideNumber: properties.slideNumber });
      return (
        <div {...attributes} style={{ ...leafStyle(element), background: fillCss({ fill: element.box.fill, document: properties.document }), borderRadius: radius, opacity: element.box.opacity }}>
          <span style={{ fontSize: 44, fontWeight: 700, color: "#1c2333", whiteSpace: "pre-wrap", textAlign: "center", padding: 12 }}>{text}</span>
        </div>
      );
    }
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return <div {...attributes} style={{ ...leafStyle(element), outline: "2px dashed #9aa3b5" }} />;
    default:
      return assertNever(element);
  }
}

function cornerRadiusCss(cornerRadius: CornerRadius): string {
  switch (cornerRadius.kind) {
    case "uniform":
      return `${cornerRadius.radius}px`;
    case "perCorner":
      return `${cornerRadius.topLeft}px ${cornerRadius.topRight}px ${cornerRadius.bottomRight}px ${cornerRadius.bottomLeft}px`;
    default:
      return assertNever(cornerRadius);
  }
}

function leafStyle(element: ElementSnapshot): CSSProperties {
  const frame = element.frame;
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
    transform: `rotate(${frame.rotation}deg) scale(${frame.flipHorizontal ? -1 : 1}, ${frame.flipVertical ? -1 : 1})`,
  };
}

function fillCss(options: Readonly<{ fill: Fill; document: DocumentSnapshot }>): string {
  const fill = options.fill;
  switch (fill.kind) {
    case "none":
      return "transparent";
    case "solid":
      return colourCss({ colour: fill.colour, document: options.document });
    case "linearGradient":
      return `linear-gradient(${fill.angle}deg, ${fill.stops.map((stop) => `${colourCss({ colour: stop.colour, document: options.document })} ${stop.offset * 100}%`).join(", ")})`;
    case "radialGradient":
      return `radial-gradient(circle at ${fill.centreX * 100}% ${fill.centreY * 100}%, ${fill.stops.map((stop) => `${colourCss({ colour: stop.colour, document: options.document })} ${stop.offset * 100}%`).join(", ")})`;
    case "image":
      return "transparent";
    default:
      return assertNever(fill);
  }
}

function colourCss(options: Readonly<{ colour: Colour; document: DocumentSnapshot }>): string {
  const colour = options.colour;
  switch (colour.kind) {
    case "literal":
      return hexadecimalWithAlpha({ hexadecimal: colour.hexadecimal, alpha: colour.alpha });
    case "theme":
      return hexadecimalWithAlpha({ hexadecimal: options.document.theme.colours[colour.slot], alpha: colour.alpha });
    default:
      return assertNever(colour);
  }
}

function hexadecimalWithAlpha(options: Readonly<{ hexadecimal: string; alpha: number }>): string {
  const alpha = Math.round(Math.min(1, Math.max(0, options.alpha)) * 255).toString(16).padStart(2, "0");
  return `${options.hexadecimal}${alpha}`;
}
