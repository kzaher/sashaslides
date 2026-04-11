/**
 * The 100-item evaluation set for in-browser slide-agent VLMs.
 *
 * 50 visual items + 50 action items, distributed across the subcategories
 * that matter for a manus.im-style presentation agent:
 *
 * Visual (50):
 *   10 ocr             — can the model read text off a slide screenshot?
 *    8 layout_classify — title_only / title_and_body / two_column / ...
 *    8 chart_read      — read bar heights, identify trends, find max/min
 *    6 style_detect    — brand color, background, alignment, overflow
 *    6 element_count   — bullets, images, columns, table rows
 *    6 diff_detect     — before/after pair, report the change
 *    6 aesthetic_score — rate visual quality 0-10 with rubric
 *
 * Action (50):
 *   10 generate_html     — topic + layout → full <section> HTML
 *    6 pick_layout       — content description → layout class
 *    8 write_pptxgenjs   — slide spec → runnable JS code
 *    6 fix_bug           — broken slide code → fixed code
 *    8 edit_op           — current slide + instruction → new slide
 *    6 agent_plan        — goal → multi-step plan (JSON array)
 *    6 rewrite_content   — verbose bullet → tight bullet
 *
 * HTML strings are deliberately small and self-contained; the harness
 * renders each one into a 1920×1080 PNG before the call, so what the
 * model sees is a real rasterized slide — not raw HTML.
 */

import type { EvalItem } from "./eval-types.js";

// ---- HTML helpers --------------------------------------------------------

const SLIDE_BASE =
  'width:1920px;height:1080px;background:#fff;font-family:Inter,system-ui,sans-serif;color:#111;padding:80px;box-sizing:border-box';

const s = (inner: string, extra = ""): string =>
  `<section style="${SLIDE_BASE};${extra}">${inner}</section>`;

const title = (t: string): string =>
  `<h1 style="font-size:88px;font-weight:600;margin:0 0 40px 0">${t}</h1>`;

const body = (t: string): string =>
  `<p style="font-size:36px;line-height:1.4;margin:0">${t}</p>`;

const bullets = (items: readonly string[]): string =>
  `<ul style="font-size:36px;line-height:1.6;margin:0;padding-left:48px">${items.map((b) => `<li>${b}</li>`).join("")}</ul>`;

const bars = (values: readonly { label: string; height: number; color?: string }[]): string => {
  const maxH = Math.max(...values.map((v) => v.height));
  const barW = Math.floor(1600 / values.length) - 40;
  const bars = values
    .map((v, i) => {
      const h = Math.floor((v.height / maxH) * 600);
      const x = 80 + i * (barW + 40);
      const y = 900 - h;
      const color = v.color ?? "#3b82f6";
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}"/><text x="${x + barW / 2}" y="960" text-anchor="middle" font-size="28" font-family="Inter">${v.label}</text><text x="${x + barW / 2}" y="${y - 10}" text-anchor="middle" font-size="28" font-family="Inter" font-weight="600">${v.height}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 1920 1080" width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" font-size="56" font-family="Inter" font-weight="600">Monthly Revenue</text>${bars}</svg>`;
};

// ---- The 100 items -------------------------------------------------------

export const EVAL_SET: readonly EvalItem[] = [
  // ========== VISUAL: OCR (10) ==========
  {
    id: "vis-ocr-01",
    category: "visual",
    subcategory: "ocr",
    difficulty: "easy",
    description: "Read a single slide title.",
    input: {
      prompt: "What is the title of this slide? Answer with only the title text.",
      slideHtml: s(title("Introduction")),
    },
    expected: { containsAll: ["Introduction"] },
  },
  {
    id: "vis-ocr-02",
    category: "visual",
    subcategory: "ocr",
    difficulty: "easy",
    description: "Read a version number from body text.",
    input: {
      prompt: "What version number is mentioned on this slide?",
      slideHtml: s(title("Release Notes") + body("We shipped v2.4 last week with major performance improvements.")),
    },
    expected: { containsAll: ["2.4"] },
  },
  {
    id: "vis-ocr-03",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read the third bullet of a five-bullet list.",
    input: {
      prompt: "What is the third bullet in the list on this slide? Answer with only that bullet.",
      slideHtml: s(
        title("Agenda") +
          bullets(["Market overview", "Product roadmap", "Pricing strategy", "Hiring plan", "Q&A"]),
      ),
    },
    expected: { containsAll: ["Pricing"] },
  },
  {
    id: "vis-ocr-04",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read a dollar value from prose.",
    input: {
      prompt: "What revenue number is reported on this slide?",
      slideHtml: s(title("Q3 Results") + body("Revenue reached $4.2M this quarter, up 42% year-over-year.")),
    },
    expected: { containsAll: ["4.2"] },
  },
  {
    id: "vis-ocr-05",
    category: "visual",
    subcategory: "ocr",
    difficulty: "hard",
    description: "Read a small footer citation.",
    input: {
      prompt: "Read the citation source in the footer at the bottom of the slide.",
      slideHtml: s(
        title("Market Size") +
          body("The global widget market reached $120B in 2024.") +
          '<p style="position:absolute;bottom:40px;left:80px;font-size:18px;color:#888">Source: Statista 2025</p>',
      ),
    },
    expected: { containsAll: ["Statista"] },
  },
  {
    id: "vis-ocr-06",
    category: "visual",
    subcategory: "ocr",
    difficulty: "easy",
    description: "Read a subtitle beneath a title.",
    input: {
      prompt: "What is the subtitle of this slide?",
      slideHtml: s(
        title("Project Phoenix") +
          '<p style="font-size:44px;color:#666;margin:0">Rebuilding from the ground up</p>',
      ),
    },
    expected: { containsAny: ["Rebuilding", "ground up"] },
  },
  {
    id: "vis-ocr-07",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read a function name from a code block.",
    input: {
      prompt: "What is the name of the function defined in the code on this slide?",
      slideHtml: s(
        title("Helper") +
          '<pre style="font-family:monospace;font-size:32px;background:#f4f4f5;padding:24px;border-radius:8px">function computeDelta(a, b) {\n  return b - a;\n}</pre>',
      ),
    },
    expected: { containsAll: ["computeDelta"] },
  },
  {
    id: "vis-ocr-08",
    category: "visual",
    subcategory: "ocr",
    difficulty: "hard",
    description: "Read a large stylized headline number.",
    input: {
      prompt: "What number is shown in the large center text of this slide?",
      slideHtml: s(
        '<div style="display:flex;align-items:center;justify-content:center;height:100%"><span style="font-size:320px;font-weight:800;color:#3b82f6">87%</span></div>',
      ),
    },
    expected: { containsAll: ["87"] },
  },
  {
    id: "vis-ocr-09",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read a specific cell in a table.",
    input: {
      prompt: "What is the value in the 'Users' column for the 'Pro' plan?",
      slideHtml: s(
        title("Plans") +
          '<table style="font-size:32px;border-collapse:collapse;margin-top:40px"><tr><th style="border:1px solid #ccc;padding:16px 32px">Plan</th><th style="border:1px solid #ccc;padding:16px 32px">Price</th><th style="border:1px solid #ccc;padding:16px 32px">Users</th></tr><tr><td style="border:1px solid #ccc;padding:16px 32px">Free</td><td style="border:1px solid #ccc;padding:16px 32px">$0</td><td style="border:1px solid #ccc;padding:16px 32px">1</td></tr><tr><td style="border:1px solid #ccc;padding:16px 32px">Pro</td><td style="border:1px solid #ccc;padding:16px 32px">$29</td><td style="border:1px solid #ccc;padding:16px 32px">25</td></tr></table>',
      ),
    },
    expected: { containsAll: ["25"] },
  },
  {
    id: "vis-ocr-10",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read the author attribution of a quote slide.",
    input: {
      prompt: "Who is the quote on this slide attributed to?",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%"><p style="font-size:56px;font-style:italic">"The best way to predict the future is to invent it."</p><p style="font-size:36px;color:#666;margin-top:40px">— Alan Kay</p></div>',
      ),
    },
    expected: { containsAll: ["Alan Kay"] },
  },

  // ========== VISUAL: LAYOUT CLASSIFY (8) ==========
  {
    id: "vis-layout-01",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a title-only layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;align-items:center;justify-content:center;height:100%"><h1 style="font-size:140px;margin:0">Welcome</h1></div>',
      ),
    },
    expected: { containsAll: ["title_only"] },
  },
  {
    id: "vis-layout-02",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a title+body layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(title("Summary") + bullets(["Point one", "Point two", "Point three"])),
    },
    expected: { containsAll: ["title_and_body"] },
  },
  {
    id: "vis-layout-03",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a two-column layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        title("Pros and Cons") +
          '<div style="display:flex;gap:80px;margin-top:40px"><div style="flex:1"><h2 style="font-size:44px">Pros</h2><ul style="font-size:32px"><li>Fast</li><li>Cheap</li></ul></div><div style="flex:1"><h2 style="font-size:44px">Cons</h2><ul style="font-size:32px"><li>Complex</li><li>Brittle</li></ul></div></div>',
      ),
    },
    expected: { containsAll: ["two_column"] },
  },
  {
    id: "vis-layout-04",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify an image-right layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;gap:80px;height:100%;align-items:center"><div style="flex:1"><h1 style="font-size:64px;margin:0 0 24px">Fast Setup</h1><p style="font-size:32px">Get started in three commands.</p></div><div style="flex:1;background:#e5e7eb;border-radius:16px;height:600px;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:32px">[product image]</div></div>',
      ),
    },
    expected: { containsAll: ["image_right"] },
  },
  {
    id: "vis-layout-05",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a section divider.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100%;margin:-80px"><h1 style="font-size:160px;margin:0">Part II</h1></div>',
      ),
    },
    expected: { containsAny: ["section_divider", "title_only"] },
  },
  {
    id: "vis-layout-06",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a quote slide.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%"><p style="font-size:72px;font-style:italic">"Simplicity is the ultimate sophistication."</p><p style="font-size:36px;color:#666;margin-top:40px">— Leonardo da Vinci</p></div>',
      ),
    },
    expected: { containsAll: ["quote"] },
  },
  {
    id: "vis-layout-07",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a chart-dominant layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, chart.",
      slideHtml: s(
        bars([
          { label: "Jan", height: 10 },
          { label: "Feb", height: 14 },
          { label: "Mar", height: 22 },
          { label: "Apr", height: 18 },
        ]),
      ),
    },
    expected: { containsAny: ["chart", "title_and_body"] },
  },
  {
    id: "vis-layout-08",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "hard",
    description: "Classify a dense three-column layout.",
    input: {
      prompt:
        "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, three_column, image_right, section_divider.",
      slideHtml: s(
        title("Features") +
          '<div style="display:flex;gap:40px"><div style="flex:1"><h2 style="font-size:40px">Fast</h2><p style="font-size:28px">Sub-100ms.</p></div><div style="flex:1"><h2 style="font-size:40px">Scalable</h2><p style="font-size:28px">To billions.</p></div><div style="flex:1"><h2 style="font-size:40px">Cheap</h2><p style="font-size:28px">$0.01/req.</p></div></div>',
      ),
    },
    expected: { containsAll: ["three_column"] },
  },

  // ========== VISUAL: CHART READ (8) ==========
  {
    id: "vis-chart-01",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "easy",
    description: "Find the tallest bar by label.",
    input: {
      prompt: "Which month has the tallest bar in this chart? Answer with only the month name.",
      slideHtml: bars([
        { label: "Jan", height: 10 },
        { label: "Feb", height: 14 },
        { label: "Mar", height: 28 },
        { label: "Apr", height: 18 },
        { label: "May", height: 22 },
      ]),
    },
    expected: { containsAll: ["Mar"] },
  },
  {
    id: "vis-chart-02",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "medium",
    description: "Read a specific bar's value.",
    input: {
      prompt: "What is the numeric value of the April bar?",
      slideHtml: bars([
        { label: "Jan", height: 10 },
        { label: "Feb", height: 14 },
        { label: "Mar", height: 28 },
        { label: "Apr", height: 18 },
        { label: "May", height: 22 },
      ]),
    },
    expected: { containsAll: ["18"] },
  },
  {
    id: "vis-chart-03",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "easy",
    description: "Count bars in a chart.",
    input: {
      prompt: "How many bars are in this chart? Answer with only the number.",
      slideHtml: bars([
        { label: "A", height: 10 },
        { label: "B", height: 14 },
        { label: "C", height: 28 },
        { label: "D", height: 18 },
      ]),
    },
    expected: { containsAll: ["4"] },
  },
  {
    id: "vis-chart-04",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "medium",
    description: "Identify an overall trend direction.",
    input: {
      prompt: "Is the overall trend in this chart increasing, decreasing, or flat? Answer with one word.",
      slideHtml: bars([
        { label: "Q1", height: 10 },
        { label: "Q2", height: 14 },
        { label: "Q3", height: 20 },
        { label: "Q4", height: 26 },
      ]),
    },
    expected: { containsAny: ["increasing", "up", "growing"] },
  },
  {
    id: "vis-chart-05",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "medium",
    description: "Find the smallest bar.",
    input: {
      prompt: "Which label has the shortest bar? Answer with only the label.",
      slideHtml: bars([
        { label: "North", height: 40 },
        { label: "South", height: 22 },
        { label: "East", height: 18 },
        { label: "West", height: 30 },
      ]),
    },
    expected: { containsAll: ["East"] },
  },
  {
    id: "vis-chart-06",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "hard",
    description: "Compare two bars by difference.",
    input: {
      prompt: "By how much is the March bar taller than the January bar? Answer with only the number.",
      slideHtml: bars([
        { label: "Jan", height: 10 },
        { label: "Feb", height: 14 },
        { label: "Mar", height: 28 },
      ]),
    },
    expected: { containsAll: ["18"] },
  },
  {
    id: "vis-chart-07",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "easy",
    description: "Read the chart title.",
    input: {
      prompt: "What is the title of this chart?",
      slideHtml: bars([
        { label: "Jan", height: 10 },
        { label: "Feb", height: 14 },
      ]),
    },
    expected: { containsAll: ["Monthly Revenue"] },
  },
  {
    id: "vis-chart-08",
    category: "visual",
    subcategory: "chart_read",
    difficulty: "medium",
    description: "Spot a color-coded outlier.",
    input: {
      prompt: "Which label is drawn in red instead of blue? Answer with only the label.",
      slideHtml: bars([
        { label: "A", height: 12 },
        { label: "B", height: 18 },
        { label: "C", height: 14, color: "#ef4444" },
        { label: "D", height: 16 },
      ]),
    },
    expected: { containsAll: ["C"] },
  },

  // ========== VISUAL: STYLE DETECT (6) ==========
  {
    id: "vis-style-01",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "medium",
    description: "Identify the dominant brand color.",
    input: {
      prompt: "Roughly what is the primary brand color on this slide? Answer with a common color name.",
      slideHtml: s(
        '<div style="background:#3b82f6;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Acme Cloud</h1><p style="font-size:36px">The fastest way to ship.</p></div>',
      ),
    },
    expected: { containsAny: ["blue", "azure"] },
  },
  {
    id: "vis-style-02",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "medium",
    description: "Detect a dark background.",
    input: {
      prompt: "Is this slide on a light background or a dark background? Answer with one word.",
      slideHtml: s(
        '<div style="background:#0b0f19;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Night Mode</h1></div>',
      ),
    },
    expected: { containsAny: ["dark", "black"] },
  },
  {
    id: "vis-style-03",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "medium",
    description: "Detect a serif vs sans-serif font.",
    input: {
      prompt: "Is the title on this slide a serif font or a sans-serif font? Answer with one word.",
      slideHtml: s(
        '<h1 style="font-family:Georgia,serif;font-size:120px;margin:0">Elegant</h1><p style="font-family:Georgia,serif;font-size:36px">A serif-rendered slide.</p>',
      ),
    },
    expected: { containsAny: ["serif"], containsNone: ["sans-serif"] },
  },
  {
    id: "vis-style-04",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "easy",
    description: "Detect text alignment.",
    input: {
      prompt: "Is the body text on this slide left-aligned, center-aligned, or right-aligned? Answer with one word.",
      slideHtml: s(
        title("Manifesto") +
          '<p style="font-size:36px;text-align:center;line-height:1.6">We believe in simplicity.<br/>We believe in speed.<br/>We believe in elegance.</p>',
      ),
    },
    expected: { containsAny: ["center", "centered"] },
  },
  {
    id: "vis-style-05",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "hard",
    description: "Detect a contrast problem.",
    input: {
      prompt:
        "Does this slide have a readability / contrast problem? Answer yes or no, and name the specific issue in one sentence.",
      slideHtml: s(
        '<div style="background:#eaeaea;color:#c8c8c8;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Subtle</h1><p style="font-size:36px">This text is hard to read.</p></div>',
      ),
    },
    expected: { containsAll: ["contrast"] },
  },
  {
    id: "vis-style-06",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "hard",
    description: "Detect overflowing text.",
    input: {
      prompt: "Does the body text on this slide fit inside the slide, or does it overflow? Answer with 'fits' or 'overflows'.",
      slideHtml: s(
        title("Details") +
          '<p style="font-size:64px;line-height:1.2">' +
          "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(30) +
          "</p>",
      ),
    },
    expected: { containsAny: ["overflow"] },
  },

  // ========== VISUAL: ELEMENT COUNT (6) ==========
  {
    id: "vis-count-01",
    category: "visual",
    subcategory: "element_count",
    difficulty: "easy",
    description: "Count bullet items.",
    input: {
      prompt: "How many bullet items are in the list on this slide? Answer with only the number.",
      slideHtml: s(
        title("Goals") + bullets(["Ship v1", "Land first 10 customers", "Close seed round", "Hire 2 engineers"]),
      ),
    },
    expected: { containsAll: ["4"] },
  },
  {
    id: "vis-count-02",
    category: "visual",
    subcategory: "element_count",
    difficulty: "medium",
    description: "Count placeholder image boxes.",
    input: {
      prompt: "How many image boxes are on this slide? Answer with only the number.",
      slideHtml: s(
        title("Team") +
          '<div style="display:flex;gap:40px;margin-top:40px">' +
          Array.from({ length: 3 })
            .map(
              () =>
                '<div style="width:300px;height:300px;background:#e5e7eb;border-radius:16px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:24px">[image]</div>',
            )
            .join("") +
          "</div>",
      ),
    },
    expected: { containsAll: ["3"] },
  },
  {
    id: "vis-count-03",
    category: "visual",
    subcategory: "element_count",
    difficulty: "easy",
    description: "Count columns.",
    input: {
      prompt: "How many columns of content does this slide have? Answer with only the number.",
      slideHtml: s(
        title("Comparison") +
          '<div style="display:flex;gap:40px"><div style="flex:1"><h2>A</h2><p>Alpha.</p></div><div style="flex:1"><h2>B</h2><p>Beta.</p></div></div>',
      ),
    },
    expected: { containsAll: ["2"] },
  },
  {
    id: "vis-count-04",
    category: "visual",
    subcategory: "element_count",
    difficulty: "medium",
    description: "Count distinct headings.",
    input: {
      prompt: "How many headings are on this slide? Answer with only the number.",
      slideHtml: s(
        '<h1 style="font-size:64px">Overview</h1><h2 style="font-size:44px">Context</h2><h2 style="font-size:44px">Problem</h2><h2 style="font-size:44px">Solution</h2>',
      ),
    },
    expected: { containsAll: ["4"] },
  },
  {
    id: "vis-count-05",
    category: "visual",
    subcategory: "element_count",
    difficulty: "medium",
    description: "Count table rows (excluding header).",
    input: {
      prompt: "How many data rows (excluding the header) are in the table on this slide? Answer with only the number.",
      slideHtml: s(
        title("Pricing") +
          '<table style="font-size:32px;border-collapse:collapse"><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0</td></tr><tr><td>Pro</td><td>$29</td></tr><tr><td>Team</td><td>$99</td></tr><tr><td>Enterprise</td><td>Call us</td></tr></table>',
      ),
    },
    expected: { containsAll: ["4"] },
  },
  {
    id: "vis-count-06",
    category: "visual",
    subcategory: "element_count",
    difficulty: "hard",
    description: "Count bars in a chart.",
    input: {
      prompt: "How many bars are in the chart on this slide? Answer with only the number.",
      slideHtml: bars([
        { label: "Q1", height: 10 },
        { label: "Q2", height: 14 },
        { label: "Q3", height: 22 },
        { label: "Q4", height: 18 },
        { label: "Q5", height: 26 },
        { label: "Q6", height: 19 },
        { label: "Q7", height: 24 },
      ]),
    },
    expected: { containsAll: ["7"] },
  },

  // ========== VISUAL: DIFF DETECT (6) ==========
  {
    id: "vis-diff-01",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "medium",
    description: "Detect a title change between two slides.",
    input: {
      prompt:
        "You are shown two slides, A then B. What specifically changed? Answer in one short sentence.",
      slideHtml: s(title("Market Overview") + body("Global widget market analysis.")),
      slideHtmlB: s(title("Market Deep Dive") + body("Global widget market analysis.")),
    },
    expected: { containsAny: ["title", "heading", "Deep Dive"] },
  },
  {
    id: "vis-diff-02",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "medium",
    description: "Detect an added bullet.",
    input: {
      prompt: "What is different between slide A and slide B? Answer in one short sentence.",
      slideHtml: s(title("Agenda") + bullets(["Intro", "Demo", "Pricing"])),
      slideHtmlB: s(title("Agenda") + bullets(["Intro", "Demo", "Pricing", "Q&A"])),
    },
    expected: { containsAny: ["Q&A", "added", "new bullet"] },
  },
  {
    id: "vis-diff-03",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "medium",
    description: "Detect a removed bullet.",
    input: {
      prompt: "What is different between slide A and slide B? Answer in one short sentence.",
      slideHtml: s(title("Roadmap") + bullets(["Alpha", "Beta", "GA", "v2"])),
      slideHtmlB: s(title("Roadmap") + bullets(["Alpha", "Beta", "GA"])),
    },
    expected: { containsAny: ["v2", "removed", "one fewer"] },
  },
  {
    id: "vis-diff-04",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "hard",
    description: "Detect a color change.",
    input: {
      prompt: "What visual property changed between slide A and slide B? Answer in one short sentence.",
      slideHtml: s(
        '<div style="background:#3b82f6;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Brand</h1></div>',
      ),
      slideHtmlB: s(
        '<div style="background:#ef4444;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Brand</h1></div>',
      ),
    },
    expected: { containsAny: ["color", "blue", "red"] },
  },
  {
    id: "vis-diff-05",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "hard",
    description: "Detect a layout change.",
    input: {
      prompt: "What layout change happened between slide A and slide B? Answer in one short sentence.",
      slideHtml: s(title("Results") + bullets(["A", "B", "C"])),
      slideHtmlB: s(
        title("Results") +
          '<div style="display:flex;gap:80px"><div style="flex:1"><h2>Left</h2><p>A</p></div><div style="flex:1"><h2>Right</h2><p>B</p></div></div>',
      ),
    },
    expected: { containsAny: ["column", "layout"] },
  },
  {
    id: "vis-diff-06",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "hard",
    description: "Detect a typo fix.",
    input: {
      prompt: "What typo was fixed between slide A and slide B? Answer with the corrected word.",
      slideHtml: s(title("Reccomendations") + body("We reccomend launching in Q4.")),
      slideHtmlB: s(title("Recommendations") + body("We recommend launching in Q4.")),
    },
    expected: { containsAny: ["Recommend", "spelling"] },
  },

  // ========== VISUAL: AESTHETIC SCORE (6) ==========
  {
    id: "vis-aes-01",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a clean, well-balanced slide.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%;max-width:1200px"><h1 style="font-size:88px;margin:0 0 32px;font-weight:600">Our North Star</h1><p style="font-size:40px;color:#4b5563;line-height:1.4;margin:0">A single metric we commit to: ship one customer value per week.</p></div>',
      ),
    },
    expected: { numericRange: [6, 10] },
  },
  {
    id: "vis-aes-02",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a cluttered slide.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<h1 style="font-size:88px;margin:0;color:#ff00ff">URGENT!!! READ!!!</h1>' +
          bullets(Array.from({ length: 14 }).map((_, i) => `Really important point number ${i + 1}`)) +
          '<p style="font-size:28px;color:red;position:absolute;top:20px;right:20px">*** ASAP ***</p>',
      ),
    },
    expected: { numericRange: [0, 5] },
  },
  {
    id: "vis-aes-03",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "hard",
    description: "Score a slide with poor contrast.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="background:#f8f8f8;color:#e8e8e8;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px">Whisper</h1><p style="font-size:36px">Can you even see this?</p></div>',
      ),
    },
    expected: { numericRange: [0, 5] },
  },
  {
    id: "vis-aes-04",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a high-contrast minimalist slide.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="background:#111;color:#fff;padding:80px;height:100%;margin:-80px;display:flex;align-items:center"><h1 style="font-size:160px;margin:0;font-weight:700">Less.</h1></div>',
      ),
    },
    expected: { numericRange: [6, 10] },
  },
  {
    id: "vis-aes-05",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a text-wall slide.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        title("Background") +
          `<p style="font-size:28px;line-height:1.5">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(25)}</p>`,
      ),
    },
    expected: { numericRange: [0, 5] },
  },
  {
    id: "vis-aes-06",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a well-typographed quote slide.",
    input: {
      prompt:
        "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%;max-width:1400px"><p style="font-size:72px;font-style:italic;font-weight:300;line-height:1.3;margin:0">"The future is already here — it\'s just not evenly distributed."</p><p style="font-size:36px;color:#6b7280;margin-top:56px">— William Gibson</p></div>',
      ),
    },
    expected: { numericRange: [6, 10] },
  },

  // ========== ACTION: GENERATE HTML (10) ==========
  {
    id: "gen-html-01",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a title+body slide about Q3 results.",
    input: {
      prompt:
        'Write a complete self-contained HTML <section> for a 1920x1080 slide titled "Q3 Results". Body: "Revenue up 42% YoY, ARR now at $18M." Use inline styles. Output ONLY the <section>...</section> element, no markdown fences.',
    },
    expected: {
      containsAll: ["<section", "Q3", "42", "18"],
      containsNone: ["```"],
    },
  },
  {
    id: "gen-html-02",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a section divider slide.",
    input: {
      prompt:
        'Write a complete self-contained HTML <section> for a 1920x1080 section-divider slide with a single large centered word: "Conclusion". Use a dark background and large white text. Output ONLY the <section>...</section>.',
    },
    expected: {
      containsAll: ["<section", "Conclusion"],
      containsAny: ["#000", "#111", "#0", "black", "dark"],
    },
  },
  {
    id: "gen-html-03",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a two-column pros/cons slide.",
    input: {
      prompt:
        "Write a complete <section> for a 1920x1080 two-column slide comparing REST (pros: simple, cacheable; cons: chatty, over-fetch) vs GraphQL (pros: flexible, one endpoint; cons: complex, caching hard). Output only the <section>.",
    },
    expected: {
      containsAll: ["<section", "REST", "GraphQL"],
      containsAny: ["column", "flex", "grid"],
    },
  },
  {
    id: "gen-html-04",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a quote slide.",
    input: {
      prompt:
        'Write a complete <section> for a 1920x1080 quote slide with the quote "Make it work, make it right, make it fast." attributed to Kent Beck. Italic quote, author below, centered vertically. Output only the <section>.',
    },
    expected: {
      containsAll: ["<section", "Kent Beck", "Make it work"],
      containsAny: ["italic", "italics"],
    },
  },
  {
    id: "gen-html-05",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a five-bullet agenda.",
    input: {
      prompt:
        "Write a complete <section> for a 1920x1080 agenda slide for a 30-minute product review. 5 numbered bullets covering intro, user research, design, engineering, Q&A. Output only the <section>.",
    },
    expected: {
      containsAll: ["<section", "Agenda"],
      containsAny: ["<ol", "<ul", "1.", "①"],
    },
  },
  {
    id: "gen-html-06",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a title+subtitle slide.",
    input: {
      prompt:
        'Write a complete <section> for a 1920x1080 opening slide: title "Project Orion", subtitle "A platform for space logistics". Centered, large title. Output only the <section>.',
    },
    expected: { containsAll: ["Project Orion", "space logistics"] },
  },
  {
    id: "gen-html-07",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate an image-right layout.",
    input: {
      prompt:
        'Write a complete <section> for a 1920x1080 slide with text on the left and a placeholder image box on the right. Title: "Fast onboarding". Body: "Three clicks to first value." Image box: gray background, rounded corners, "[hero image]" placeholder. Output only the <section>.',
    },
    expected: {
      containsAll: ["<section", "Fast onboarding", "Three clicks"],
      containsAny: ["flex", "grid"],
    },
  },
  {
    id: "gen-html-08",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a pricing table slide.",
    input: {
      prompt:
        "Write a complete <section> for a 1920x1080 pricing slide with a 3x3 HTML table: Plan (Free/Pro/Team), Price ($0/$29/$99), Seats (1/5/25). Output only the <section>.",
    },
    expected: {
      containsAll: ["<section", "<table", "$29", "Free", "Team"],
    },
  },
  {
    id: "gen-html-09",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a closing thank-you slide.",
    input: {
      prompt:
        'Write a complete <section> for a 1920x1080 closing slide: large "Thank you" centered, email "hi@example.com" below. Output only the <section>.',
    },
    expected: { containsAll: ["Thank you", "hi@example.com"] },
  },
  {
    id: "gen-html-10",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a slide with a code snippet.",
    input: {
      prompt:
        'Write a complete <section> for a 1920x1080 slide showing this snippet in a monospace block: `const sum = (a, b) => a + b;`. Title: "Simple sum". Output only the <section>.',
    },
    expected: {
      containsAll: ["Simple sum", "sum"],
      containsAny: ["<pre", "<code", "monospace"],
    },
  },

  // ========== ACTION: PICK LAYOUT (6) ==========
  {
    id: "pick-01",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a five-bullet content slide.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "Five bullets summarizing Q3 wins"',
    },
    expected: { containsAll: ["title_and_body"] },
  },
  {
    id: "pick-02",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a single hero number.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A single large hero metric: 42% growth"',
    },
    expected: { containsAny: ["title_only", "section_divider"] },
  },
  {
    id: "pick-03",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a famous quote.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A Steve Jobs quote about design"',
    },
    expected: { containsAll: ["quote"] },
  },
  {
    id: "pick-04",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "medium",
    description: "Pick layout for a head-to-head comparison.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "React vs Vue head-to-head comparison"',
    },
    expected: { containsAll: ["two_column"] },
  },
  {
    id: "pick-05",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "medium",
    description: "Pick layout for a feature+screenshot slide.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A single feature description with a product screenshot"',
    },
    expected: { containsAll: ["image_right"] },
  },
  {
    id: "pick-06",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a section transition.",
    input: {
      prompt:
        'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "Transition between Part I (Problem) and Part II (Solution)"',
    },
    expected: { containsAll: ["section_divider"] },
  },

  // ========== ACTION: WRITE PPTXGENJS (8) ==========
  {
    id: "ppt-01",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "easy",
    description: "Emit pptxgenjs code for a title slide.",
    input: {
      prompt:
        'Write a JavaScript snippet using pptxgenjs that adds a title slide saying "Welcome to Acme" to an existing `pptx` instance. Use `slide.addText`. Output only the code.',
    },
    expected: {
      containsAll: ["addText", "Welcome to Acme"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-02",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "easy",
    description: "Emit pptxgenjs bullet list.",
    input: {
      prompt:
        'Write a JavaScript snippet using pptxgenjs that adds a slide with 3 bullets: "Speed", "Scale", "Simplicity". Use addText with a bullet option. Output only the code.',
    },
    expected: {
      containsAll: ["addText", "Speed", "Scale", "Simplicity"],
      containsAny: ["bullet"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-03",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs table code.",
    input: {
      prompt:
        "Write JavaScript using pptxgenjs that adds a table with headers [Plan, Price] and rows [[Free, $0], [Pro, $29]]. Output only the code.",
    },
    expected: {
      containsAll: ["addTable", "Free", "Pro"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-04",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs addImage code.",
    input: {
      prompt:
        "Write JavaScript using pptxgenjs that adds a slide with an image from path './hero.png' positioned at x=1, y=1, w=5, h=3 inches. Output only the code.",
    },
    expected: {
      containsAll: ["addImage", "hero.png"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-05",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "hard",
    description: "Emit pptxgenjs line chart code.",
    input: {
      prompt:
        "Write JavaScript using pptxgenjs that adds a line chart with data for Jan=10, Feb=14, Mar=22. Use addChart. Output only the code.",
    },
    expected: {
      containsAll: ["addChart", "Jan", "Feb", "Mar"],
      containsAny: ["LINE", "line"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-06",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "hard",
    description: "Emit pptxgenjs bar chart code.",
    input: {
      prompt:
        "Write JavaScript using pptxgenjs that adds a bar chart comparing revenue for three regions: North=40, South=22, East=18. Output only the code.",
    },
    expected: {
      containsAll: ["addChart", "North", "South", "East"],
      containsAny: ["BAR", "bar"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-07",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs addShape code.",
    input: {
      prompt:
        "Write JavaScript using pptxgenjs that adds a blue rectangle covering the left third of a slide, then adds white text 'Section' on top of it. Output only the code.",
    },
    expected: {
      containsAll: ["addShape", "addText", "Section"],
      codeRuns: true,
    },
  },
  {
    id: "ppt-08",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs speaker notes code.",
    input: {
      prompt:
        'Write JavaScript using pptxgenjs that adds speaker notes to a slide: "Remember to pause for questions after slide 3." Output only the code.',
    },
    expected: {
      containsAll: ["addNotes", "pause for questions"],
      codeRuns: true,
    },
  },

  // ========== ACTION: FIX BUG (6) ==========
  {
    id: "fix-01",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "easy",
    description: "Fix typo in pptxgenjs method name.",
    input: {
      prompt:
        "This code throws 'slide.addTxt is not a function'. Fix the bug and output the corrected code only.",
      code: "const slide = pptx.addSlide();\nslide.addTxt('Hello', { x: 1, y: 1, w: 5, h: 1 });",
    },
    expected: {
      containsAll: ["addText"],
      containsNone: ["addTxt"],
      codeRuns: true,
    },
  },
  {
    id: "fix-02",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Add missing await before writeFile.",
    input: {
      prompt:
        "This async function returns before the file is written. Fix it and output the corrected code only.",
      code: "async function save(pptx) {\n  const slide = pptx.addSlide();\n  slide.addText('Hi', { x: 1, y: 1 });\n  pptx.writeFile({ fileName: 'out.pptx' });\n  return 'done';\n}",
    },
    expected: {
      containsAll: ["await"],
      codeRuns: true,
    },
  },
  {
    id: "fix-03",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix unit confusion — pptxgenjs uses inches, not pixels.",
    input: {
      prompt:
        "This code intends to place text near the top-left with a small offset but uses pixels. pptxgenjs uses inches. Fix it (assume 96 dpi) and output the corrected code only.",
      code: "slide.addText('Header', { x: 96, y: 96, w: 480, h: 48 });",
    },
    expected: {
      containsAll: ["addText"],
      containsNone: ["96"],
      codeRuns: true,
    },
  },
  {
    id: "fix-04",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix off-by-one in a loop that should produce 5 bullets.",
    input: {
      prompt:
        "This code is supposed to produce 5 bullet lines but only produces 4. Fix it and output the corrected code only.",
      code: "const items = ['A', 'B', 'C', 'D', 'E'];\nlet text = '';\nfor (let i = 0; i < items.length - 1; i++) {\n  text += '• ' + items[i] + '\\n';\n}\nslide.addText(text, { x: 1, y: 1, w: 8, h: 4 });",
    },
    expected: {
      containsAll: ["items.length"],
      containsNone: ["length - 1", "length-1"],
      codeRuns: true,
    },
  },
  {
    id: "fix-05",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Add a null check before accessing optional image URL.",
    input: {
      prompt:
        "This code crashes when `slideData.image` is undefined. Add a guard and output the corrected code only.",
      code: "function render(slideData, slide) {\n  slide.addText(slideData.title, { x: 1, y: 1 });\n  slide.addImage({ path: slideData.image.url, x: 1, y: 2, w: 4, h: 3 });\n}",
    },
    expected: {
      containsAny: ["if (", "?.", "&&", "slideData.image"],
      codeRuns: true,
    },
  },
  {
    id: "fix-06",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix wrong slide ratio — should be 16:9.",
    input: {
      prompt:
        "This code creates a 4:3 presentation but we want 16:9 (widescreen). Fix the pptxgenjs config and output the corrected code only.",
      code: "const pptx = new pptxgen();\npptx.layout = 'LAYOUT_4x3';\npptx.addSlide().addText('Hello', { x: 1, y: 1 });",
    },
    expected: {
      containsAll: ["LAYOUT_WIDE"],
      containsNone: ["LAYOUT_4x3"],
      codeRuns: true,
    },
  },

  // ========== ACTION: EDIT OP (8) ==========
  {
    id: "edit-01",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Add a bullet to an existing slide.",
    input: {
      prompt:
        'Current slide has bullets: "Intro", "Demo", "Q&A". Add a new bullet "Pricing" before "Q&A". Output the updated bullet list as a JSON array of strings, nothing else.',
    },
    expected: {
      isJson: true,
      containsAll: ["Intro", "Demo", "Pricing", "Q&A"],
    },
  },
  {
    id: "edit-02",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Remove a bullet from an existing slide.",
    input: {
      prompt:
        'Current slide has bullets: "Alpha", "Beta", "Gamma", "Delta". Remove "Gamma". Output the updated bullet list as a JSON array of strings, nothing else.',
    },
    expected: {
      isJson: true,
      containsAll: ["Alpha", "Beta", "Delta"],
      containsNone: ["Gamma"],
    },
  },
  {
    id: "edit-03",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Change the title of a slide.",
    input: {
      prompt:
        'Current slide title is "Market Overview". Change it to be more specific to SaaS. Output a JSON object { "title": "..." } with only the new title.',
    },
    expected: {
      isJson: true,
      containsAny: ["SaaS"],
    },
  },
  {
    id: "edit-04",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Change the brand color from blue to green.",
    input: {
      prompt:
        'The current slide uses #3b82f6 (blue) as its accent color. Change it to a calm green hex code. Output a JSON object { "accent": "#..." } with only the new hex value.',
    },
    expected: {
      isJson: true,
      containsAny: ["#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "#a", "#b", "#c", "#d", "#e", "#f"],
    },
  },
  {
    id: "edit-05",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Reorder bullets alphabetically.",
    input: {
      prompt:
        'Current bullets: ["Zeta", "Alpha", "Mu", "Beta"]. Reorder them alphabetically. Output the new list as a JSON array.',
    },
    expected: {
      isJson: true,
      containsAll: ["Alpha", "Beta", "Mu", "Zeta"],
    },
  },
  {
    id: "edit-06",
    category: "action",
    subcategory: "edit_op",
    difficulty: "hard",
    description: "Split one slide into two.",
    input: {
      prompt:
        'A single slide has title "Roadmap" with 8 bullets. Split it into two slides of 4 bullets each, keeping the same title suffixed with "(1/2)" and "(2/2)". The bullets are: ["Plan", "Design", "Prototype", "Build", "Test", "Launch", "Monitor", "Iterate"]. Output a JSON array of two objects each with { title, bullets }.',
    },
    expected: {
      isJson: true,
      containsAll: ["1/2", "2/2"],
    },
  },
  {
    id: "edit-07",
    category: "action",
    subcategory: "edit_op",
    difficulty: "hard",
    description: "Merge two slides into one.",
    input: {
      prompt:
        'Two consecutive slides both titled "Team" with bullets A=["Alice", "Bob"] and B=["Carol", "Dan"]. Merge them into one slide. Output a JSON object { title, bullets } with the combined list.',
    },
    expected: {
      isJson: true,
      containsAll: ["Alice", "Bob", "Carol", "Dan"],
    },
  },
  {
    id: "edit-08",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Change layout from two_column to title_and_body.",
    input: {
      prompt:
        'A slide is currently two_column with left="A", right="B". Flatten to title_and_body with bullets. Output a JSON object { "layout": "...", "bullets": ["...", "..."] }.',
    },
    expected: {
      isJson: true,
      containsAll: ["title_and_body", "A", "B"],
    },
  },

  // ========== ACTION: AGENT PLAN (6) ==========
  {
    id: "plan-01",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan a 5-slide deck about a new product launch.",
    input: {
      prompt:
        'Plan a 5-slide deck for a product launch of "Orbit, a task manager for remote teams". Output a JSON array of 5 objects with { slideNumber, title, layout, oneLineSummary }. Layouts must be one of: title_only, title_and_body, two_column, image_right, section_divider, quote.',
    },
    expected: {
      isJson: true,
      containsAll: ["Orbit"],
    },
  },
  {
    id: "plan-02",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan steps to convert markdown notes to a slide deck.",
    input: {
      prompt:
        'You are given a markdown file with H1/H2 headings and bullets, and need to produce a .pptx file. Output a JSON array of sequential tool-call steps, where each step has { tool, args_summary }. Tools available: parseMarkdown, pickLayout, generateHtml, renderSlide, scoreSlide, writePptxgenjs, exportPptx.',
    },
    expected: {
      isJson: true,
      containsAll: ["parseMarkdown", "exportPptx"],
    },
  },
  {
    id: "plan-03",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan adding a chart to an existing slide.",
    input: {
      prompt:
        'An existing slide has a title and a three-bullet list. The user wants to add a bar chart that visualizes the values in the bullets (each bullet has a number). Output a JSON array of steps: { tool, args_summary }. Tools: extractBulletNumbers, generateChartHtml, renderSlide, replaceSlide.',
    },
    expected: {
      isJson: true,
      containsAll: ["extractBulletNumbers", "generateChartHtml"],
    },
  },
  {
    id: "plan-04",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan an aesthetic-iteration loop.",
    input: {
      prompt:
        'You need to go through a 20-slide deck, score each slide aesthetically, and regenerate any slide scoring below 7. Output a JSON array describing the loop steps: { tool, args_summary }. Tools: listSlides, renderSlide, scoreSlide, regenerateSlide, replaceSlide.',
    },
    expected: {
      isJson: true,
      containsAll: ["listSlides", "scoreSlide", "regenerateSlide"],
    },
  },
  {
    id: "plan-05",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan translating a deck to another language.",
    input: {
      prompt:
        'You need to translate a 10-slide English deck to Spanish, preserving layout. Output a JSON array of steps: { tool, args_summary }. Tools: listSlides, extractText, translateText, replaceText.',
    },
    expected: {
      isJson: true,
      containsAll: ["translateText", "replaceText"],
    },
  },
  {
    id: "plan-06",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan a rebranding pass.",
    input: {
      prompt:
        'A deck uses colors #3b82f6 (blue) and #f97316 (orange). Rebrand every slide to use #111827 (dark) and #10b981 (green). Output a JSON array of steps: { tool, args_summary }. Tools: listSlides, parseStyles, replaceColor, renderSlide, verifyContrast.',
    },
    expected: {
      isJson: true,
      containsAll: ["replaceColor", "verifyContrast"],
    },
  },

  // ========== ACTION: REWRITE CONTENT (6) ==========
  {
    id: "rw-01",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Tighten a verbose bullet to 10 words or fewer.",
    input: {
      prompt:
        'Rewrite this bullet to be 10 words or fewer while preserving the meaning: "We are in the process of exploring the possibility of potentially leveraging some form of AI-based approach to improve our customer onboarding experience." Output ONLY the rewritten bullet.',
    },
    expected: {
      containsAny: ["AI", "onboarding"],
      containsNone: ["in the process of"],
    },
  },
  {
    id: "rw-02",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "easy",
    description: "Fix grammar.",
    input: {
      prompt:
        'Fix any grammar mistakes in this bullet: "The team are committed to ship there new product by end of Q3." Output ONLY the corrected bullet.',
    },
    expected: { containsAll: ["their"], containsNone: ["there new"] },
  },
  {
    id: "rw-03",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Add a concrete number to a vague claim.",
    input: {
      prompt:
        'Rewrite this bullet to include a concrete placeholder number: "Our customers love our product." Use the format "X% of customers" with a realistic number. Output ONLY the rewritten bullet.',
    },
    expected: { containsAny: ["%"] },
  },
  {
    id: "rw-04",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Remove jargon.",
    input: {
      prompt:
        'Rewrite this bullet to remove jargon and be understandable to a non-technical audience: "We leverage synergistic cross-functional paradigms to unblock key value-stream bottlenecks." Output ONLY the rewritten bullet.',
    },
    expected: {
      containsNone: ["synergistic", "paradigm", "leverage"],
    },
  },
  {
    id: "rw-05",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Enforce parallel structure.",
    input: {
      prompt:
        'Rewrite these bullets to use parallel grammatical structure: ["Faster to deploy", "Scalability of the platform", "Cost reduction"]. Output a JSON array of strings.',
    },
    expected: {
      isJson: true,
    },
  },
  {
    id: "rw-06",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Convert passive voice to active.",
    input: {
      prompt:
        'Rewrite this bullet in active voice: "Mistakes were made during the rollout by the deployment team." Output ONLY the rewritten bullet.',
    },
    expected: { containsAny: ["team made", "team caused", "team had", "deployment team made"] },
  },
];

// --- sanity asserts, called at module load so a malformed item explodes loudly ---

if (EVAL_SET.length !== 100) {
  throw new Error(`EVAL_SET must have exactly 100 items, got ${EVAL_SET.length}`);
}
const ids = new Set<string>();
for (const it of EVAL_SET) {
  if (ids.has(it.id)) throw new Error(`Duplicate eval id: ${it.id}`);
  ids.add(it.id);
}
const visualCount = EVAL_SET.filter((i) => i.category === "visual").length;
const actionCount = EVAL_SET.filter((i) => i.category === "action").length;
if (visualCount !== 50 || actionCount !== 50) {
  throw new Error(`Expected 50/50 split, got visual=${visualCount} action=${actionCount}`);
}
