/**
 * System prompts and tool schemas for the slide-building agent.
 *
 * The prompts are written to be stable prefixes — same system message, same
 * tool definitions — so the radix KV cache can reuse the prefill across every
 * turn of every run. This is the #1 lesson from Manus's context engineering
 * post (see research/01-manus-architecture.md): KV-cache hit rate is the
 * dominant latency lever.
 */

import type { ToolDef } from "./types.js";

export const SLIDE_AGENT_SYSTEM_PROMPT = `You are a slide-building agent that produces a presentation by calling tools.

You have access to tools that let you:
  - generate_slide_html: write the HTML/CSS for one slide
  - render_slide: render HTML to a PNG screenshot
  - score_slide: score a rendered slide for aesthetic quality (0-10)
  - write_pptxgenjs: emit a JavaScript snippet that builds this slide with pptxgenjs
  - finish: declare the slide complete

Design principles:
  - Each slide uses a 16:9 canvas (1920x1080) with 80px padding.
  - Typography: primary title 72px semibold, body 32px regular, max 6 bullets.
  - Color palette: one brand color + neutral grays. No more than 3 colors per slide.
  - Leave generous whitespace. A slide is "done" when removing any element would
    hurt comprehension.
  - NEVER fabricate facts. If the user's input is vague, ask one clarifying
    question via the assistant message, don't invent data.
  - When writing code, emit valid, runnable JavaScript. No markdown fences.
  - When returning JSON, produce valid JSON with no trailing commas.

Iterate: generate → render → score. If score < 7, revise once. Then finish.`;

export const SLIDE_AGENT_TOOLS: readonly ToolDef[] = [
  {
    name: "generate_slide_html",
    description:
      "Produce full HTML for a single 1920x1080 slide. Output must be a complete <section> element with inline styles. No external CSS. No external fonts beyond Inter and Caveat.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Slide title." },
        layout: {
          type: "string",
          enum: ["title_only", "title_and_body", "two_column", "image_right", "section_divider", "quote"],
          description: "Layout category — the renderer picks a stylesheet from this.",
        },
        content: {
          type: "string",
          description: "Slide body content as markdown (bullets, code, etc.).",
        },
        notes: { type: "string", description: "Speaker notes. Optional." },
      },
      required: ["title", "layout", "content"],
    },
  },
  {
    name: "render_slide",
    description: "Render the current slide HTML to a PNG. Returns { imageUrl, sha256 }.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "score_slide",
    description: "Score the currently rendered slide for aesthetic quality. Returns { score: 0..10, issues: string[] }.",
    parameters: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          items: { type: "string" },
          description: "Specific criteria to evaluate. Default: overall.",
        },
      },
      required: [],
    },
  },
  {
    name: "write_pptxgenjs",
    description:
      "Emit a JavaScript snippet that recreates the current slide using pptxgenjs. Must be an async function body taking (pptx, slide) and using slide.addText / slide.addImage / slide.addShape.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Runnable JavaScript snippet." },
      },
      required: ["code"],
    },
  },
  {
    name: "finish",
    description: "Mark the current slide as complete. Takes no arguments.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];
