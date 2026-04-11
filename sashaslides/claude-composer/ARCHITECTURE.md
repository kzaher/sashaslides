# Claude Composer — Architecture

## Overview

Claude Composer is a TypeScript pipeline that directly edits Google Slides presentations by matching markdown content to template slides and generating Slides API batch updates.

## Pipeline Flow

```
Markdown Input
    │
    ▼
┌──────────────────┐
│  Markdown Parser  │  parseMarkdown() → ParsedSlide[]
│  markdown-parser  │  Splits markdown by headings, extracts title/body/notes/images
└────────┬─────────┘  Infers layout hints (title_only, title_and_body, etc.)
         │
         ▼
┌──────────────────┐
│ Template Matcher  │  matchAllSlides() → MatchResult[]
│ template-matcher  │  Scores templates by tag overlap, element count, keyword match
└────────┬─────────┘  Returns best match with score (0..1) and reason
         │
         ▼
┌──────────────────┐
│  Slide Adapter    │  adaptTemplate() → AdaptResult
│  slide-adapter    │  Maps parsed content to template elements
└────────┬─────────┘  Generates deleteText + insertText API requests
         │
         ▼
┌──────────────────┐
│  Slides API       │  applyRequests() → void
│  slides-api       │  Sends batch updates to Google Slides API
└────────┬─────────┘  Reads presentations via googleapis client
         │
         ▼
┌──────────────────┐
│  Screenshot       │  screenshotAllSlides() → SlideScreenshot[]
│  screenshot       │  Uses Chrome DevTools Protocol
└──────────────────┘  Captures each slide for visual verification
```

## Module Map

| File | Type | Responsibility |
|------|------|----------------|
| `slide.ts` | Slide, SlideElement | Core slide data model |
| `template.ts` | Template, TemplateTag | Template with tags and description |
| `markdown-parser.ts` | ParsedSlide | Markdown → structured slide descriptors |
| `match-result.ts` | MatchResult | Pairing of parsed slide to template |
| `template-matcher.ts` | — | Scoring and matching algorithm |
| `slide-adapter.ts` | SlideRequest, AdaptResult | Template → Slides API requests |
| `slides-api.ts` | PresentationInfo, SlidesApiConfig | Google Slides API read/write |
| `screenshot.ts` | SlideScreenshot, ScreenshotOptions | Chrome CDP screenshot capture |
| `pipeline.ts` | PipelineConfig, PipelineResult | Full end-to-end orchestration |

## Design Decisions

- **Immutable types**: All types use `Readonly<>` to prevent accidental mutation
- **One type per file**: Each file owns one primary type and its associated functions
- **Template matching is heuristic**: Uses tag overlap (60%), element count compatibility (20%), and keyword overlap (20%) — designed to be replaced with semantic/LLM matching later
- **Slides API batch updates**: All edits go through `batchUpdate` for atomicity
- **Chrome DevTools Protocol for screenshots**: Connects to the devcontainer Chrome instance (port 9222) — works with the existing Xvfb + noVNC setup
- **Dry run support**: Pipeline can generate requests without applying them, useful for preview/debugging

## Next Steps

- Integrate Claude for smarter template selection (semantic matching)
- Add HTML rendering path as alternative to Slides API for complex layouts
- Template library management (indexing past presentations)
- Visual diff between expected and actual screenshots
