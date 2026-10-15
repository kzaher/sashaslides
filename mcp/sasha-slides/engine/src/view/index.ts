// THE VIEW MODULE'S SURFACE (contracts/module-surfaces.ts `ViewModule`): the renderer the presenter
// receives by injection -- `StaticSlide` and `renderSlideMarkup`, built on the same element
// components so the editor, the slideshow and the transition sandbox draw a slide identically --
// and `EditorApplication`, the whole editor in Tidepool.

import type { ViewModule } from "../contracts/index.ts";
import { EditorApplication as Application } from "./application/editor-application.tsx";
import { renderSlideMarkup as renderMarkup } from "./render/slide-markup.tsx";
import { StaticSlide as Static } from "./render/static-slide.tsx";

export const StaticSlide: ViewModule["StaticSlide"] = Static;
export const renderSlideMarkup: ViewModule["renderSlideMarkup"] = renderMarkup;
export const EditorApplication: ViewModule["EditorApplication"] = Application;
