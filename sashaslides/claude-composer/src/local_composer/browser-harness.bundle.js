// src/local_composer/eval-set.ts
var SLIDE_BASE = "width:1920px;height:1080px;background:#fff;font-family:Inter,system-ui,sans-serif;color:#111;padding:80px;box-sizing:border-box";
var s = (inner, extra = "") => `<section style="${SLIDE_BASE};${extra}">${inner}</section>`;
var title = (t) => `<h1 style="font-size:88px;font-weight:600;margin:0 0 40px 0">${t}</h1>`;
var body = (t) => `<p style="font-size:36px;line-height:1.4;margin:0">${t}</p>`;
var bullets = (items) => `<ul style="font-size:36px;line-height:1.6;margin:0;padding-left:48px">${items.map((b) => `<li>${b}</li>`).join("")}</ul>`;
var bars = (values) => {
  const maxH = Math.max(...values.map((v) => v.height));
  const barW = Math.floor(1600 / values.length) - 40;
  const bars2 = values.map((v, i) => {
    const h = Math.floor(v.height / maxH * 600);
    const x = 80 + i * (barW + 40);
    const y = 900 - h;
    const color = v.color ?? "#3b82f6";
    return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}"/><text x="${x + barW / 2}" y="960" text-anchor="middle" font-size="28" font-family="Inter">${v.label}</text><text x="${x + barW / 2}" y="${y - 10}" text-anchor="middle" font-size="28" font-family="Inter" font-weight="600">${v.height}</text>`;
  }).join("");
  return `<svg viewBox="0 0 1920 1080" width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><text x="80" y="80" font-size="56" font-family="Inter" font-weight="600">Monthly Revenue</text>${bars2}</svg>`;
};
var EVAL_SET = [
  // ========== VISUAL: OCR (10) ==========
  {
    id: "vis-ocr-01",
    category: "visual",
    subcategory: "ocr",
    difficulty: "easy",
    description: "Read a single slide title.",
    input: {
      prompt: "What is the title of this slide? Answer with only the title text.",
      slideHtml: s(title("Introduction"))
    },
    expected: { containsAll: ["Introduction"] }
  },
  {
    id: "vis-ocr-02",
    category: "visual",
    subcategory: "ocr",
    difficulty: "easy",
    description: "Read a version number from body text.",
    input: {
      prompt: "What version number is mentioned on this slide?",
      slideHtml: s(title("Release Notes") + body("We shipped v2.4 last week with major performance improvements."))
    },
    expected: { containsAll: ["2.4"] }
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
        title("Agenda") + bullets(["Market overview", "Product roadmap", "Pricing strategy", "Hiring plan", "Q&A"])
      )
    },
    expected: { containsAll: ["Pricing"] }
  },
  {
    id: "vis-ocr-04",
    category: "visual",
    subcategory: "ocr",
    difficulty: "medium",
    description: "Read a dollar value from prose.",
    input: {
      prompt: "What revenue number is reported on this slide?",
      slideHtml: s(title("Q3 Results") + body("Revenue reached $4.2M this quarter, up 42% year-over-year."))
    },
    expected: { containsAll: ["4.2"] }
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
        title("Market Size") + body("The global widget market reached $120B in 2024.") + '<p style="position:absolute;bottom:40px;left:80px;font-size:18px;color:#888">Source: Statista 2025</p>'
      )
    },
    expected: { containsAll: ["Statista"] }
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
        title("Project Phoenix") + '<p style="font-size:44px;color:#666;margin:0">Rebuilding from the ground up</p>'
      )
    },
    expected: { containsAny: ["Rebuilding", "ground up"] }
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
        title("Helper") + '<pre style="font-family:monospace;font-size:32px;background:#f4f4f5;padding:24px;border-radius:8px">function computeDelta(a, b) {\n  return b - a;\n}</pre>'
      )
    },
    expected: { containsAll: ["computeDelta"] }
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
        '<div style="display:flex;align-items:center;justify-content:center;height:100%"><span style="font-size:320px;font-weight:800;color:#3b82f6">87%</span></div>'
      )
    },
    expected: { containsAll: ["87"] }
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
        title("Plans") + '<table style="font-size:32px;border-collapse:collapse;margin-top:40px"><tr><th style="border:1px solid #ccc;padding:16px 32px">Plan</th><th style="border:1px solid #ccc;padding:16px 32px">Price</th><th style="border:1px solid #ccc;padding:16px 32px">Users</th></tr><tr><td style="border:1px solid #ccc;padding:16px 32px">Free</td><td style="border:1px solid #ccc;padding:16px 32px">$0</td><td style="border:1px solid #ccc;padding:16px 32px">1</td></tr><tr><td style="border:1px solid #ccc;padding:16px 32px">Pro</td><td style="border:1px solid #ccc;padding:16px 32px">$29</td><td style="border:1px solid #ccc;padding:16px 32px">25</td></tr></table>'
      )
    },
    expected: { containsAll: ["25"] }
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
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%"><p style="font-size:56px;font-style:italic">"The best way to predict the future is to invent it."</p><p style="font-size:36px;color:#666;margin-top:40px">\u2014 Alan Kay</p></div>'
      )
    },
    expected: { containsAll: ["Alan Kay"] }
  },
  // ========== VISUAL: LAYOUT CLASSIFY (8) ==========
  {
    id: "vis-layout-01",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a title-only layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;align-items:center;justify-content:center;height:100%"><h1 style="font-size:140px;margin:0">Welcome</h1></div>'
      )
    },
    expected: { containsAll: ["title_only"] }
  },
  {
    id: "vis-layout-02",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a title+body layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(title("Summary") + bullets(["Point one", "Point two", "Point three"]))
    },
    expected: { containsAll: ["title_and_body"] }
  },
  {
    id: "vis-layout-03",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a two-column layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        title("Pros and Cons") + '<div style="display:flex;gap:80px;margin-top:40px"><div style="flex:1"><h2 style="font-size:44px">Pros</h2><ul style="font-size:32px"><li>Fast</li><li>Cheap</li></ul></div><div style="flex:1"><h2 style="font-size:44px">Cons</h2><ul style="font-size:32px"><li>Complex</li><li>Brittle</li></ul></div></div>'
      )
    },
    expected: { containsAll: ["two_column"] }
  },
  {
    id: "vis-layout-04",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify an image-right layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;gap:80px;height:100%;align-items:center"><div style="flex:1"><h1 style="font-size:64px;margin:0 0 24px">Fast Setup</h1><p style="font-size:32px">Get started in three commands.</p></div><div style="flex:1;background:#e5e7eb;border-radius:16px;height:600px;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:32px">[product image]</div></div>'
      )
    },
    expected: { containsAll: ["image_right"] }
  },
  {
    id: "vis-layout-05",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "easy",
    description: "Classify a section divider.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100%;margin:-80px"><h1 style="font-size:160px;margin:0">Part II</h1></div>'
      )
    },
    expected: { containsAny: ["section_divider", "title_only"] }
  },
  {
    id: "vis-layout-06",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a quote slide.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, quote.",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%"><p style="font-size:72px;font-style:italic">"Simplicity is the ultimate sophistication."</p><p style="font-size:36px;color:#666;margin-top:40px">\u2014 Leonardo da Vinci</p></div>'
      )
    },
    expected: { containsAll: ["quote"] }
  },
  {
    id: "vis-layout-07",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "medium",
    description: "Classify a chart-dominant layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, image_right, section_divider, chart.",
      slideHtml: s(
        bars([
          { label: "Jan", height: 10 },
          { label: "Feb", height: 14 },
          { label: "Mar", height: 22 },
          { label: "Apr", height: 18 }
        ])
      )
    },
    expected: { containsAny: ["chart", "title_and_body"] }
  },
  {
    id: "vis-layout-08",
    category: "visual",
    subcategory: "layout_classify",
    difficulty: "hard",
    description: "Classify a dense three-column layout.",
    input: {
      prompt: "Classify this slide's layout. Respond with exactly one of: title_only, title_and_body, two_column, three_column, image_right, section_divider.",
      slideHtml: s(
        title("Features") + '<div style="display:flex;gap:40px"><div style="flex:1"><h2 style="font-size:40px">Fast</h2><p style="font-size:28px">Sub-100ms.</p></div><div style="flex:1"><h2 style="font-size:40px">Scalable</h2><p style="font-size:28px">To billions.</p></div><div style="flex:1"><h2 style="font-size:40px">Cheap</h2><p style="font-size:28px">$0.01/req.</p></div></div>'
      )
    },
    expected: { containsAll: ["three_column"] }
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
        { label: "May", height: 22 }
      ])
    },
    expected: { containsAll: ["Mar"] }
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
        { label: "May", height: 22 }
      ])
    },
    expected: { containsAll: ["18"] }
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
        { label: "D", height: 18 }
      ])
    },
    expected: { containsAll: ["4"] }
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
        { label: "Q4", height: 26 }
      ])
    },
    expected: { containsAny: ["increasing", "up", "growing"] }
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
        { label: "West", height: 30 }
      ])
    },
    expected: { containsAll: ["East"] }
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
        { label: "Mar", height: 28 }
      ])
    },
    expected: { containsAll: ["18"] }
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
        { label: "Feb", height: 14 }
      ])
    },
    expected: { containsAll: ["Monthly Revenue"] }
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
        { label: "D", height: 16 }
      ])
    },
    expected: { containsAll: ["C"] }
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
        '<div style="background:#3b82f6;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Acme Cloud</h1><p style="font-size:36px">The fastest way to ship.</p></div>'
      )
    },
    expected: { containsAny: ["blue", "azure"] }
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
        '<div style="background:#0b0f19;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Night Mode</h1></div>'
      )
    },
    expected: { containsAny: ["dark", "black"] }
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
        '<h1 style="font-family:Georgia,serif;font-size:120px;margin:0">Elegant</h1><p style="font-family:Georgia,serif;font-size:36px">A serif-rendered slide.</p>'
      )
    },
    expected: { containsAny: ["serif"], containsNone: ["sans-serif"] }
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
        title("Manifesto") + '<p style="font-size:36px;text-align:center;line-height:1.6">We believe in simplicity.<br/>We believe in speed.<br/>We believe in elegance.</p>'
      )
    },
    expected: { containsAny: ["center", "centered"] }
  },
  {
    id: "vis-style-05",
    category: "visual",
    subcategory: "style_detect",
    difficulty: "hard",
    description: "Detect a contrast problem.",
    input: {
      prompt: "Does this slide have a readability / contrast problem? Answer yes or no, and name the specific issue in one sentence.",
      slideHtml: s(
        '<div style="background:#eaeaea;color:#c8c8c8;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Subtle</h1><p style="font-size:36px">This text is hard to read.</p></div>'
      )
    },
    expected: { containsAll: ["contrast"] }
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
        title("Details") + '<p style="font-size:64px;line-height:1.2">' + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(30) + "</p>"
      )
    },
    expected: { containsAny: ["overflow"] }
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
        title("Goals") + bullets(["Ship v1", "Land first 10 customers", "Close seed round", "Hire 2 engineers"])
      )
    },
    expected: { containsAll: ["4"] }
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
        title("Team") + '<div style="display:flex;gap:40px;margin-top:40px">' + Array.from({ length: 3 }).map(
          () => '<div style="width:300px;height:300px;background:#e5e7eb;border-radius:16px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:24px">[image]</div>'
        ).join("") + "</div>"
      )
    },
    expected: { containsAll: ["3"] }
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
        title("Comparison") + '<div style="display:flex;gap:40px"><div style="flex:1"><h2>A</h2><p>Alpha.</p></div><div style="flex:1"><h2>B</h2><p>Beta.</p></div></div>'
      )
    },
    expected: { containsAll: ["2"] }
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
        '<h1 style="font-size:64px">Overview</h1><h2 style="font-size:44px">Context</h2><h2 style="font-size:44px">Problem</h2><h2 style="font-size:44px">Solution</h2>'
      )
    },
    expected: { containsAll: ["4"] }
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
        title("Pricing") + '<table style="font-size:32px;border-collapse:collapse"><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0</td></tr><tr><td>Pro</td><td>$29</td></tr><tr><td>Team</td><td>$99</td></tr><tr><td>Enterprise</td><td>Call us</td></tr></table>'
      )
    },
    expected: { containsAll: ["4"] }
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
        { label: "Q7", height: 24 }
      ])
    },
    expected: { containsAll: ["7"] }
  },
  // ========== VISUAL: DIFF DETECT (6) ==========
  {
    id: "vis-diff-01",
    category: "visual",
    subcategory: "diff_detect",
    difficulty: "medium",
    description: "Detect a title change between two slides.",
    input: {
      prompt: "You are shown two slides, A then B. What specifically changed? Answer in one short sentence.",
      slideHtml: s(title("Market Overview") + body("Global widget market analysis.")),
      slideHtmlB: s(title("Market Deep Dive") + body("Global widget market analysis."))
    },
    expected: { containsAny: ["title", "heading", "Deep Dive"] }
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
      slideHtmlB: s(title("Agenda") + bullets(["Intro", "Demo", "Pricing", "Q&A"]))
    },
    expected: { containsAny: ["Q&A", "added", "new bullet"] }
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
      slideHtmlB: s(title("Roadmap") + bullets(["Alpha", "Beta", "GA"]))
    },
    expected: { containsAny: ["v2", "removed", "one fewer"] }
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
        '<div style="background:#3b82f6;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Brand</h1></div>'
      ),
      slideHtmlB: s(
        '<div style="background:#ef4444;color:#fff;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px;margin:0">Brand</h1></div>'
      )
    },
    expected: { containsAny: ["color", "blue", "red"] }
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
        title("Results") + '<div style="display:flex;gap:80px"><div style="flex:1"><h2>Left</h2><p>A</p></div><div style="flex:1"><h2>Right</h2><p>B</p></div></div>'
      )
    },
    expected: { containsAny: ["column", "layout"] }
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
      slideHtmlB: s(title("Recommendations") + body("We recommend launching in Q4."))
    },
    expected: { containsAny: ["Recommend", "spelling"] }
  },
  // ========== VISUAL: AESTHETIC SCORE (6) ==========
  {
    id: "vis-aes-01",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a clean, well-balanced slide.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="display:flex;flex-direction:column;justify-content:center;height:100%;max-width:1200px"><h1 style="font-size:88px;margin:0 0 32px;font-weight:600">Our North Star</h1><p style="font-size:40px;color:#4b5563;line-height:1.4;margin:0">A single metric we commit to: ship one customer value per week.</p></div>'
      )
    },
    expected: { numericRange: [6, 10] }
  },
  {
    id: "vis-aes-02",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a cluttered slide.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<h1 style="font-size:88px;margin:0;color:#ff00ff">URGENT!!! READ!!!</h1>' + bullets(Array.from({ length: 14 }).map((_, i) => `Really important point number ${i + 1}`)) + '<p style="font-size:28px;color:red;position:absolute;top:20px;right:20px">*** ASAP ***</p>'
      )
    },
    expected: { numericRange: [0, 5] }
  },
  {
    id: "vis-aes-03",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "hard",
    description: "Score a slide with poor contrast.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="background:#f8f8f8;color:#e8e8e8;padding:80px;height:100%;margin:-80px"><h1 style="font-size:88px">Whisper</h1><p style="font-size:36px">Can you even see this?</p></div>'
      )
    },
    expected: { numericRange: [0, 5] }
  },
  {
    id: "vis-aes-04",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a high-contrast minimalist slide.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        '<div style="background:#111;color:#fff;padding:80px;height:100%;margin:-80px;display:flex;align-items:center"><h1 style="font-size:160px;margin:0;font-weight:700">Less.</h1></div>'
      )
    },
    expected: { numericRange: [6, 10] }
  },
  {
    id: "vis-aes-05",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a text-wall slide.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        title("Background") + `<p style="font-size:28px;line-height:1.5">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(25)}</p>`
      )
    },
    expected: { numericRange: [0, 5] }
  },
  {
    id: "vis-aes-06",
    category: "visual",
    subcategory: "aesthetic_score",
    difficulty: "medium",
    description: "Score a well-typographed quote slide.",
    input: {
      prompt: "Rate the aesthetic quality of this slide on a 0-10 scale. Respond with only an integer. 0 is terrible, 10 is perfect.",
      slideHtml: s(
        `<div style="display:flex;flex-direction:column;justify-content:center;height:100%;max-width:1400px"><p style="font-size:72px;font-style:italic;font-weight:300;line-height:1.3;margin:0">"The future is already here \u2014 it's just not evenly distributed."</p><p style="font-size:36px;color:#6b7280;margin-top:56px">\u2014 William Gibson</p></div>`
      )
    },
    expected: { numericRange: [6, 10] }
  },
  // ========== ACTION: GENERATE HTML (10) ==========
  {
    id: "gen-html-01",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a title+body slide about Q3 results.",
    input: {
      prompt: 'Write a complete self-contained HTML <section> for a 1920x1080 slide titled "Q3 Results". Body: "Revenue up 42% YoY, ARR now at $18M." Use inline styles. Output ONLY the <section>...</section> element, no markdown fences.'
    },
    expected: {
      containsAll: ["<section", "Q3", "42", "18"],
      containsNone: ["```"]
    }
  },
  {
    id: "gen-html-02",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a section divider slide.",
    input: {
      prompt: 'Write a complete self-contained HTML <section> for a 1920x1080 section-divider slide with a single large centered word: "Conclusion". Use a dark background and large white text. Output ONLY the <section>...</section>.'
    },
    expected: {
      containsAll: ["<section", "Conclusion"],
      containsAny: ["#000", "#111", "#0", "black", "dark"]
    }
  },
  {
    id: "gen-html-03",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a two-column pros/cons slide.",
    input: {
      prompt: "Write a complete <section> for a 1920x1080 two-column slide comparing REST (pros: simple, cacheable; cons: chatty, over-fetch) vs GraphQL (pros: flexible, one endpoint; cons: complex, caching hard). Output only the <section>."
    },
    expected: {
      containsAll: ["<section", "REST", "GraphQL"],
      containsAny: ["column", "flex", "grid"]
    }
  },
  {
    id: "gen-html-04",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a quote slide.",
    input: {
      prompt: 'Write a complete <section> for a 1920x1080 quote slide with the quote "Make it work, make it right, make it fast." attributed to Kent Beck. Italic quote, author below, centered vertically. Output only the <section>.'
    },
    expected: {
      containsAll: ["<section", "Kent Beck", "Make it work"],
      containsAny: ["italic", "italics"]
    }
  },
  {
    id: "gen-html-05",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a five-bullet agenda.",
    input: {
      prompt: "Write a complete <section> for a 1920x1080 agenda slide for a 30-minute product review. 5 numbered bullets covering intro, user research, design, engineering, Q&A. Output only the <section>."
    },
    expected: {
      containsAll: ["<section", "Agenda"],
      containsAny: ["<ol", "<ul", "1.", "\u2460"]
    }
  },
  {
    id: "gen-html-06",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a title+subtitle slide.",
    input: {
      prompt: 'Write a complete <section> for a 1920x1080 opening slide: title "Project Orion", subtitle "A platform for space logistics". Centered, large title. Output only the <section>.'
    },
    expected: { containsAll: ["Project Orion", "space logistics"] }
  },
  {
    id: "gen-html-07",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate an image-right layout.",
    input: {
      prompt: 'Write a complete <section> for a 1920x1080 slide with text on the left and a placeholder image box on the right. Title: "Fast onboarding". Body: "Three clicks to first value." Image box: gray background, rounded corners, "[hero image]" placeholder. Output only the <section>.'
    },
    expected: {
      containsAll: ["<section", "Fast onboarding", "Three clicks"],
      containsAny: ["flex", "grid"]
    }
  },
  {
    id: "gen-html-08",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a pricing table slide.",
    input: {
      prompt: "Write a complete <section> for a 1920x1080 pricing slide with a 3x3 HTML table: Plan (Free/Pro/Team), Price ($0/$29/$99), Seats (1/5/25). Output only the <section>."
    },
    expected: {
      containsAll: ["<section", "<table", "$29", "Free", "Team"]
    }
  },
  {
    id: "gen-html-09",
    category: "action",
    subcategory: "generate_html",
    difficulty: "easy",
    description: "Generate a closing thank-you slide.",
    input: {
      prompt: 'Write a complete <section> for a 1920x1080 closing slide: large "Thank you" centered, email "hi@example.com" below. Output only the <section>.'
    },
    expected: { containsAll: ["Thank you", "hi@example.com"] }
  },
  {
    id: "gen-html-10",
    category: "action",
    subcategory: "generate_html",
    difficulty: "medium",
    description: "Generate a slide with a code snippet.",
    input: {
      prompt: 'Write a complete <section> for a 1920x1080 slide showing this snippet in a monospace block: `const sum = (a, b) => a + b;`. Title: "Simple sum". Output only the <section>.'
    },
    expected: {
      containsAll: ["Simple sum", "sum"],
      containsAny: ["<pre", "<code", "monospace"]
    }
  },
  // ========== ACTION: PICK LAYOUT (6) ==========
  {
    id: "pick-01",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a five-bullet content slide.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "Five bullets summarizing Q3 wins"'
    },
    expected: { containsAll: ["title_and_body"] }
  },
  {
    id: "pick-02",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a single hero number.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A single large hero metric: 42% growth"'
    },
    expected: { containsAny: ["title_only", "section_divider"] }
  },
  {
    id: "pick-03",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a famous quote.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A Steve Jobs quote about design"'
    },
    expected: { containsAll: ["quote"] }
  },
  {
    id: "pick-04",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "medium",
    description: "Pick layout for a head-to-head comparison.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "React vs Vue head-to-head comparison"'
    },
    expected: { containsAll: ["two_column"] }
  },
  {
    id: "pick-05",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "medium",
    description: "Pick layout for a feature+screenshot slide.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "A single feature description with a product screenshot"'
    },
    expected: { containsAll: ["image_right"] }
  },
  {
    id: "pick-06",
    category: "action",
    subcategory: "pick_layout",
    difficulty: "easy",
    description: "Pick layout for a section transition.",
    input: {
      prompt: 'Given this content description, pick exactly one layout from: title_only, title_and_body, two_column, image_right, section_divider, quote. Respond with only the layout name.\n\nContent: "Transition between Part I (Problem) and Part II (Solution)"'
    },
    expected: { containsAll: ["section_divider"] }
  },
  // ========== ACTION: WRITE PPTXGENJS (8) ==========
  {
    id: "ppt-01",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "easy",
    description: "Emit pptxgenjs code for a title slide.",
    input: {
      prompt: 'Write a JavaScript snippet using pptxgenjs that adds a title slide saying "Welcome to Acme" to an existing `pptx` instance. Use `slide.addText`. Output only the code.'
    },
    expected: {
      containsAll: ["addText", "Welcome to Acme"],
      codeRuns: true
    }
  },
  {
    id: "ppt-02",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "easy",
    description: "Emit pptxgenjs bullet list.",
    input: {
      prompt: 'Write a JavaScript snippet using pptxgenjs that adds a slide with 3 bullets: "Speed", "Scale", "Simplicity". Use addText with a bullet option. Output only the code.'
    },
    expected: {
      containsAll: ["addText", "Speed", "Scale", "Simplicity"],
      containsAny: ["bullet"],
      codeRuns: true
    }
  },
  {
    id: "ppt-03",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs table code.",
    input: {
      prompt: "Write JavaScript using pptxgenjs that adds a table with headers [Plan, Price] and rows [[Free, $0], [Pro, $29]]. Output only the code."
    },
    expected: {
      containsAll: ["addTable", "Free", "Pro"],
      codeRuns: true
    }
  },
  {
    id: "ppt-04",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs addImage code.",
    input: {
      prompt: "Write JavaScript using pptxgenjs that adds a slide with an image from path './hero.png' positioned at x=1, y=1, w=5, h=3 inches. Output only the code."
    },
    expected: {
      containsAll: ["addImage", "hero.png"],
      codeRuns: true
    }
  },
  {
    id: "ppt-05",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "hard",
    description: "Emit pptxgenjs line chart code.",
    input: {
      prompt: "Write JavaScript using pptxgenjs that adds a line chart with data for Jan=10, Feb=14, Mar=22. Use addChart. Output only the code."
    },
    expected: {
      containsAll: ["addChart", "Jan", "Feb", "Mar"],
      containsAny: ["LINE", "line"],
      codeRuns: true
    }
  },
  {
    id: "ppt-06",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "hard",
    description: "Emit pptxgenjs bar chart code.",
    input: {
      prompt: "Write JavaScript using pptxgenjs that adds a bar chart comparing revenue for three regions: North=40, South=22, East=18. Output only the code."
    },
    expected: {
      containsAll: ["addChart", "North", "South", "East"],
      containsAny: ["BAR", "bar"],
      codeRuns: true
    }
  },
  {
    id: "ppt-07",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs addShape code.",
    input: {
      prompt: "Write JavaScript using pptxgenjs that adds a blue rectangle covering the left third of a slide, then adds white text 'Section' on top of it. Output only the code."
    },
    expected: {
      containsAll: ["addShape", "addText", "Section"],
      codeRuns: true
    }
  },
  {
    id: "ppt-08",
    category: "action",
    subcategory: "write_pptxgenjs",
    difficulty: "medium",
    description: "Emit pptxgenjs speaker notes code.",
    input: {
      prompt: 'Write JavaScript using pptxgenjs that adds speaker notes to a slide: "Remember to pause for questions after slide 3." Output only the code.'
    },
    expected: {
      containsAll: ["addNotes", "pause for questions"],
      codeRuns: true
    }
  },
  // ========== ACTION: FIX BUG (6) ==========
  {
    id: "fix-01",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "easy",
    description: "Fix typo in pptxgenjs method name.",
    input: {
      prompt: "This code throws 'slide.addTxt is not a function'. Fix the bug and output the corrected code only.",
      code: "const slide = pptx.addSlide();\nslide.addTxt('Hello', { x: 1, y: 1, w: 5, h: 1 });"
    },
    expected: {
      containsAll: ["addText"],
      containsNone: ["addTxt"],
      codeRuns: true
    }
  },
  {
    id: "fix-02",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Add missing await before writeFile.",
    input: {
      prompt: "This async function returns before the file is written. Fix it and output the corrected code only.",
      code: "async function save(pptx) {\n  const slide = pptx.addSlide();\n  slide.addText('Hi', { x: 1, y: 1 });\n  pptx.writeFile({ fileName: 'out.pptx' });\n  return 'done';\n}"
    },
    expected: {
      containsAll: ["await"],
      codeRuns: true
    }
  },
  {
    id: "fix-03",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix unit confusion \u2014 pptxgenjs uses inches, not pixels.",
    input: {
      prompt: "This code intends to place text near the top-left with a small offset but uses pixels. pptxgenjs uses inches. Fix it (assume 96 dpi) and output the corrected code only.",
      code: "slide.addText('Header', { x: 96, y: 96, w: 480, h: 48 });"
    },
    expected: {
      containsAll: ["addText"],
      containsNone: ["96"],
      codeRuns: true
    }
  },
  {
    id: "fix-04",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix off-by-one in a loop that should produce 5 bullets.",
    input: {
      prompt: "This code is supposed to produce 5 bullet lines but only produces 4. Fix it and output the corrected code only.",
      code: "const items = ['A', 'B', 'C', 'D', 'E'];\nlet text = '';\nfor (let i = 0; i < items.length - 1; i++) {\n  text += '\u2022 ' + items[i] + '\\n';\n}\nslide.addText(text, { x: 1, y: 1, w: 8, h: 4 });"
    },
    expected: {
      containsAll: ["items.length"],
      containsNone: ["length - 1", "length-1"],
      codeRuns: true
    }
  },
  {
    id: "fix-05",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Add a null check before accessing optional image URL.",
    input: {
      prompt: "This code crashes when `slideData.image` is undefined. Add a guard and output the corrected code only.",
      code: "function render(slideData, slide) {\n  slide.addText(slideData.title, { x: 1, y: 1 });\n  slide.addImage({ path: slideData.image.url, x: 1, y: 2, w: 4, h: 3 });\n}"
    },
    expected: {
      containsAny: ["if (", "?.", "&&", "slideData.image"],
      codeRuns: true
    }
  },
  {
    id: "fix-06",
    category: "action",
    subcategory: "fix_bug",
    difficulty: "medium",
    description: "Fix wrong slide ratio \u2014 should be 16:9.",
    input: {
      prompt: "This code creates a 4:3 presentation but we want 16:9 (widescreen). Fix the pptxgenjs config and output the corrected code only.",
      code: "const pptx = new pptxgen();\npptx.layout = 'LAYOUT_4x3';\npptx.addSlide().addText('Hello', { x: 1, y: 1 });"
    },
    expected: {
      containsAll: ["LAYOUT_WIDE"],
      containsNone: ["LAYOUT_4x3"],
      codeRuns: true
    }
  },
  // ========== ACTION: EDIT OP (8) ==========
  {
    id: "edit-01",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Add a bullet to an existing slide.",
    input: {
      prompt: 'Current slide has bullets: "Intro", "Demo", "Q&A". Add a new bullet "Pricing" before "Q&A". Output the updated bullet list as a JSON array of strings, nothing else.'
    },
    expected: {
      isJson: true,
      containsAll: ["Intro", "Demo", "Pricing", "Q&A"]
    }
  },
  {
    id: "edit-02",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Remove a bullet from an existing slide.",
    input: {
      prompt: 'Current slide has bullets: "Alpha", "Beta", "Gamma", "Delta". Remove "Gamma". Output the updated bullet list as a JSON array of strings, nothing else.'
    },
    expected: {
      isJson: true,
      containsAll: ["Alpha", "Beta", "Delta"],
      containsNone: ["Gamma"]
    }
  },
  {
    id: "edit-03",
    category: "action",
    subcategory: "edit_op",
    difficulty: "easy",
    description: "Change the title of a slide.",
    input: {
      prompt: 'Current slide title is "Market Overview". Change it to be more specific to SaaS. Output a JSON object { "title": "..." } with only the new title.'
    },
    expected: {
      isJson: true,
      containsAny: ["SaaS"]
    }
  },
  {
    id: "edit-04",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Change the brand color from blue to green.",
    input: {
      prompt: 'The current slide uses #3b82f6 (blue) as its accent color. Change it to a calm green hex code. Output a JSON object { "accent": "#..." } with only the new hex value.'
    },
    expected: {
      isJson: true,
      containsAny: ["#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "#a", "#b", "#c", "#d", "#e", "#f"]
    }
  },
  {
    id: "edit-05",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Reorder bullets alphabetically.",
    input: {
      prompt: 'Current bullets: ["Zeta", "Alpha", "Mu", "Beta"]. Reorder them alphabetically. Output the new list as a JSON array.'
    },
    expected: {
      isJson: true,
      containsAll: ["Alpha", "Beta", "Mu", "Zeta"]
    }
  },
  {
    id: "edit-06",
    category: "action",
    subcategory: "edit_op",
    difficulty: "hard",
    description: "Split one slide into two.",
    input: {
      prompt: 'A single slide has title "Roadmap" with 8 bullets. Split it into two slides of 4 bullets each, keeping the same title suffixed with "(1/2)" and "(2/2)". The bullets are: ["Plan", "Design", "Prototype", "Build", "Test", "Launch", "Monitor", "Iterate"]. Output a JSON array of two objects each with { title, bullets }.'
    },
    expected: {
      isJson: true,
      containsAll: ["1/2", "2/2"]
    }
  },
  {
    id: "edit-07",
    category: "action",
    subcategory: "edit_op",
    difficulty: "hard",
    description: "Merge two slides into one.",
    input: {
      prompt: 'Two consecutive slides both titled "Team" with bullets A=["Alice", "Bob"] and B=["Carol", "Dan"]. Merge them into one slide. Output a JSON object { title, bullets } with the combined list.'
    },
    expected: {
      isJson: true,
      containsAll: ["Alice", "Bob", "Carol", "Dan"]
    }
  },
  {
    id: "edit-08",
    category: "action",
    subcategory: "edit_op",
    difficulty: "medium",
    description: "Change layout from two_column to title_and_body.",
    input: {
      prompt: 'A slide is currently two_column with left="A", right="B". Flatten to title_and_body with bullets. Output a JSON object { "layout": "...", "bullets": ["...", "..."] }.'
    },
    expected: {
      isJson: true,
      containsAll: ["title_and_body", "A", "B"]
    }
  },
  // ========== ACTION: AGENT PLAN (6) ==========
  {
    id: "plan-01",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan a 5-slide deck about a new product launch.",
    input: {
      prompt: 'Plan a 5-slide deck for a product launch of "Orbit, a task manager for remote teams". Output a JSON array of 5 objects with { slideNumber, title, layout, oneLineSummary }. Layouts must be one of: title_only, title_and_body, two_column, image_right, section_divider, quote.'
    },
    expected: {
      isJson: true,
      containsAll: ["Orbit"]
    }
  },
  {
    id: "plan-02",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan steps to convert markdown notes to a slide deck.",
    input: {
      prompt: "You are given a markdown file with H1/H2 headings and bullets, and need to produce a .pptx file. Output a JSON array of sequential tool-call steps, where each step has { tool, args_summary }. Tools available: parseMarkdown, pickLayout, generateHtml, renderSlide, scoreSlide, writePptxgenjs, exportPptx."
    },
    expected: {
      isJson: true,
      containsAll: ["parseMarkdown", "exportPptx"]
    }
  },
  {
    id: "plan-03",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan adding a chart to an existing slide.",
    input: {
      prompt: "An existing slide has a title and a three-bullet list. The user wants to add a bar chart that visualizes the values in the bullets (each bullet has a number). Output a JSON array of steps: { tool, args_summary }. Tools: extractBulletNumbers, generateChartHtml, renderSlide, replaceSlide."
    },
    expected: {
      isJson: true,
      containsAll: ["extractBulletNumbers", "generateChartHtml"]
    }
  },
  {
    id: "plan-04",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan an aesthetic-iteration loop.",
    input: {
      prompt: "You need to go through a 20-slide deck, score each slide aesthetically, and regenerate any slide scoring below 7. Output a JSON array describing the loop steps: { tool, args_summary }. Tools: listSlides, renderSlide, scoreSlide, regenerateSlide, replaceSlide."
    },
    expected: {
      isJson: true,
      containsAll: ["listSlides", "scoreSlide", "regenerateSlide"]
    }
  },
  {
    id: "plan-05",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "medium",
    description: "Plan translating a deck to another language.",
    input: {
      prompt: "You need to translate a 10-slide English deck to Spanish, preserving layout. Output a JSON array of steps: { tool, args_summary }. Tools: listSlides, extractText, translateText, replaceText."
    },
    expected: {
      isJson: true,
      containsAll: ["translateText", "replaceText"]
    }
  },
  {
    id: "plan-06",
    category: "action",
    subcategory: "agent_plan",
    difficulty: "hard",
    description: "Plan a rebranding pass.",
    input: {
      prompt: "A deck uses colors #3b82f6 (blue) and #f97316 (orange). Rebrand every slide to use #111827 (dark) and #10b981 (green). Output a JSON array of steps: { tool, args_summary }. Tools: listSlides, parseStyles, replaceColor, renderSlide, verifyContrast."
    },
    expected: {
      isJson: true,
      containsAll: ["replaceColor", "verifyContrast"]
    }
  },
  // ========== ACTION: REWRITE CONTENT (6) ==========
  {
    id: "rw-01",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Tighten a verbose bullet to 10 words or fewer.",
    input: {
      prompt: 'Rewrite this bullet to be 10 words or fewer while preserving the meaning: "We are in the process of exploring the possibility of potentially leveraging some form of AI-based approach to improve our customer onboarding experience." Output ONLY the rewritten bullet.'
    },
    expected: {
      containsAny: ["AI", "onboarding"],
      containsNone: ["in the process of"]
    }
  },
  {
    id: "rw-02",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "easy",
    description: "Fix grammar.",
    input: {
      prompt: 'Fix any grammar mistakes in this bullet: "The team are committed to ship there new product by end of Q3." Output ONLY the corrected bullet.'
    },
    expected: { containsAll: ["their"], containsNone: ["there new"] }
  },
  {
    id: "rw-03",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Add a concrete number to a vague claim.",
    input: {
      prompt: 'Rewrite this bullet to include a concrete placeholder number: "Our customers love our product." Use the format "X% of customers" with a realistic number. Output ONLY the rewritten bullet.'
    },
    expected: { containsAny: ["%"] }
  },
  {
    id: "rw-04",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Remove jargon.",
    input: {
      prompt: 'Rewrite this bullet to remove jargon and be understandable to a non-technical audience: "We leverage synergistic cross-functional paradigms to unblock key value-stream bottlenecks." Output ONLY the rewritten bullet.'
    },
    expected: {
      containsNone: ["synergistic", "paradigm", "leverage"]
    }
  },
  {
    id: "rw-05",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Enforce parallel structure.",
    input: {
      prompt: 'Rewrite these bullets to use parallel grammatical structure: ["Faster to deploy", "Scalability of the platform", "Cost reduction"]. Output a JSON array of strings.'
    },
    expected: {
      isJson: true
    }
  },
  {
    id: "rw-06",
    category: "action",
    subcategory: "rewrite_content",
    difficulty: "medium",
    description: "Convert passive voice to active.",
    input: {
      prompt: 'Rewrite this bullet in active voice: "Mistakes were made during the rollout by the deployment team." Output ONLY the rewritten bullet.'
    },
    expected: { containsAny: ["team made", "team caused", "team had", "deployment team made"] }
  }
];
if (EVAL_SET.length !== 100) {
  throw new Error(`EVAL_SET must have exactly 100 items, got ${EVAL_SET.length}`);
}
var ids = /* @__PURE__ */ new Set();
for (const it of EVAL_SET) {
  if (ids.has(it.id)) throw new Error(`Duplicate eval id: ${it.id}`);
  ids.add(it.id);
}
var visualCount = EVAL_SET.filter((i) => i.category === "visual").length;
var actionCount = EVAL_SET.filter((i) => i.category === "action").length;
if (visualCount !== 50 || actionCount !== 50) {
  throw new Error(`Expected 50/50 split, got visual=${visualCount} action=${actionCount}`);
}

// src/local_composer/scorer.ts
function scoreResponse(item, response) {
  const exp = item.expected;
  const text = response.trim();
  const textLc = text.toLowerCase();
  let score = 1;
  const reasons = [];
  if (exp.exact !== void 0) {
    if (text !== exp.exact) {
      score = 0;
      reasons.push(`expected exact="${exp.exact}", got "${text.slice(0, 64)}"`);
    }
  }
  if (exp.containsAll) {
    for (const s2 of exp.containsAll) {
      if (!textLc.includes(s2.toLowerCase())) {
        score = 0;
        reasons.push(`missing required substring "${s2}"`);
      }
    }
  }
  if (exp.containsAny) {
    const anyHit = exp.containsAny.some((s2) => textLc.includes(s2.toLowerCase()));
    if (!anyHit) {
      score = 0;
      reasons.push(`none of ${exp.containsAny.length} alternatives present`);
    }
  }
  if (exp.containsNone) {
    for (const s2 of exp.containsNone) {
      if (textLc.includes(s2.toLowerCase())) {
        score = 0;
        reasons.push(`forbidden substring "${s2}" present`);
      }
    }
  }
  if (exp.isJson) {
    try {
      JSON.parse(stripFences(text));
    } catch {
      score = 0;
      reasons.push("output is not valid JSON");
    }
  }
  if (exp.jsonPathEquals) {
    try {
      const parsed = JSON.parse(stripFences(text));
      const v = getPath(parsed, exp.jsonPathEquals.path);
      if (!exp.jsonPathEquals.values.some((target) => target === v)) {
        score = 0;
        reasons.push(`JSON path "${exp.jsonPathEquals.path}" = ${JSON.stringify(v)} not in expected values`);
      }
    } catch {
      score = 0;
      reasons.push("could not parse JSON for path check");
    }
  }
  if (exp.codeRuns) {
    if (!isSyntacticallyValidJs(stripFences(text))) {
      score = 0;
      reasons.push("code snippet does not parse as JavaScript");
    }
  }
  if (exp.numericRange) {
    const n = extractNumber(text);
    const [lo, hi] = exp.numericRange;
    if (n === null) {
      score = 0;
      reasons.push("no number extracted from output");
    } else if (n < lo || n > hi) {
      score = 0;
      reasons.push(`number ${n} outside [${lo}, ${hi}]`);
    }
  }
  return {
    score,
    reason: score === 1 ? "ok" : reasons.join("; ")
  };
}
function stripFences(s2) {
  const m = s2.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s2.trim();
}
function getPath(obj, path) {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}
function extractNumber(s2) {
  const m = s2.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function isSyntacticallyValidJs(code) {
  try {
    new Function("pptx", "slide", `return (async () => { ${code} })()`);
    return true;
  } catch {
    return false;
  }
}
function makeItemResult(item, response, meta) {
  const { score, reason } = scoreResponse(item, response);
  return {
    itemId: item.id,
    score,
    reason,
    response,
    latencyMs: meta.latencyMs,
    usage: { promptTokens: meta.promptTokens, completionTokens: meta.completionTokens },
    prefixHitTokens: meta.prefixHitTokens,
    imageCacheHit: meta.imageCacheHit
  };
}

// src/local_composer/harness.ts
async function runEval(opts) {
  const { adapter, renderSlideToPng: renderSlideToPng2 } = opts;
  const items = EVAL_SET.filter(opts.filter ?? (() => true));
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (!adapter.isReady()) {
    throw new Error("Adapter must be loaded before runEval()");
  }
  const results = [];
  for (const item of items) {
    const result = await runOneItem(adapter, item, renderSlideToPng2);
    results.push(result);
    opts.onItemComplete?.(result, item);
  }
  const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  return summarize(adapter, results, startedAt, finishedAt);
}
async function runOneItem(adapter, item, renderSlide) {
  const userMessage = {
    role: "user",
    content: buildUserPrompt(item),
    images: await buildImages(item, renderSlide)
  };
  const messages = [
    {
      role: "system",
      content: "You are a helpful, precise assistant evaluated on slide-building tasks. Follow the user's instructions literally. When asked for a specific format (JSON, code, single number), output ONLY that format with no preamble and no markdown fences."
    },
    userMessage
  ];
  const request = {
    messages,
    temperature: 0,
    maxTokens: item.maxTokens ?? 1024,
    seed: 42,
    timeoutMs: item.timeoutMs ?? 6e4
  };
  const resp = await adapter.generate(request);
  return makeItemResult(item, resp.message.content, {
    latencyMs: resp.latencyMs,
    promptTokens: resp.usage.promptTokens,
    completionTokens: resp.usage.completionTokens,
    prefixHitTokens: resp.prefixHitTokens,
    imageCacheHit: resp.imageCacheHit
  });
}
function buildUserPrompt(item) {
  let prompt = item.input.prompt;
  if (item.input.code !== void 0) {
    prompt += `

\`\`\`js
${item.input.code}
\`\`\``;
  }
  if (item.input.context) {
    prompt += `

${JSON.stringify(item.input.context, null, 2)}`;
  }
  if (item.input.slideHtmlB !== void 0) {
    prompt += "\n\n(Slide A is the first image, Slide B is the second image.)";
  }
  return prompt;
}
async function buildImages(item, renderSlide) {
  const images = [];
  if (item.input.slideHtml) {
    const img = await renderSlide(item.input.slideHtml);
    if (img) images.push(img);
  }
  if (item.input.slideHtmlB) {
    const img = await renderSlide(item.input.slideHtmlB);
    if (img) images.push(img);
  }
  return images;
}
function summarize(adapter, results, startedAt, finishedAt) {
  const total = results.length;
  const passed = results.filter((r) => r.score >= 0.5).length;
  const scoreMean = total > 0 ? results.reduce((a, r) => a + r.score, 0) / total : 0;
  const byCategory = {
    visual: { total: 0, scoreMean: 0 },
    action: { total: 0, scoreMean: 0 }
  };
  const bySub = {};
  for (const r of results) {
    const item = findItem(r.itemId);
    byCategory[item.category].total += 1;
    byCategory[item.category].scoreMean += r.score;
    const key = item.subcategory;
    const prev = bySub[key] ?? { total: 0, scoreMean: 0, sum: 0 };
    prev.total += 1;
    prev.sum += r.score;
    bySub[key] = prev;
  }
  for (const k of Object.keys(byCategory)) {
    if (byCategory[k].total > 0) byCategory[k].scoreMean /= byCategory[k].total;
  }
  const finalBySub = {};
  for (const [k, v] of Object.entries(bySub)) {
    finalBySub[k] = { total: v.total, scoreMean: v.sum / v.total };
  }
  const totalLatencyMs = results.reduce((a, r) => a + r.latencyMs, 0);
  const totalTokens = results.reduce((a, r) => a + r.usage.promptTokens + r.usage.completionTokens, 0);
  const totalPromptTokens = results.reduce((a, r) => a + r.usage.promptTokens, 0);
  const totalPrefixHit = results.reduce((a, r) => a + r.prefixHitTokens, 0);
  const avgPrefixHitRate = totalPromptTokens > 0 ? totalPrefixHit / totalPromptTokens : 0;
  return {
    modelId: adapter.modelInfo.id,
    modelDisplayName: adapter.modelInfo.displayName,
    startedAt,
    finishedAt,
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
      scoreMean,
      byCategory,
      bySubcategory: finalBySub,
      totalLatencyMs,
      totalTokens,
      avgPrefixHitRate
    }
  };
}
function findItem(id) {
  const item = EVAL_SET.find((i) => i.id === id);
  if (!item) throw new Error(`Unknown item id: ${id}`);
  return item;
}

// src/local_composer/radix-cache.ts
function makeNode(edge) {
  return {
    edge,
    kv: null,
    lastUsedMs: 0,
    insertedMs: 0,
    sizeBytes: 0,
    children: /* @__PURE__ */ new Map()
  };
}
var RadixCache = class {
  root = makeNode([]);
  totalBytes = 0;
  ttlMs;
  maxBytes;
  now;
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 6e4;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 ** 3;
    this.now = opts.now ?? Date.now;
  }
  /**
   * Walk the tree greedy-matching the longest prefix of `tokens`.
   * Returns how many tokens matched and the handle of the deepest hit node.
   */
  lookup(tokens) {
    this.evictExpired();
    let node = this.root;
    let cursor = 0;
    let lastHit = null;
    while (cursor < tokens.length) {
      const child = node.children.get(tokens[cursor]);
      if (!child) break;
      let edgeCursor = 0;
      while (edgeCursor < child.edge.length && cursor + edgeCursor < tokens.length && child.edge[edgeCursor] === tokens[cursor + edgeCursor]) {
        edgeCursor++;
      }
      if (edgeCursor < child.edge.length) {
        break;
      }
      cursor += edgeCursor;
      node = child;
      if (node.kv) {
        lastHit = { node, at: cursor };
        node.lastUsedMs = this.now();
      }
    }
    if (!lastHit) return { matchedTokens: 0, handle: null };
    return { matchedTokens: lastHit.at, handle: lastHit.node.kv?.handle ?? null };
  }
  /**
   * Insert `tokens → handle`. Splits edges as needed. Fires eviction.
   */
  insert(tokens, kv) {
    let node = this.root;
    let cursor = 0;
    while (cursor < tokens.length) {
      const child = node.children.get(tokens[cursor]);
      if (!child) {
        const leaf = makeNode(tokens.slice(cursor));
        leaf.kv = kv;
        leaf.sizeBytes = kv.sizeBytes;
        leaf.insertedMs = this.now();
        leaf.lastUsedMs = leaf.insertedMs;
        node.children.set(tokens[cursor], leaf);
        this.totalBytes += kv.sizeBytes;
        this.enforceBudget();
        return;
      }
      let edgeCursor = 0;
      while (edgeCursor < child.edge.length && cursor + edgeCursor < tokens.length && child.edge[edgeCursor] === tokens[cursor + edgeCursor]) {
        edgeCursor++;
      }
      if (edgeCursor === child.edge.length) {
        cursor += edgeCursor;
        node = child;
        continue;
      }
      const splitPrefix = child.edge.slice(0, edgeCursor);
      const splitSuffix = child.edge.slice(edgeCursor);
      const oldChildTail = makeNode(splitSuffix);
      oldChildTail.kv = child.kv;
      oldChildTail.sizeBytes = child.sizeBytes;
      oldChildTail.insertedMs = child.insertedMs;
      oldChildTail.lastUsedMs = child.lastUsedMs;
      oldChildTail.children = child.children;
      child.edge = splitPrefix;
      child.kv = null;
      child.sizeBytes = 0;
      child.children = /* @__PURE__ */ new Map([[splitSuffix[0], oldChildTail]]);
      cursor += edgeCursor;
      node = child;
    }
    if (node.kv) this.totalBytes -= node.kv.sizeBytes;
    node.kv = kv;
    node.sizeBytes = kv.sizeBytes;
    node.insertedMs = this.now();
    node.lastUsedMs = node.insertedMs;
    this.totalBytes += kv.sizeBytes;
    this.enforceBudget();
  }
  /** Drop everything. Used on model swap. */
  clear() {
    this.root = makeNode([]);
    this.totalBytes = 0;
  }
  /** Total bytes currently tracked by the cache. */
  byteSize() {
    return this.totalBytes;
  }
  /** Evict entries older than ttl. */
  evictExpired() {
    const cutoff = this.now() - this.ttlMs;
    this.walkAndEvict((n) => n.insertedMs > 0 && n.insertedMs < cutoff);
  }
  /** Evict LRU entries until under budget. */
  enforceBudget() {
    if (this.totalBytes <= this.maxBytes) return;
    const all = [];
    const walk = (n) => {
      if (n.kv) all.push(n);
      for (const c of n.children.values()) walk(c);
    };
    walk(this.root);
    all.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    for (const n of all) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= n.sizeBytes;
      n.kv = null;
      n.sizeBytes = 0;
    }
  }
  /** Walk and null out KV on nodes matching predicate. */
  walkAndEvict(shouldEvict) {
    const walk = (n) => {
      if (n.kv && shouldEvict(n)) {
        this.totalBytes -= n.sizeBytes;
        n.kv = null;
        n.sizeBytes = 0;
      }
      for (const c of n.children.values()) walk(c);
    };
    walk(this.root);
  }
};

// src/local_composer/image-cache.ts
var ImageCache = class {
  map = /* @__PURE__ */ new Map();
  totalBytes = 0;
  ttlMs;
  maxBytes;
  now;
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 6e4;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 ** 3;
    this.now = opts.now ?? Date.now;
  }
  get(sha256) {
    this.evictExpired();
    const e = this.map.get(sha256);
    if (!e) return null;
    e.lastUsedMs = this.now();
    return e.emb;
  }
  put(sha256, emb) {
    const existing = this.map.get(sha256);
    if (existing) {
      this.totalBytes -= existing.emb.sizeBytes;
    }
    const now = this.now();
    this.map.set(sha256, { emb, lastUsedMs: now, insertedMs: now });
    this.totalBytes += emb.sizeBytes;
    this.enforceBudget();
  }
  has(sha256) {
    return this.map.has(sha256);
  }
  size() {
    return this.map.size;
  }
  byteSize() {
    return this.totalBytes;
  }
  clear() {
    this.map.clear();
    this.totalBytes = 0;
  }
  evictExpired() {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of this.map) {
      if (e.insertedMs < cutoff) {
        this.totalBytes -= e.emb.sizeBytes;
        this.map.delete(k);
      }
    }
  }
  enforceBudget() {
    if (this.totalBytes <= this.maxBytes) return;
    const entries = [...this.map.entries()].sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
    for (const [k, e] of entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.totalBytes -= e.emb.sizeBytes;
      this.map.delete(k);
    }
  }
};
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SubtleCrypto not available");
  const buf = bytes.slice().buffer;
  const digest = await subtle.digest("SHA-256", buf);
  const arr = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

// src/local_composer/transformers-js-adapter.ts
var TransformersJsAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.modelInfo = MODEL_INFO[opts.modelId] ?? {
      id: opts.modelId,
      displayName: opts.modelId,
      vramBytes: 0,
      supportsVision: true,
      supportsTools: false,
      // most HF exports do not natively emit tool calls
      contextWindow: 8192
    };
  }
  opts;
  modelInfo;
  pipe = null;
  kv = new RadixCache();
  imgCache = new ImageCache();
  async loadModel(onProgress) {
    if (this.pipe) return;
    const mod = await import("@huggingface/transformers");
    this.pipe = await mod.pipeline("image-text-to-text", this.opts.modelId, {
      device: this.opts.device ?? "webgpu",
      dtype: this.opts.dtype ?? "q4",
      progress_callback: (r) => {
        onProgress?.({
          progress: r.progress ?? 0,
          stage: `${r.status}${r.file ? " " + r.file : ""}`
        });
      }
    });
  }
  isReady() {
    return this.pipe !== null;
  }
  async generate(request) {
    if (!this.pipe) throw new Error("TransformersJsAdapter: loadModel() not called");
    const start = performance.now();
    const hfMessages = request.messages.map((m) => {
      const content = [];
      for (const img of m.images ?? []) content.push({ type: "image", image: img.url });
      content.push({ type: "text", text: m.content });
      return { role: m.role, content };
    });
    const tokens = surrogateTokenize(request.messages);
    const hit = this.kv.lookup(tokens);
    let imageCacheHit = false;
    for (const m of request.messages) {
      for (const img of m.images ?? []) {
        if (this.imgCache.has(img.sha256)) {
          imageCacheHit = true;
        } else {
          const emb = { handle: null, sizeBytes: 1024 * 1024 };
          this.imgCache.put(img.sha256, emb);
        }
      }
    }
    const out = await this.pipe(hfMessages, {
      max_new_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0,
      do_sample: (request.temperature ?? 0) > 0
    });
    const text = out[0]?.generated_text ?? "";
    const handle = {
      handle: { kind: "transformers-js" },
      sizeBytes: tokens.length * 512
    };
    this.kv.insert(tokens, handle);
    return {
      message: { role: "assistant", content: text },
      usage: { promptTokens: tokens.length, completionTokens: text.split(/\s+/).filter(Boolean).length },
      latencyMs: performance.now() - start,
      prefixHitTokens: hit.matchedTokens,
      imageCacheHit
    };
  }
  async dispose() {
    this.pipe = null;
    this.kv.clear();
    this.imgCache.clear();
  }
};
function surrogateTokenize(messages) {
  const parts = [];
  for (const m of messages) {
    parts.push(`<${m.role}>`);
    parts.push(m.content);
    if (m.images) for (const img of m.images) parts.push(`<img:${img.sha256}>`);
  }
  const words = parts.join(" ").split(/\s+/).filter(Boolean);
  return words.map((w) => {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = (h << 5) + h + w.charCodeAt(i) | 0;
    return h >>> 0;
  });
}
var MODEL_INFO = {
  "onnx-community/Qwen2.5-VL-7B-Instruct": {
    id: "onnx-community/Qwen2.5-VL-7B-Instruct",
    displayName: "Qwen2.5-VL 7B Instruct (ONNX)",
    vramBytes: 5.5 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 32768
  },
  "onnx-community/Qwen2.5-VL-3B-Instruct": {
    id: "onnx-community/Qwen2.5-VL-3B-Instruct",
    displayName: "Qwen2.5-VL 3B Instruct (ONNX)",
    vramBytes: 2.8 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 32768
  },
  "HuggingFaceTB/SmolVLM2-2.2B-Instruct": {
    id: "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
    displayName: "SmolVLM2 2.2B Instruct",
    vramBytes: 1.5 * 1024 ** 3,
    supportsVision: true,
    supportsTools: false,
    contextWindow: 8192
  },
  "vikhyatk/moondream2": {
    id: "vikhyatk/moondream2",
    displayName: "Moondream 2",
    vramBytes: 1.3 * 1024 ** 3,
    supportsVision: true,
    supportsTools: false,
    contextWindow: 2048
  }
};

// src/local_composer/webllm-adapter.ts
var WebLLMAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.modelInfo = MODEL_INFO2[opts.modelId] ?? {
      id: opts.modelId,
      displayName: opts.modelId,
      vramBytes: 0,
      supportsVision: opts.modelId.toLowerCase().includes("vision"),
      supportsTools: true,
      contextWindow: 8192
    };
  }
  opts;
  modelInfo;
  engine = null;
  kv = new RadixCache();
  imgCache = new ImageCache();
  lastPromptTokens = [];
  async loadModel(onProgress) {
    if (this.engine) return;
    const mod = await import("@mlc-ai/web-llm");
    this.engine = await mod.CreateMLCEngine(this.opts.modelId, {
      initProgressCallback: (r) => onProgress?.({ progress: r.progress, stage: r.text })
    });
  }
  isReady() {
    return this.engine !== null;
  }
  async generate(request) {
    if (!this.engine) throw new Error("WebLLMAdapter: loadModel() not called");
    const start = performance.now();
    const tokens = surrogateTokenize2(request.messages);
    const hit = this.kv.lookup(tokens);
    const webllmMessages = request.messages.map((m) => ({
      role: m.role,
      content: m.images && m.images.length > 0 ? [
        ...m.images.map((img) => ({ type: "image_url", image_url: { url: img.url } })),
        { type: "text", text: m.content }
      ] : m.content
    }));
    const resp = await this.engine.chat.completions.create({
      messages: webllmMessages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 1024,
      seed: request.seed
    });
    const text = resp.choices[0]?.message.content ?? "";
    const usage = resp.usage ?? { prompt_tokens: tokens.length, completion_tokens: 0 };
    const handle = {
      handle: { engineRef: this.engine },
      sizeBytes: tokens.length * 512
      // rough 0.5 KB/token for a 7B q4 model
    };
    this.kv.insert(tokens, handle);
    this.lastPromptTokens = tokens;
    const assistantMessage = { role: "assistant", content: text };
    return {
      message: assistantMessage,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens
      },
      latencyMs: performance.now() - start,
      prefixHitTokens: hit.matchedTokens,
      imageCacheHit: request.messages.some(
        (m) => m.images?.some((i) => this.imgCache.has(i.sha256)) ?? false
      )
    };
  }
  async dispose() {
    await this.engine?.unload();
    this.engine = null;
    this.kv.clear();
    this.imgCache.clear();
    this.lastPromptTokens = [];
  }
};
function surrogateTokenize2(messages) {
  const parts = [];
  for (const m of messages) {
    parts.push(`<${m.role}>`);
    parts.push(m.content);
    if (m.images) for (const img of m.images) parts.push(`<img:${img.sha256}>`);
  }
  const words = parts.join(" ").split(/\s+/).filter(Boolean);
  return words.map(djb2);
}
function djb2(s2) {
  let h = 5381;
  for (let i = 0; i < s2.length; i++) h = (h << 5) + h + s2.charCodeAt(i) | 0;
  return h >>> 0;
}
var MODEL_INFO2 = {
  "Phi-3.5-vision-instruct-q4f16_1-MLC": {
    id: "Phi-3.5-vision-instruct-q4f16_1-MLC",
    displayName: "Phi-3.5 Vision Instruct (q4f16)",
    vramBytes: 3.95 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 4096
  },
  "Phi-3.5-vision-instruct-q4f32_1-MLC": {
    id: "Phi-3.5-vision-instruct-q4f32_1-MLC",
    displayName: "Phi-3.5 Vision Instruct (q4f32)",
    vramBytes: 5.88 * 1024 ** 3,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 4096
  }
};

// src/local_composer/mock-adapter.ts
var MockAdapter = class {
  modelInfo = {
    id: "mock-vlm",
    displayName: "Mock VLM (unit tests)",
    vramBytes: 0,
    supportsVision: true,
    supportsTools: true,
    contextWindow: 8192
  };
  ready = false;
  scripts;
  lastPromptTokens = [];
  // Deterministic pseudo-tokenizer: hash words → 32-bit ints, stable across runs.
  tokenize(msgs) {
    const text = msgs.map((m) => `${m.role}:${m.content}${m.images?.map((i) => `[img:${i.sha256}]`).join("") ?? ""}`).join("\n");
    const words = text.split(/\s+/).filter(Boolean);
    return words.map((w) => {
      let h = 5381;
      for (let i = 0; i < w.length; i++) h = (h << 5) + h + w.charCodeAt(i) | 0;
      return h >>> 0;
    });
  }
  constructor(scripts = []) {
    this.scripts = scripts;
  }
  async loadModel(onProgress) {
    onProgress?.({ progress: 0.5, stage: "mock-loading" });
    onProgress?.({ progress: 1, stage: "ready" });
    this.ready = true;
  }
  isReady() {
    return this.ready;
  }
  async generate(request) {
    if (!this.ready) throw new Error("MockAdapter: loadModel() not called");
    const start = Date.now();
    const tokens = this.tokenize(request.messages);
    let hit = 0;
    while (hit < tokens.length && hit < this.lastPromptTokens.length && tokens[hit] === this.lastPromptTokens[hit]) {
      hit++;
    }
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    const script = this.scripts.find((s2) => userText.includes(s2.match));
    let responseText;
    let toolCalls;
    if (script) {
      responseText = script.response;
      toolCalls = script.toolCalls;
    } else if (request.jsonMode) {
      responseText = JSON.stringify({ ok: true, echo: userText.slice(0, 64) });
    } else {
      responseText = `mock response to: ${userText.slice(0, 64)}`;
    }
    const response = {
      message: {
        role: "assistant",
        content: responseText,
        toolCalls
      },
      usage: {
        promptTokens: tokens.length,
        completionTokens: responseText.split(/\s+/).filter(Boolean).length
      },
      latencyMs: Date.now() - start,
      prefixHitTokens: hit,
      imageCacheHit: false
    };
    this.lastPromptTokens = tokens;
    return response;
  }
  async dispose() {
    this.ready = false;
    this.lastPromptTokens = [];
  }
};

// src/local_composer/browser-harness.ts
function createAdapter(opts) {
  if (opts.adapterKind === "webllm") {
    return new WebLLMAdapter({ modelId: opts.modelId });
  }
  if (opts.adapterKind === "mock") {
    return new MockAdapter();
  }
  return new TransformersJsAdapter({ modelId: opts.modelId, device: "webgpu", dtype: "q4" });
}
async function renderBlankPng(tag) {
  const canvas = new OffscreenCanvas(1920, 1080);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.fillStyle = "#0b0f19";
  ctx.font = "32px system-ui";
  ctx.fillText(`[fallback render] ${tag.slice(0, 200)}`, 32, 64);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha = await sha256Hex(bytes);
  const dataUrl = await blobToDataUrl(blob);
  return { sha256: sha, url: dataUrl, width: 1920, height: 1080 };
}
async function renderSlideToPng(html) {
  const sandbox = document.getElementById("render-sandbox");
  if (!sandbox) return null;
  const iframe = document.createElement("iframe");
  iframe.style.width = "1920px";
  iframe.style.height = "1080px";
  iframe.style.border = "0";
  sandbox.innerHTML = "";
  sandbox.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${html}</body></html>`
  );
  doc.close();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("xmlns", svgNs);
  svg.setAttribute("width", "1920");
  svg.setAttribute("height", "1080");
  const fo = document.createElementNS(svgNs, "foreignObject");
  fo.setAttribute("width", "100%");
  fo.setAttribute("height", "100%");
  const div = document.createElement("div");
  div.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  div.innerHTML = html;
  fo.appendChild(div);
  svg.appendChild(fo);
  const svgStr = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.width = 1920;
    img.height = 1080;
    img.src = svgUrl;
    await img.decode();
    const canvas = new OffscreenCanvas(1920, 1080);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.drawImage(img, 0, 0, 1920, 1080);
    try {
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha = await sha256Hex(bytes);
      const dataUrl = await blobToDataUrl(blob);
      return { sha256: sha, url: dataUrl, width: 1920, height: 1080 };
    } catch (e) {
      return renderBlankPng(html);
    }
  } finally {
    URL.revokeObjectURL(svgUrl);
    sandbox.removeChild(iframe);
  }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
window.__localComposer = {
  async runEval(opts) {
    const status = document.getElementById("status");
    const progress = document.getElementById("progress");
    if (status) status.textContent = `Loading ${opts.modelId} (${opts.adapterKind})\u2026`;
    const adapter = createAdapter(opts);
    await adapter.loadModel((p) => {
      if (status) status.textContent = `[${(p.progress * 100).toFixed(0)}%] ${p.stage}`;
    });
    const limit = opts.limit;
    if (status) {
      status.textContent = `Running ${limit ?? 100} items against ${opts.modelId}\u2026`;
    }
    let seen = 0;
    const report = await runEval({
      adapter,
      renderSlideToPng,
      filter: limit ? () => seen++ < limit : void 0,
      onItemComplete: (r, item) => {
        if (!progress) return;
        const line = document.createElement("div");
        line.className = r.score >= 0.5 ? "ok" : "bad";
        line.textContent = `${item.id.padEnd(18)} ${r.score >= 0.5 ? "PASS" : "FAIL"} ${r.reason}`;
        progress.appendChild(line);
        progress.scrollTop = progress.scrollHeight;
      }
    });
    if (status) {
      status.textContent = `Done. ${report.summary.passed}/${report.summary.total} passed (mean score ${report.summary.scoreMean.toFixed(3)})`;
    }
    await adapter.dispose();
    return report;
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZXZhbC1zZXQudHMiLCAic2NvcmVyLnRzIiwgImhhcm5lc3MudHMiLCAicmFkaXgtY2FjaGUudHMiLCAiaW1hZ2UtY2FjaGUudHMiLCAidHJhbnNmb3JtZXJzLWpzLWFkYXB0ZXIudHMiLCAid2VibGxtLWFkYXB0ZXIudHMiLCAibW9jay1hZGFwdGVyLnRzIiwgImJyb3dzZXItaGFybmVzcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUaGUgMTAwLWl0ZW0gZXZhbHVhdGlvbiBzZXQgZm9yIGluLWJyb3dzZXIgc2xpZGUtYWdlbnQgVkxNcy5cbiAqXG4gKiA1MCB2aXN1YWwgaXRlbXMgKyA1MCBhY3Rpb24gaXRlbXMsIGRpc3RyaWJ1dGVkIGFjcm9zcyB0aGUgc3ViY2F0ZWdvcmllc1xuICogdGhhdCBtYXR0ZXIgZm9yIGEgbWFudXMuaW0tc3R5bGUgcHJlc2VudGF0aW9uIGFnZW50OlxuICpcbiAqIFZpc3VhbCAoNTApOlxuICogICAxMCBvY3IgICAgICAgICAgICAgXHUyMDE0IGNhbiB0aGUgbW9kZWwgcmVhZCB0ZXh0IG9mZiBhIHNsaWRlIHNjcmVlbnNob3Q/XG4gKiAgICA4IGxheW91dF9jbGFzc2lmeSBcdTIwMTQgdGl0bGVfb25seSAvIHRpdGxlX2FuZF9ib2R5IC8gdHdvX2NvbHVtbiAvIC4uLlxuICogICAgOCBjaGFydF9yZWFkICAgICAgXHUyMDE0IHJlYWQgYmFyIGhlaWdodHMsIGlkZW50aWZ5IHRyZW5kcywgZmluZCBtYXgvbWluXG4gKiAgICA2IHN0eWxlX2RldGVjdCAgICBcdTIwMTQgYnJhbmQgY29sb3IsIGJhY2tncm91bmQsIGFsaWdubWVudCwgb3ZlcmZsb3dcbiAqICAgIDYgZWxlbWVudF9jb3VudCAgIFx1MjAxNCBidWxsZXRzLCBpbWFnZXMsIGNvbHVtbnMsIHRhYmxlIHJvd3NcbiAqICAgIDYgZGlmZl9kZXRlY3QgICAgIFx1MjAxNCBiZWZvcmUvYWZ0ZXIgcGFpciwgcmVwb3J0IHRoZSBjaGFuZ2VcbiAqICAgIDYgYWVzdGhldGljX3Njb3JlIFx1MjAxNCByYXRlIHZpc3VhbCBxdWFsaXR5IDAtMTAgd2l0aCBydWJyaWNcbiAqXG4gKiBBY3Rpb24gKDUwKTpcbiAqICAgMTAgZ2VuZXJhdGVfaHRtbCAgICAgXHUyMDE0IHRvcGljICsgbGF5b3V0IFx1MjE5MiBmdWxsIDxzZWN0aW9uPiBIVE1MXG4gKiAgICA2IHBpY2tfbGF5b3V0ICAgICAgIFx1MjAxNCBjb250ZW50IGRlc2NyaXB0aW9uIFx1MjE5MiBsYXlvdXQgY2xhc3NcbiAqICAgIDggd3JpdGVfcHB0eGdlbmpzICAgXHUyMDE0IHNsaWRlIHNwZWMgXHUyMTkyIHJ1bm5hYmxlIEpTIGNvZGVcbiAqICAgIDYgZml4X2J1ZyAgICAgICAgICAgXHUyMDE0IGJyb2tlbiBzbGlkZSBjb2RlIFx1MjE5MiBmaXhlZCBjb2RlXG4gKiAgICA4IGVkaXRfb3AgICAgICAgICAgIFx1MjAxNCBjdXJyZW50IHNsaWRlICsgaW5zdHJ1Y3Rpb24gXHUyMTkyIG5ldyBzbGlkZVxuICogICAgNiBhZ2VudF9wbGFuICAgICAgICBcdTIwMTQgZ29hbCBcdTIxOTIgbXVsdGktc3RlcCBwbGFuIChKU09OIGFycmF5KVxuICogICAgNiByZXdyaXRlX2NvbnRlbnQgICBcdTIwMTQgdmVyYm9zZSBidWxsZXQgXHUyMTkyIHRpZ2h0IGJ1bGxldFxuICpcbiAqIEhUTUwgc3RyaW5ncyBhcmUgZGVsaWJlcmF0ZWx5IHNtYWxsIGFuZCBzZWxmLWNvbnRhaW5lZDsgdGhlIGhhcm5lc3NcbiAqIHJlbmRlcnMgZWFjaCBvbmUgaW50byBhIDE5MjBcdTAwRDcxMDgwIFBORyBiZWZvcmUgdGhlIGNhbGwsIHNvIHdoYXQgdGhlXG4gKiBtb2RlbCBzZWVzIGlzIGEgcmVhbCByYXN0ZXJpemVkIHNsaWRlIFx1MjAxNCBub3QgcmF3IEhUTUwuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFdmFsSXRlbSB9IGZyb20gXCIuL2V2YWwtdHlwZXMuanNcIjtcblxuLy8gLS0tLSBIVE1MIGhlbHBlcnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgU0xJREVfQkFTRSA9XG4gICd3aWR0aDoxOTIwcHg7aGVpZ2h0OjEwODBweDtiYWNrZ3JvdW5kOiNmZmY7Zm9udC1mYW1pbHk6SW50ZXIsc3lzdGVtLXVpLHNhbnMtc2VyaWY7Y29sb3I6IzExMTtwYWRkaW5nOjgwcHg7Ym94LXNpemluZzpib3JkZXItYm94JztcblxuY29uc3QgcyA9IChpbm5lcjogc3RyaW5nLCBleHRyYSA9IFwiXCIpOiBzdHJpbmcgPT5cbiAgYDxzZWN0aW9uIHN0eWxlPVwiJHtTTElERV9CQVNFfTske2V4dHJhfVwiPiR7aW5uZXJ9PC9zZWN0aW9uPmA7XG5cbmNvbnN0IHRpdGxlID0gKHQ6IHN0cmluZyk6IHN0cmluZyA9PlxuICBgPGgxIHN0eWxlPVwiZm9udC1zaXplOjg4cHg7Zm9udC13ZWlnaHQ6NjAwO21hcmdpbjowIDAgNDBweCAwXCI+JHt0fTwvaDE+YDtcblxuY29uc3QgYm9keSA9ICh0OiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgYDxwIHN0eWxlPVwiZm9udC1zaXplOjM2cHg7bGluZS1oZWlnaHQ6MS40O21hcmdpbjowXCI+JHt0fTwvcD5gO1xuXG5jb25zdCBidWxsZXRzID0gKGl0ZW1zOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyA9PlxuICBgPHVsIHN0eWxlPVwiZm9udC1zaXplOjM2cHg7bGluZS1oZWlnaHQ6MS42O21hcmdpbjowO3BhZGRpbmctbGVmdDo0OHB4XCI+JHtpdGVtcy5tYXAoKGIpID0+IGA8bGk+JHtifTwvbGk+YCkuam9pbihcIlwiKX08L3VsPmA7XG5cbmNvbnN0IGJhcnMgPSAodmFsdWVzOiByZWFkb25seSB7IGxhYmVsOiBzdHJpbmc7IGhlaWdodDogbnVtYmVyOyBjb2xvcj86IHN0cmluZyB9W10pOiBzdHJpbmcgPT4ge1xuICBjb25zdCBtYXhIID0gTWF0aC5tYXgoLi4udmFsdWVzLm1hcCgodikgPT4gdi5oZWlnaHQpKTtcbiAgY29uc3QgYmFyVyA9IE1hdGguZmxvb3IoMTYwMCAvIHZhbHVlcy5sZW5ndGgpIC0gNDA7XG4gIGNvbnN0IGJhcnMgPSB2YWx1ZXNcbiAgICAubWFwKCh2LCBpKSA9PiB7XG4gICAgICBjb25zdCBoID0gTWF0aC5mbG9vcigodi5oZWlnaHQgLyBtYXhIKSAqIDYwMCk7XG4gICAgICBjb25zdCB4ID0gODAgKyBpICogKGJhclcgKyA0MCk7XG4gICAgICBjb25zdCB5ID0gOTAwIC0gaDtcbiAgICAgIGNvbnN0IGNvbG9yID0gdi5jb2xvciA/PyBcIiMzYjgyZjZcIjtcbiAgICAgIHJldHVybiBgPHJlY3QgeD1cIiR7eH1cIiB5PVwiJHt5fVwiIHdpZHRoPVwiJHtiYXJXfVwiIGhlaWdodD1cIiR7aH1cIiBmaWxsPVwiJHtjb2xvcn1cIi8+PHRleHQgeD1cIiR7eCArIGJhclcgLyAyfVwiIHk9XCI5NjBcIiB0ZXh0LWFuY2hvcj1cIm1pZGRsZVwiIGZvbnQtc2l6ZT1cIjI4XCIgZm9udC1mYW1pbHk9XCJJbnRlclwiPiR7di5sYWJlbH08L3RleHQ+PHRleHQgeD1cIiR7eCArIGJhclcgLyAyfVwiIHk9XCIke3kgLSAxMH1cIiB0ZXh0LWFuY2hvcj1cIm1pZGRsZVwiIGZvbnQtc2l6ZT1cIjI4XCIgZm9udC1mYW1pbHk9XCJJbnRlclwiIGZvbnQtd2VpZ2h0PVwiNjAwXCI+JHt2LmhlaWdodH08L3RleHQ+YDtcbiAgICB9KVxuICAgIC5qb2luKFwiXCIpO1xuICByZXR1cm4gYDxzdmcgdmlld0JveD1cIjAgMCAxOTIwIDEwODBcIiB3aWR0aD1cIjE5MjBcIiBoZWlnaHQ9XCIxMDgwXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiPjx0ZXh0IHg9XCI4MFwiIHk9XCI4MFwiIGZvbnQtc2l6ZT1cIjU2XCIgZm9udC1mYW1pbHk9XCJJbnRlclwiIGZvbnQtd2VpZ2h0PVwiNjAwXCI+TW9udGhseSBSZXZlbnVlPC90ZXh0PiR7YmFyc308L3N2Zz5gO1xufTtcblxuLy8gLS0tLSBUaGUgMTAwIGl0ZW1zIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGNvbnN0IEVWQUxfU0VUOiByZWFkb25seSBFdmFsSXRlbVtdID0gW1xuICAvLyA9PT09PT09PT09IFZJU1VBTDogT0NSICgxMCkgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwidmlzLW9jci0wMVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcIm9jclwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWQgYSBzaW5nbGUgc2xpZGUgdGl0bGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGF0IGlzIHRoZSB0aXRsZSBvZiB0aGlzIHNsaWRlPyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSB0aXRsZSB0ZXh0LlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKHRpdGxlKFwiSW50cm9kdWN0aW9uXCIpKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJJbnRyb2R1Y3Rpb25cIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1vY3ItMDJcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJvY3JcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJSZWFkIGEgdmVyc2lvbiBudW1iZXIgZnJvbSBib2R5IHRleHQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGF0IHZlcnNpb24gbnVtYmVyIGlzIG1lbnRpb25lZCBvbiB0aGlzIHNsaWRlP1wiLFxuICAgICAgc2xpZGVIdG1sOiBzKHRpdGxlKFwiUmVsZWFzZSBOb3Rlc1wiKSArIGJvZHkoXCJXZSBzaGlwcGVkIHYyLjQgbGFzdCB3ZWVrIHdpdGggbWFqb3IgcGVyZm9ybWFuY2UgaW1wcm92ZW1lbnRzLlwiKSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiMi40XCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtb2NyLTAzXCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwib2NyXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJSZWFkIHRoZSB0aGlyZCBidWxsZXQgb2YgYSBmaXZlLWJ1bGxldCBsaXN0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hhdCBpcyB0aGUgdGhpcmQgYnVsbGV0IGluIHRoZSBsaXN0IG9uIHRoaXMgc2xpZGU/IEFuc3dlciB3aXRoIG9ubHkgdGhhdCBidWxsZXQuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiQWdlbmRhXCIpICtcbiAgICAgICAgICBidWxsZXRzKFtcIk1hcmtldCBvdmVydmlld1wiLCBcIlByb2R1Y3Qgcm9hZG1hcFwiLCBcIlByaWNpbmcgc3RyYXRlZ3lcIiwgXCJIaXJpbmcgcGxhblwiLCBcIlEmQVwiXSksXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcIlByaWNpbmdcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1vY3ItMDRcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJvY3JcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWQgYSBkb2xsYXIgdmFsdWUgZnJvbSBwcm9zZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoYXQgcmV2ZW51ZSBudW1iZXIgaXMgcmVwb3J0ZWQgb24gdGhpcyBzbGlkZT9cIixcbiAgICAgIHNsaWRlSHRtbDogcyh0aXRsZShcIlEzIFJlc3VsdHNcIikgKyBib2R5KFwiUmV2ZW51ZSByZWFjaGVkICQ0LjJNIHRoaXMgcXVhcnRlciwgdXAgNDIlIHllYXItb3Zlci15ZWFyLlwiKSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiNC4yXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtb2NyLTA1XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwib2NyXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhZCBhIHNtYWxsIGZvb3RlciBjaXRhdGlvbi5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIlJlYWQgdGhlIGNpdGF0aW9uIHNvdXJjZSBpbiB0aGUgZm9vdGVyIGF0IHRoZSBib3R0b20gb2YgdGhlIHNsaWRlLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICB0aXRsZShcIk1hcmtldCBTaXplXCIpICtcbiAgICAgICAgICBib2R5KFwiVGhlIGdsb2JhbCB3aWRnZXQgbWFya2V0IHJlYWNoZWQgJDEyMEIgaW4gMjAyNC5cIikgK1xuICAgICAgICAgICc8cCBzdHlsZT1cInBvc2l0aW9uOmFic29sdXRlO2JvdHRvbTo0MHB4O2xlZnQ6ODBweDtmb250LXNpemU6MThweDtjb2xvcjojODg4XCI+U291cmNlOiBTdGF0aXN0YSAyMDI1PC9wPicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcIlN0YXRpc3RhXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtb2NyLTA2XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwib2NyXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhZCBhIHN1YnRpdGxlIGJlbmVhdGggYSB0aXRsZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoYXQgaXMgdGhlIHN1YnRpdGxlIG9mIHRoaXMgc2xpZGU/XCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiUHJvamVjdCBQaG9lbml4XCIpICtcbiAgICAgICAgICAnPHAgc3R5bGU9XCJmb250LXNpemU6NDRweDtjb2xvcjojNjY2O21hcmdpbjowXCI+UmVidWlsZGluZyBmcm9tIHRoZSBncm91bmQgdXA8L3A+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FueTogW1wiUmVidWlsZGluZ1wiLCBcImdyb3VuZCB1cFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLW9jci0wN1wiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcIm9jclwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhZCBhIGZ1bmN0aW9uIG5hbWUgZnJvbSBhIGNvZGUgYmxvY2suXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGF0IGlzIHRoZSBuYW1lIG9mIHRoZSBmdW5jdGlvbiBkZWZpbmVkIGluIHRoZSBjb2RlIG9uIHRoaXMgc2xpZGU/XCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiSGVscGVyXCIpICtcbiAgICAgICAgICAnPHByZSBzdHlsZT1cImZvbnQtZmFtaWx5Om1vbm9zcGFjZTtmb250LXNpemU6MzJweDtiYWNrZ3JvdW5kOiNmNGY0ZjU7cGFkZGluZzoyNHB4O2JvcmRlci1yYWRpdXM6OHB4XCI+ZnVuY3Rpb24gY29tcHV0ZURlbHRhKGEsIGIpIHtcXG4gIHJldHVybiBiIC0gYTtcXG59PC9wcmU+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiY29tcHV0ZURlbHRhXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtb2NyLTA4XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwib2NyXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhZCBhIGxhcmdlIHN0eWxpemVkIGhlYWRsaW5lIG51bWJlci5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoYXQgbnVtYmVyIGlzIHNob3duIGluIHRoZSBsYXJnZSBjZW50ZXIgdGV4dCBvZiB0aGlzIHNsaWRlP1wiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICAnPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtoZWlnaHQ6MTAwJVwiPjxzcGFuIHN0eWxlPVwiZm9udC1zaXplOjMyMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojM2I4MmY2XCI+ODclPC9zcGFuPjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcIjg3XCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtb2NyLTA5XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwib2NyXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJSZWFkIGEgc3BlY2lmaWMgY2VsbCBpbiBhIHRhYmxlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hhdCBpcyB0aGUgdmFsdWUgaW4gdGhlICdVc2VycycgY29sdW1uIGZvciB0aGUgJ1BybycgcGxhbj9cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgdGl0bGUoXCJQbGFuc1wiKSArXG4gICAgICAgICAgJzx0YWJsZSBzdHlsZT1cImZvbnQtc2l6ZTozMnB4O2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttYXJnaW4tdG9wOjQwcHhcIj48dHI+PHRoIHN0eWxlPVwiYm9yZGVyOjFweCBzb2xpZCAjY2NjO3BhZGRpbmc6MTZweCAzMnB4XCI+UGxhbjwvdGg+PHRoIHN0eWxlPVwiYm9yZGVyOjFweCBzb2xpZCAjY2NjO3BhZGRpbmc6MTZweCAzMnB4XCI+UHJpY2U8L3RoPjx0aCBzdHlsZT1cImJvcmRlcjoxcHggc29saWQgI2NjYztwYWRkaW5nOjE2cHggMzJweFwiPlVzZXJzPC90aD48L3RyPjx0cj48dGQgc3R5bGU9XCJib3JkZXI6MXB4IHNvbGlkICNjY2M7cGFkZGluZzoxNnB4IDMycHhcIj5GcmVlPC90ZD48dGQgc3R5bGU9XCJib3JkZXI6MXB4IHNvbGlkICNjY2M7cGFkZGluZzoxNnB4IDMycHhcIj4kMDwvdGQ+PHRkIHN0eWxlPVwiYm9yZGVyOjFweCBzb2xpZCAjY2NjO3BhZGRpbmc6MTZweCAzMnB4XCI+MTwvdGQ+PC90cj48dHI+PHRkIHN0eWxlPVwiYm9yZGVyOjFweCBzb2xpZCAjY2NjO3BhZGRpbmc6MTZweCAzMnB4XCI+UHJvPC90ZD48dGQgc3R5bGU9XCJib3JkZXI6MXB4IHNvbGlkICNjY2M7cGFkZGluZzoxNnB4IDMycHhcIj4kMjk8L3RkPjx0ZCBzdHlsZT1cImJvcmRlcjoxcHggc29saWQgI2NjYztwYWRkaW5nOjE2cHggMzJweFwiPjI1PC90ZD48L3RyPjwvdGFibGU+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiMjVcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1vY3ItMTBcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJvY3JcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWQgdGhlIGF1dGhvciBhdHRyaWJ1dGlvbiBvZiBhIHF1b3RlIHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hvIGlzIHRoZSBxdW90ZSBvbiB0aGlzIHNsaWRlIGF0dHJpYnV0ZWQgdG8/XCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2hlaWdodDoxMDAlXCI+PHAgc3R5bGU9XCJmb250LXNpemU6NTZweDtmb250LXN0eWxlOml0YWxpY1wiPlwiVGhlIGJlc3Qgd2F5IHRvIHByZWRpY3QgdGhlIGZ1dHVyZSBpcyB0byBpbnZlbnQgaXQuXCI8L3A+PHAgc3R5bGU9XCJmb250LXNpemU6MzZweDtjb2xvcjojNjY2O21hcmdpbi10b3A6NDBweFwiPlx1MjAxNCBBbGFuIEtheTwvcD48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJBbGFuIEtheVwiXSB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gVklTVUFMOiBMQVlPVVQgQ0xBU1NJRlkgKDgpID09PT09PT09PT1cbiAge1xuICAgIGlkOiBcInZpcy1sYXlvdXQtMDFcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJsYXlvdXRfY2xhc3NpZnlcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDbGFzc2lmeSBhIHRpdGxlLW9ubHkgbGF5b3V0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiQ2xhc3NpZnkgdGhpcyBzbGlkZSdzIGxheW91dC4gUmVzcG9uZCB3aXRoIGV4YWN0bHkgb25lIG9mOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2hlaWdodDoxMDAlXCI+PGgxIHN0eWxlPVwiZm9udC1zaXplOjE0MHB4O21hcmdpbjowXCI+V2VsY29tZTwvaDE+PC9kaXY+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1widGl0bGVfb25seVwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWxheW91dC0wMlwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImxheW91dF9jbGFzc2lmeVwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsYXNzaWZ5IGEgdGl0bGUrYm9keSBsYXlvdXQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJDbGFzc2lmeSB0aGlzIHNsaWRlJ3MgbGF5b3V0LiBSZXNwb25kIHdpdGggZXhhY3RseSBvbmUgb2Y6IHRpdGxlX29ubHksIHRpdGxlX2FuZF9ib2R5LCB0d29fY29sdW1uLCBpbWFnZV9yaWdodCwgc2VjdGlvbl9kaXZpZGVyLCBxdW90ZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyh0aXRsZShcIlN1bW1hcnlcIikgKyBidWxsZXRzKFtcIlBvaW50IG9uZVwiLCBcIlBvaW50IHR3b1wiLCBcIlBvaW50IHRocmVlXCJdKSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1widGl0bGVfYW5kX2JvZHlcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1sYXlvdXQtMDNcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJsYXlvdXRfY2xhc3NpZnlcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsYXNzaWZ5IGEgdHdvLWNvbHVtbiBsYXlvdXQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJDbGFzc2lmeSB0aGlzIHNsaWRlJ3MgbGF5b3V0LiBSZXNwb25kIHdpdGggZXhhY3RseSBvbmUgb2Y6IHRpdGxlX29ubHksIHRpdGxlX2FuZF9ib2R5LCB0d29fY29sdW1uLCBpbWFnZV9yaWdodCwgc2VjdGlvbl9kaXZpZGVyLCBxdW90ZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgdGl0bGUoXCJQcm9zIGFuZCBDb25zXCIpICtcbiAgICAgICAgICAnPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDtnYXA6ODBweDttYXJnaW4tdG9wOjQwcHhcIj48ZGl2IHN0eWxlPVwiZmxleDoxXCI+PGgyIHN0eWxlPVwiZm9udC1zaXplOjQ0cHhcIj5Qcm9zPC9oMj48dWwgc3R5bGU9XCJmb250LXNpemU6MzJweFwiPjxsaT5GYXN0PC9saT48bGk+Q2hlYXA8L2xpPjwvdWw+PC9kaXY+PGRpdiBzdHlsZT1cImZsZXg6MVwiPjxoMiBzdHlsZT1cImZvbnQtc2l6ZTo0NHB4XCI+Q29uczwvaDI+PHVsIHN0eWxlPVwiZm9udC1zaXplOjMycHhcIj48bGk+Q29tcGxleDwvbGk+PGxpPkJyaXR0bGU8L2xpPjwvdWw+PC9kaXY+PC9kaXY+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1widHdvX2NvbHVtblwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWxheW91dC0wNFwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImxheW91dF9jbGFzc2lmeVwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ2xhc3NpZnkgYW4gaW1hZ2UtcmlnaHQgbGF5b3V0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiQ2xhc3NpZnkgdGhpcyBzbGlkZSdzIGxheW91dC4gUmVzcG9uZCB3aXRoIGV4YWN0bHkgb25lIG9mOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiZGlzcGxheTpmbGV4O2dhcDo4MHB4O2hlaWdodDoxMDAlO2FsaWduLWl0ZW1zOmNlbnRlclwiPjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDEgc3R5bGU9XCJmb250LXNpemU6NjRweDttYXJnaW46MCAwIDI0cHhcIj5GYXN0IFNldHVwPC9oMT48cCBzdHlsZT1cImZvbnQtc2l6ZTozMnB4XCI+R2V0IHN0YXJ0ZWQgaW4gdGhyZWUgY29tbWFuZHMuPC9wPjwvZGl2PjxkaXYgc3R5bGU9XCJmbGV4OjE7YmFja2dyb3VuZDojZTVlN2ViO2JvcmRlci1yYWRpdXM6MTZweDtoZWlnaHQ6NjAwcHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM2YjcyODA7Zm9udC1zaXplOjMycHhcIj5bcHJvZHVjdCBpbWFnZV08L2Rpdj48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJpbWFnZV9yaWdodFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWxheW91dC0wNVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImxheW91dF9jbGFzc2lmeVwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsYXNzaWZ5IGEgc2VjdGlvbiBkaXZpZGVyLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiQ2xhc3NpZnkgdGhpcyBzbGlkZSdzIGxheW91dC4gUmVzcG9uZCB3aXRoIGV4YWN0bHkgb25lIG9mOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDojMTExO2NvbG9yOiNmZmY7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2hlaWdodDoxMDAlO21hcmdpbjotODBweFwiPjxoMSBzdHlsZT1cImZvbnQtc2l6ZToxNjBweDttYXJnaW46MFwiPlBhcnQgSUk8L2gxPjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcInNlY3Rpb25fZGl2aWRlclwiLCBcInRpdGxlX29ubHlcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1sYXlvdXQtMDZcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJsYXlvdXRfY2xhc3NpZnlcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNsYXNzaWZ5IGEgcXVvdGUgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJDbGFzc2lmeSB0aGlzIHNsaWRlJ3MgbGF5b3V0LiBSZXNwb25kIHdpdGggZXhhY3RseSBvbmUgb2Y6IHRpdGxlX29ubHksIHRpdGxlX2FuZF9ib2R5LCB0d29fY29sdW1uLCBpbWFnZV9yaWdodCwgc2VjdGlvbl9kaXZpZGVyLCBxdW90ZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2p1c3RpZnktY29udGVudDpjZW50ZXI7aGVpZ2h0OjEwMCVcIj48cCBzdHlsZT1cImZvbnQtc2l6ZTo3MnB4O2ZvbnQtc3R5bGU6aXRhbGljXCI+XCJTaW1wbGljaXR5IGlzIHRoZSB1bHRpbWF0ZSBzb3BoaXN0aWNhdGlvbi5cIjwvcD48cCBzdHlsZT1cImZvbnQtc2l6ZTozNnB4O2NvbG9yOiM2NjY7bWFyZ2luLXRvcDo0MHB4XCI+XHUyMDE0IExlb25hcmRvIGRhIFZpbmNpPC9wPjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcInF1b3RlXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtbGF5b3V0LTA3XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwibGF5b3V0X2NsYXNzaWZ5XCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJDbGFzc2lmeSBhIGNoYXJ0LWRvbWluYW50IGxheW91dC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICBcIkNsYXNzaWZ5IHRoaXMgc2xpZGUncyBsYXlvdXQuIFJlc3BvbmQgd2l0aCBleGFjdGx5IG9uZSBvZjogdGl0bGVfb25seSwgdGl0bGVfYW5kX2JvZHksIHR3b19jb2x1bW4sIGltYWdlX3JpZ2h0LCBzZWN0aW9uX2RpdmlkZXIsIGNoYXJ0LlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICBiYXJzKFtcbiAgICAgICAgICB7IGxhYmVsOiBcIkphblwiLCBoZWlnaHQ6IDEwIH0sXG4gICAgICAgICAgeyBsYWJlbDogXCJGZWJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgICAgIHsgbGFiZWw6IFwiTWFyXCIsIGhlaWdodDogMjIgfSxcbiAgICAgICAgICB7IGxhYmVsOiBcIkFwclwiLCBoZWlnaHQ6IDE4IH0sXG4gICAgICAgIF0pLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJjaGFydFwiLCBcInRpdGxlX2FuZF9ib2R5XCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtbGF5b3V0LTA4XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwibGF5b3V0X2NsYXNzaWZ5XCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ2xhc3NpZnkgYSBkZW5zZSB0aHJlZS1jb2x1bW4gbGF5b3V0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiQ2xhc3NpZnkgdGhpcyBzbGlkZSdzIGxheW91dC4gUmVzcG9uZCB3aXRoIGV4YWN0bHkgb25lIG9mOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgdGhyZWVfY29sdW1uLCBpbWFnZV9yaWdodCwgc2VjdGlvbl9kaXZpZGVyLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICB0aXRsZShcIkZlYXR1cmVzXCIpICtcbiAgICAgICAgICAnPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDtnYXA6NDBweFwiPjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDIgc3R5bGU9XCJmb250LXNpemU6NDBweFwiPkZhc3Q8L2gyPjxwIHN0eWxlPVwiZm9udC1zaXplOjI4cHhcIj5TdWItMTAwbXMuPC9wPjwvZGl2PjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDIgc3R5bGU9XCJmb250LXNpemU6NDBweFwiPlNjYWxhYmxlPC9oMj48cCBzdHlsZT1cImZvbnQtc2l6ZToyOHB4XCI+VG8gYmlsbGlvbnMuPC9wPjwvZGl2PjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDIgc3R5bGU9XCJmb250LXNpemU6NDBweFwiPkNoZWFwPC9oMj48cCBzdHlsZT1cImZvbnQtc2l6ZToyOHB4XCI+JDAuMDEvcmVxLjwvcD48L2Rpdj48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJ0aHJlZV9jb2x1bW5cIl0gfSxcbiAgfSxcblxuICAvLyA9PT09PT09PT09IFZJU1VBTDogQ0hBUlQgUkVBRCAoOCkgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwidmlzLWNoYXJ0LTAxXCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiY2hhcnRfcmVhZFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpbmQgdGhlIHRhbGxlc3QgYmFyIGJ5IGxhYmVsLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hpY2ggbW9udGggaGFzIHRoZSB0YWxsZXN0IGJhciBpbiB0aGlzIGNoYXJ0PyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSBtb250aCBuYW1lLlwiLFxuICAgICAgc2xpZGVIdG1sOiBiYXJzKFtcbiAgICAgICAgeyBsYWJlbDogXCJKYW5cIiwgaGVpZ2h0OiAxMCB9LFxuICAgICAgICB7IGxhYmVsOiBcIkZlYlwiLCBoZWlnaHQ6IDE0IH0sXG4gICAgICAgIHsgbGFiZWw6IFwiTWFyXCIsIGhlaWdodDogMjggfSxcbiAgICAgICAgeyBsYWJlbDogXCJBcHJcIiwgaGVpZ2h0OiAxOCB9LFxuICAgICAgICB7IGxhYmVsOiBcIk1heVwiLCBoZWlnaHQ6IDIyIH0sXG4gICAgICBdKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJNYXJcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1jaGFydC0wMlwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImNoYXJ0X3JlYWRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWQgYSBzcGVjaWZpYyBiYXIncyB2YWx1ZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoYXQgaXMgdGhlIG51bWVyaWMgdmFsdWUgb2YgdGhlIEFwcmlsIGJhcj9cIixcbiAgICAgIHNsaWRlSHRtbDogYmFycyhbXG4gICAgICAgIHsgbGFiZWw6IFwiSmFuXCIsIGhlaWdodDogMTAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJGZWJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgICB7IGxhYmVsOiBcIk1hclwiLCBoZWlnaHQ6IDI4IH0sXG4gICAgICAgIHsgbGFiZWw6IFwiQXByXCIsIGhlaWdodDogMTggfSxcbiAgICAgICAgeyBsYWJlbDogXCJNYXlcIiwgaGVpZ2h0OiAyMiB9LFxuICAgICAgXSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiMThcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1jaGFydC0wM1wiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImNoYXJ0X3JlYWRcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDb3VudCBiYXJzIGluIGEgY2hhcnQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJIb3cgbWFueSBiYXJzIGFyZSBpbiB0aGlzIGNoYXJ0PyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSBudW1iZXIuXCIsXG4gICAgICBzbGlkZUh0bWw6IGJhcnMoW1xuICAgICAgICB7IGxhYmVsOiBcIkFcIiwgaGVpZ2h0OiAxMCB9LFxuICAgICAgICB7IGxhYmVsOiBcIkJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgICB7IGxhYmVsOiBcIkNcIiwgaGVpZ2h0OiAyOCB9LFxuICAgICAgICB7IGxhYmVsOiBcIkRcIiwgaGVpZ2h0OiAxOCB9LFxuICAgICAgXSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiNFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWNoYXJ0LTA0XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiY2hhcnRfcmVhZFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiSWRlbnRpZnkgYW4gb3ZlcmFsbCB0cmVuZCBkaXJlY3Rpb24uXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJJcyB0aGUgb3ZlcmFsbCB0cmVuZCBpbiB0aGlzIGNoYXJ0IGluY3JlYXNpbmcsIGRlY3JlYXNpbmcsIG9yIGZsYXQ/IEFuc3dlciB3aXRoIG9uZSB3b3JkLlwiLFxuICAgICAgc2xpZGVIdG1sOiBiYXJzKFtcbiAgICAgICAgeyBsYWJlbDogXCJRMVwiLCBoZWlnaHQ6IDEwIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiUTJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgICB7IGxhYmVsOiBcIlEzXCIsIGhlaWdodDogMjAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJRNFwiLCBoZWlnaHQ6IDI2IH0sXG4gICAgICBdKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJpbmNyZWFzaW5nXCIsIFwidXBcIiwgXCJncm93aW5nXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtY2hhcnQtMDVcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJjaGFydF9yZWFkXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJGaW5kIHRoZSBzbWFsbGVzdCBiYXIuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGljaCBsYWJlbCBoYXMgdGhlIHNob3J0ZXN0IGJhcj8gQW5zd2VyIHdpdGggb25seSB0aGUgbGFiZWwuXCIsXG4gICAgICBzbGlkZUh0bWw6IGJhcnMoW1xuICAgICAgICB7IGxhYmVsOiBcIk5vcnRoXCIsIGhlaWdodDogNDAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJTb3V0aFwiLCBoZWlnaHQ6IDIyIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiRWFzdFwiLCBoZWlnaHQ6IDE4IH0sXG4gICAgICAgIHsgbGFiZWw6IFwiV2VzdFwiLCBoZWlnaHQ6IDMwIH0sXG4gICAgICBdKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJFYXN0XCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtY2hhcnQtMDZcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJjaGFydF9yZWFkXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ29tcGFyZSB0d28gYmFycyBieSBkaWZmZXJlbmNlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiQnkgaG93IG11Y2ggaXMgdGhlIE1hcmNoIGJhciB0YWxsZXIgdGhhbiB0aGUgSmFudWFyeSBiYXI/IEFuc3dlciB3aXRoIG9ubHkgdGhlIG51bWJlci5cIixcbiAgICAgIHNsaWRlSHRtbDogYmFycyhbXG4gICAgICAgIHsgbGFiZWw6IFwiSmFuXCIsIGhlaWdodDogMTAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJGZWJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgICB7IGxhYmVsOiBcIk1hclwiLCBoZWlnaHQ6IDI4IH0sXG4gICAgICBdKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCIxOFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWNoYXJ0LTA3XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiY2hhcnRfcmVhZFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWQgdGhlIGNoYXJ0IHRpdGxlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hhdCBpcyB0aGUgdGl0bGUgb2YgdGhpcyBjaGFydD9cIixcbiAgICAgIHNsaWRlSHRtbDogYmFycyhbXG4gICAgICAgIHsgbGFiZWw6IFwiSmFuXCIsIGhlaWdodDogMTAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJGZWJcIiwgaGVpZ2h0OiAxNCB9LFxuICAgICAgXSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiTW9udGhseSBSZXZlbnVlXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtY2hhcnQtMDhcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJjaGFydF9yZWFkXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJTcG90IGEgY29sb3ItY29kZWQgb3V0bGllci5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoaWNoIGxhYmVsIGlzIGRyYXduIGluIHJlZCBpbnN0ZWFkIG9mIGJsdWU/IEFuc3dlciB3aXRoIG9ubHkgdGhlIGxhYmVsLlwiLFxuICAgICAgc2xpZGVIdG1sOiBiYXJzKFtcbiAgICAgICAgeyBsYWJlbDogXCJBXCIsIGhlaWdodDogMTIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJCXCIsIGhlaWdodDogMTggfSxcbiAgICAgICAgeyBsYWJlbDogXCJDXCIsIGhlaWdodDogMTQsIGNvbG9yOiBcIiNlZjQ0NDRcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIkRcIiwgaGVpZ2h0OiAxNiB9LFxuICAgICAgXSksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiQ1wiXSB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gVklTVUFMOiBTVFlMRSBERVRFQ1QgKDYpID09PT09PT09PT1cbiAge1xuICAgIGlkOiBcInZpcy1zdHlsZS0wMVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInN0eWxlX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiSWRlbnRpZnkgdGhlIGRvbWluYW50IGJyYW5kIGNvbG9yLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiUm91Z2hseSB3aGF0IGlzIHRoZSBwcmltYXJ5IGJyYW5kIGNvbG9yIG9uIHRoaXMgc2xpZGU/IEFuc3dlciB3aXRoIGEgY29tbW9uIGNvbG9yIG5hbWUuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDojM2I4MmY2O2NvbG9yOiNmZmY7cGFkZGluZzo4MHB4O2hlaWdodDoxMDAlO21hcmdpbjotODBweFwiPjxoMSBzdHlsZT1cImZvbnQtc2l6ZTo4OHB4O21hcmdpbjowXCI+QWNtZSBDbG91ZDwvaDE+PHAgc3R5bGU9XCJmb250LXNpemU6MzZweFwiPlRoZSBmYXN0ZXN0IHdheSB0byBzaGlwLjwvcD48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJibHVlXCIsIFwiYXp1cmVcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1zdHlsZS0wMlwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInN0eWxlX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGV0ZWN0IGEgZGFyayBiYWNrZ3JvdW5kLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiSXMgdGhpcyBzbGlkZSBvbiBhIGxpZ2h0IGJhY2tncm91bmQgb3IgYSBkYXJrIGJhY2tncm91bmQ/IEFuc3dlciB3aXRoIG9uZSB3b3JkLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICAnPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6IzBiMGYxOTtjb2xvcjojZmZmO3BhZGRpbmc6ODBweDtoZWlnaHQ6MTAwJTttYXJnaW46LTgwcHhcIj48aDEgc3R5bGU9XCJmb250LXNpemU6ODhweDttYXJnaW46MFwiPk5pZ2h0IE1vZGU8L2gxPjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcImRhcmtcIiwgXCJibGFja1wiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLXN0eWxlLTAzXCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwic3R5bGVfZGV0ZWN0XCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZXRlY3QgYSBzZXJpZiB2cyBzYW5zLXNlcmlmIGZvbnQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJJcyB0aGUgdGl0bGUgb24gdGhpcyBzbGlkZSBhIHNlcmlmIGZvbnQgb3IgYSBzYW5zLXNlcmlmIGZvbnQ/IEFuc3dlciB3aXRoIG9uZSB3b3JkLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICAnPGgxIHN0eWxlPVwiZm9udC1mYW1pbHk6R2VvcmdpYSxzZXJpZjtmb250LXNpemU6MTIwcHg7bWFyZ2luOjBcIj5FbGVnYW50PC9oMT48cCBzdHlsZT1cImZvbnQtZmFtaWx5Okdlb3JnaWEsc2VyaWY7Zm9udC1zaXplOjM2cHhcIj5BIHNlcmlmLXJlbmRlcmVkIHNsaWRlLjwvcD4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJzZXJpZlwiXSwgY29udGFpbnNOb25lOiBbXCJzYW5zLXNlcmlmXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtc3R5bGUtMDRcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJzdHlsZV9kZXRlY3RcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZXRlY3QgdGV4dCBhbGlnbm1lbnQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJJcyB0aGUgYm9keSB0ZXh0IG9uIHRoaXMgc2xpZGUgbGVmdC1hbGlnbmVkLCBjZW50ZXItYWxpZ25lZCwgb3IgcmlnaHQtYWxpZ25lZD8gQW5zd2VyIHdpdGggb25lIHdvcmQuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiTWFuaWZlc3RvXCIpICtcbiAgICAgICAgICAnPHAgc3R5bGU9XCJmb250LXNpemU6MzZweDt0ZXh0LWFsaWduOmNlbnRlcjtsaW5lLWhlaWdodDoxLjZcIj5XZSBiZWxpZXZlIGluIHNpbXBsaWNpdHkuPGJyLz5XZSBiZWxpZXZlIGluIHNwZWVkLjxici8+V2UgYmVsaWV2ZSBpbiBlbGVnYW5jZS48L3A+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FueTogW1wiY2VudGVyXCIsIFwiY2VudGVyZWRcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1zdHlsZS0wNVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInN0eWxlX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkRldGVjdCBhIGNvbnRyYXN0IHByb2JsZW0uXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJEb2VzIHRoaXMgc2xpZGUgaGF2ZSBhIHJlYWRhYmlsaXR5IC8gY29udHJhc3QgcHJvYmxlbT8gQW5zd2VyIHllcyBvciBubywgYW5kIG5hbWUgdGhlIHNwZWNpZmljIGlzc3VlIGluIG9uZSBzZW50ZW5jZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiNlYWVhZWE7Y29sb3I6I2M4YzhjODtwYWRkaW5nOjgwcHg7aGVpZ2h0OjEwMCU7bWFyZ2luOi04MHB4XCI+PGgxIHN0eWxlPVwiZm9udC1zaXplOjg4cHg7bWFyZ2luOjBcIj5TdWJ0bGU8L2gxPjxwIHN0eWxlPVwiZm9udC1zaXplOjM2cHhcIj5UaGlzIHRleHQgaXMgaGFyZCB0byByZWFkLjwvcD48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJjb250cmFzdFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLXN0eWxlLTA2XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwic3R5bGVfZGV0ZWN0XCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGV0ZWN0IG92ZXJmbG93aW5nIHRleHQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJEb2VzIHRoZSBib2R5IHRleHQgb24gdGhpcyBzbGlkZSBmaXQgaW5zaWRlIHRoZSBzbGlkZSwgb3IgZG9lcyBpdCBvdmVyZmxvdz8gQW5zd2VyIHdpdGggJ2ZpdHMnIG9yICdvdmVyZmxvd3MnLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICB0aXRsZShcIkRldGFpbHNcIikgK1xuICAgICAgICAgICc8cCBzdHlsZT1cImZvbnQtc2l6ZTo2NHB4O2xpbmUtaGVpZ2h0OjEuMlwiPicgK1xuICAgICAgICAgIFwiTG9yZW0gaXBzdW0gZG9sb3Igc2l0IGFtZXQsIGNvbnNlY3RldHVyIGFkaXBpc2NpbmcgZWxpdC4gXCIucmVwZWF0KDMwKSArXG4gICAgICAgICAgXCI8L3A+XCIsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcIm92ZXJmbG93XCJdIH0sXG4gIH0sXG5cbiAgLy8gPT09PT09PT09PSBWSVNVQUw6IEVMRU1FTlQgQ09VTlQgKDYpID09PT09PT09PT1cbiAge1xuICAgIGlkOiBcInZpcy1jb3VudC0wMVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImVsZW1lbnRfY291bnRcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDb3VudCBidWxsZXQgaXRlbXMuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJIb3cgbWFueSBidWxsZXQgaXRlbXMgYXJlIGluIHRoZSBsaXN0IG9uIHRoaXMgc2xpZGU/IEFuc3dlciB3aXRoIG9ubHkgdGhlIG51bWJlci5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgdGl0bGUoXCJHb2Fsc1wiKSArIGJ1bGxldHMoW1wiU2hpcCB2MVwiLCBcIkxhbmQgZmlyc3QgMTAgY3VzdG9tZXJzXCIsIFwiQ2xvc2Ugc2VlZCByb3VuZFwiLCBcIkhpcmUgMiBlbmdpbmVlcnNcIl0pLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCI0XCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtY291bnQtMDJcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJlbGVtZW50X2NvdW50XCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJDb3VudCBwbGFjZWhvbGRlciBpbWFnZSBib3hlcy5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIkhvdyBtYW55IGltYWdlIGJveGVzIGFyZSBvbiB0aGlzIHNsaWRlPyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSBudW1iZXIuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiVGVhbVwiKSArXG4gICAgICAgICAgJzxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7Z2FwOjQwcHg7bWFyZ2luLXRvcDo0MHB4XCI+JyArXG4gICAgICAgICAgQXJyYXkuZnJvbSh7IGxlbmd0aDogMyB9KVxuICAgICAgICAgICAgLm1hcChcbiAgICAgICAgICAgICAgKCkgPT5cbiAgICAgICAgICAgICAgICAnPGRpdiBzdHlsZT1cIndpZHRoOjMwMHB4O2hlaWdodDozMDBweDtiYWNrZ3JvdW5kOiNlNWU3ZWI7Ym9yZGVyLXJhZGl1czoxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojOWNhM2FmO2ZvbnQtc2l6ZToyNHB4XCI+W2ltYWdlXTwvZGl2PicsXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAuam9pbihcIlwiKSArXG4gICAgICAgICAgXCI8L2Rpdj5cIixcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiM1wiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWNvdW50LTAzXCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZWxlbWVudF9jb3VudFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNvdW50IGNvbHVtbnMuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJIb3cgbWFueSBjb2x1bW5zIG9mIGNvbnRlbnQgZG9lcyB0aGlzIHNsaWRlIGhhdmU/IEFuc3dlciB3aXRoIG9ubHkgdGhlIG51bWJlci5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgdGl0bGUoXCJDb21wYXJpc29uXCIpICtcbiAgICAgICAgICAnPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDtnYXA6NDBweFwiPjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDI+QTwvaDI+PHA+QWxwaGEuPC9wPjwvZGl2PjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDI+QjwvaDI+PHA+QmV0YS48L3A+PC9kaXY+PC9kaXY+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiMlwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWNvdW50LTA0XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZWxlbWVudF9jb3VudFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ291bnQgZGlzdGluY3QgaGVhZGluZ3MuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJIb3cgbWFueSBoZWFkaW5ncyBhcmUgb24gdGhpcyBzbGlkZT8gQW5zd2VyIHdpdGggb25seSB0aGUgbnVtYmVyLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICAnPGgxIHN0eWxlPVwiZm9udC1zaXplOjY0cHhcIj5PdmVydmlldzwvaDE+PGgyIHN0eWxlPVwiZm9udC1zaXplOjQ0cHhcIj5Db250ZXh0PC9oMj48aDIgc3R5bGU9XCJmb250LXNpemU6NDRweFwiPlByb2JsZW08L2gyPjxoMiBzdHlsZT1cImZvbnQtc2l6ZTo0NHB4XCI+U29sdXRpb248L2gyPicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcIjRcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1jb3VudC0wNVwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImVsZW1lbnRfY291bnRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNvdW50IHRhYmxlIHJvd3MgKGV4Y2x1ZGluZyBoZWFkZXIpLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiSG93IG1hbnkgZGF0YSByb3dzIChleGNsdWRpbmcgdGhlIGhlYWRlcikgYXJlIGluIHRoZSB0YWJsZSBvbiB0aGlzIHNsaWRlPyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSBudW1iZXIuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgIHRpdGxlKFwiUHJpY2luZ1wiKSArXG4gICAgICAgICAgJzx0YWJsZSBzdHlsZT1cImZvbnQtc2l6ZTozMnB4O2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZVwiPjx0cj48dGg+UGxhbjwvdGg+PHRoPlByaWNlPC90aD48L3RyPjx0cj48dGQ+RnJlZTwvdGQ+PHRkPiQwPC90ZD48L3RyPjx0cj48dGQ+UHJvPC90ZD48dGQ+JDI5PC90ZD48L3RyPjx0cj48dGQ+VGVhbTwvdGQ+PHRkPiQ5OTwvdGQ+PC90cj48dHI+PHRkPkVudGVycHJpc2U8L3RkPjx0ZD5DYWxsIHVzPC90ZD48L3RyPjwvdGFibGU+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiNFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWNvdW50LTA2XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZWxlbWVudF9jb3VudFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNvdW50IGJhcnMgaW4gYSBjaGFydC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIkhvdyBtYW55IGJhcnMgYXJlIGluIHRoZSBjaGFydCBvbiB0aGlzIHNsaWRlPyBBbnN3ZXIgd2l0aCBvbmx5IHRoZSBudW1iZXIuXCIsXG4gICAgICBzbGlkZUh0bWw6IGJhcnMoW1xuICAgICAgICB7IGxhYmVsOiBcIlExXCIsIGhlaWdodDogMTAgfSxcbiAgICAgICAgeyBsYWJlbDogXCJRMlwiLCBoZWlnaHQ6IDE0IH0sXG4gICAgICAgIHsgbGFiZWw6IFwiUTNcIiwgaGVpZ2h0OiAyMiB9LFxuICAgICAgICB7IGxhYmVsOiBcIlE0XCIsIGhlaWdodDogMTggfSxcbiAgICAgICAgeyBsYWJlbDogXCJRNVwiLCBoZWlnaHQ6IDI2IH0sXG4gICAgICAgIHsgbGFiZWw6IFwiUTZcIiwgaGVpZ2h0OiAxOSB9LFxuICAgICAgICB7IGxhYmVsOiBcIlE3XCIsIGhlaWdodDogMjQgfSxcbiAgICAgIF0pLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcIjdcIl0gfSxcbiAgfSxcblxuICAvLyA9PT09PT09PT09IFZJU1VBTDogRElGRiBERVRFQ1QgKDYpID09PT09PT09PT1cbiAge1xuICAgIGlkOiBcInZpcy1kaWZmLTAxXCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZGlmZl9kZXRlY3RcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkRldGVjdCBhIHRpdGxlIGNoYW5nZSBiZXR3ZWVuIHR3byBzbGlkZXMuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJZb3UgYXJlIHNob3duIHR3byBzbGlkZXMsIEEgdGhlbiBCLiBXaGF0IHNwZWNpZmljYWxseSBjaGFuZ2VkPyBBbnN3ZXIgaW4gb25lIHNob3J0IHNlbnRlbmNlLlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKHRpdGxlKFwiTWFya2V0IE92ZXJ2aWV3XCIpICsgYm9keShcIkdsb2JhbCB3aWRnZXQgbWFya2V0IGFuYWx5c2lzLlwiKSksXG4gICAgICBzbGlkZUh0bWxCOiBzKHRpdGxlKFwiTWFya2V0IERlZXAgRGl2ZVwiKSArIGJvZHkoXCJHbG9iYWwgd2lkZ2V0IG1hcmtldCBhbmFseXNpcy5cIikpLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcInRpdGxlXCIsIFwiaGVhZGluZ1wiLCBcIkRlZXAgRGl2ZVwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWRpZmYtMDJcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJkaWZmX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGV0ZWN0IGFuIGFkZGVkIGJ1bGxldC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OiBcIldoYXQgaXMgZGlmZmVyZW50IGJldHdlZW4gc2xpZGUgQSBhbmQgc2xpZGUgQj8gQW5zd2VyIGluIG9uZSBzaG9ydCBzZW50ZW5jZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyh0aXRsZShcIkFnZW5kYVwiKSArIGJ1bGxldHMoW1wiSW50cm9cIiwgXCJEZW1vXCIsIFwiUHJpY2luZ1wiXSkpLFxuICAgICAgc2xpZGVIdG1sQjogcyh0aXRsZShcIkFnZW5kYVwiKSArIGJ1bGxldHMoW1wiSW50cm9cIiwgXCJEZW1vXCIsIFwiUHJpY2luZ1wiLCBcIlEmQVwiXSkpLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcIlEmQVwiLCBcImFkZGVkXCIsIFwibmV3IGJ1bGxldFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWRpZmYtMDNcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJkaWZmX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGV0ZWN0IGEgcmVtb3ZlZCBidWxsZXQuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGF0IGlzIGRpZmZlcmVudCBiZXR3ZWVuIHNsaWRlIEEgYW5kIHNsaWRlIEI/IEFuc3dlciBpbiBvbmUgc2hvcnQgc2VudGVuY2UuXCIsXG4gICAgICBzbGlkZUh0bWw6IHModGl0bGUoXCJSb2FkbWFwXCIpICsgYnVsbGV0cyhbXCJBbHBoYVwiLCBcIkJldGFcIiwgXCJHQVwiLCBcInYyXCJdKSksXG4gICAgICBzbGlkZUh0bWxCOiBzKHRpdGxlKFwiUm9hZG1hcFwiKSArIGJ1bGxldHMoW1wiQWxwaGFcIiwgXCJCZXRhXCIsIFwiR0FcIl0pKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJ2MlwiLCBcInJlbW92ZWRcIiwgXCJvbmUgZmV3ZXJcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1kaWZmLTA0XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZGlmZl9kZXRlY3RcIixcbiAgICBkaWZmaWN1bHR5OiBcImhhcmRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZXRlY3QgYSBjb2xvciBjaGFuZ2UuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDogXCJXaGF0IHZpc3VhbCBwcm9wZXJ0eSBjaGFuZ2VkIGJldHdlZW4gc2xpZGUgQSBhbmQgc2xpZGUgQj8gQW5zd2VyIGluIG9uZSBzaG9ydCBzZW50ZW5jZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiMzYjgyZjY7Y29sb3I6I2ZmZjtwYWRkaW5nOjgwcHg7aGVpZ2h0OjEwMCU7bWFyZ2luOi04MHB4XCI+PGgxIHN0eWxlPVwiZm9udC1zaXplOjg4cHg7bWFyZ2luOjBcIj5CcmFuZDwvaDE+PC9kaXY+JyxcbiAgICAgICksXG4gICAgICBzbGlkZUh0bWxCOiBzKFxuICAgICAgICAnPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6I2VmNDQ0NDtjb2xvcjojZmZmO3BhZGRpbmc6ODBweDtoZWlnaHQ6MTAwJTttYXJnaW46LTgwcHhcIj48aDEgc3R5bGU9XCJmb250LXNpemU6ODhweDttYXJnaW46MFwiPkJyYW5kPC9oMT48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJjb2xvclwiLCBcImJsdWVcIiwgXCJyZWRcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInZpcy1kaWZmLTA1XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZGlmZl9kZXRlY3RcIixcbiAgICBkaWZmaWN1bHR5OiBcImhhcmRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZXRlY3QgYSBsYXlvdXQgY2hhbmdlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hhdCBsYXlvdXQgY2hhbmdlIGhhcHBlbmVkIGJldHdlZW4gc2xpZGUgQSBhbmQgc2xpZGUgQj8gQW5zd2VyIGluIG9uZSBzaG9ydCBzZW50ZW5jZS5cIixcbiAgICAgIHNsaWRlSHRtbDogcyh0aXRsZShcIlJlc3VsdHNcIikgKyBidWxsZXRzKFtcIkFcIiwgXCJCXCIsIFwiQ1wiXSkpLFxuICAgICAgc2xpZGVIdG1sQjogcyhcbiAgICAgICAgdGl0bGUoXCJSZXN1bHRzXCIpICtcbiAgICAgICAgICAnPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDtnYXA6ODBweFwiPjxkaXYgc3R5bGU9XCJmbGV4OjFcIj48aDI+TGVmdDwvaDI+PHA+QTwvcD48L2Rpdj48ZGl2IHN0eWxlPVwiZmxleDoxXCI+PGgyPlJpZ2h0PC9oMj48cD5CPC9wPjwvZGl2PjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcImNvbHVtblwiLCBcImxheW91dFwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWRpZmYtMDZcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJkaWZmX2RldGVjdFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkRldGVjdCBhIHR5cG8gZml4LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6IFwiV2hhdCB0eXBvIHdhcyBmaXhlZCBiZXR3ZWVuIHNsaWRlIEEgYW5kIHNsaWRlIEI/IEFuc3dlciB3aXRoIHRoZSBjb3JyZWN0ZWQgd29yZC5cIixcbiAgICAgIHNsaWRlSHRtbDogcyh0aXRsZShcIlJlY2NvbWVuZGF0aW9uc1wiKSArIGJvZHkoXCJXZSByZWNjb21lbmQgbGF1bmNoaW5nIGluIFE0LlwiKSksXG4gICAgICBzbGlkZUh0bWxCOiBzKHRpdGxlKFwiUmVjb21tZW5kYXRpb25zXCIpICsgYm9keShcIldlIHJlY29tbWVuZCBsYXVuY2hpbmcgaW4gUTQuXCIpKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQW55OiBbXCJSZWNvbW1lbmRcIiwgXCJzcGVsbGluZ1wiXSB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gVklTVUFMOiBBRVNUSEVUSUMgU0NPUkUgKDYpID09PT09PT09PT1cbiAge1xuICAgIGlkOiBcInZpcy1hZXMtMDFcIixcbiAgICBjYXRlZ29yeTogXCJ2aXN1YWxcIixcbiAgICBzdWJjYXRlZ29yeTogXCJhZXN0aGV0aWNfc2NvcmVcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlNjb3JlIGEgY2xlYW4sIHdlbGwtYmFsYW5jZWQgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJSYXRlIHRoZSBhZXN0aGV0aWMgcXVhbGl0eSBvZiB0aGlzIHNsaWRlIG9uIGEgMC0xMCBzY2FsZS4gUmVzcG9uZCB3aXRoIG9ubHkgYW4gaW50ZWdlci4gMCBpcyB0ZXJyaWJsZSwgMTAgaXMgcGVyZmVjdC5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2p1c3RpZnktY29udGVudDpjZW50ZXI7aGVpZ2h0OjEwMCU7bWF4LXdpZHRoOjEyMDBweFwiPjxoMSBzdHlsZT1cImZvbnQtc2l6ZTo4OHB4O21hcmdpbjowIDAgMzJweDtmb250LXdlaWdodDo2MDBcIj5PdXIgTm9ydGggU3RhcjwvaDE+PHAgc3R5bGU9XCJmb250LXNpemU6NDBweDtjb2xvcjojNGI1NTYzO2xpbmUtaGVpZ2h0OjEuNDttYXJnaW46MFwiPkEgc2luZ2xlIG1ldHJpYyB3ZSBjb21taXQgdG86IHNoaXAgb25lIGN1c3RvbWVyIHZhbHVlIHBlciB3ZWVrLjwvcD48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IG51bWVyaWNSYW5nZTogWzYsIDEwXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWFlcy0wMlwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImFlc3RoZXRpY19zY29yZVwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2NvcmUgYSBjbHV0dGVyZWQgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJSYXRlIHRoZSBhZXN0aGV0aWMgcXVhbGl0eSBvZiB0aGlzIHNsaWRlIG9uIGEgMC0xMCBzY2FsZS4gUmVzcG9uZCB3aXRoIG9ubHkgYW4gaW50ZWdlci4gMCBpcyB0ZXJyaWJsZSwgMTAgaXMgcGVyZmVjdC5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxoMSBzdHlsZT1cImZvbnQtc2l6ZTo4OHB4O21hcmdpbjowO2NvbG9yOiNmZjAwZmZcIj5VUkdFTlQhISEgUkVBRCEhITwvaDE+JyArXG4gICAgICAgICAgYnVsbGV0cyhBcnJheS5mcm9tKHsgbGVuZ3RoOiAxNCB9KS5tYXAoKF8sIGkpID0+IGBSZWFsbHkgaW1wb3J0YW50IHBvaW50IG51bWJlciAke2kgKyAxfWApKSArXG4gICAgICAgICAgJzxwIHN0eWxlPVwiZm9udC1zaXplOjI4cHg7Y29sb3I6cmVkO3Bvc2l0aW9uOmFic29sdXRlO3RvcDoyMHB4O3JpZ2h0OjIwcHhcIj4qKiogQVNBUCAqKio8L3A+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBudW1lcmljUmFuZ2U6IFswLCA1XSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWFlcy0wM1wiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImFlc3RoZXRpY19zY29yZVwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlNjb3JlIGEgc2xpZGUgd2l0aCBwb29yIGNvbnRyYXN0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiUmF0ZSB0aGUgYWVzdGhldGljIHF1YWxpdHkgb2YgdGhpcyBzbGlkZSBvbiBhIDAtMTAgc2NhbGUuIFJlc3BvbmQgd2l0aCBvbmx5IGFuIGludGVnZXIuIDAgaXMgdGVycmlibGUsIDEwIGlzIHBlcmZlY3QuXCIsXG4gICAgICBzbGlkZUh0bWw6IHMoXG4gICAgICAgICc8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDojZjhmOGY4O2NvbG9yOiNlOGU4ZTg7cGFkZGluZzo4MHB4O2hlaWdodDoxMDAlO21hcmdpbjotODBweFwiPjxoMSBzdHlsZT1cImZvbnQtc2l6ZTo4OHB4XCI+V2hpc3BlcjwvaDE+PHAgc3R5bGU9XCJmb250LXNpemU6MzZweFwiPkNhbiB5b3UgZXZlbiBzZWUgdGhpcz88L3A+PC9kaXY+JyxcbiAgICAgICksXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBudW1lcmljUmFuZ2U6IFswLCA1XSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwidmlzLWFlcy0wNFwiLFxuICAgIGNhdGVnb3J5OiBcInZpc3VhbFwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImFlc3RoZXRpY19zY29yZVwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU2NvcmUgYSBoaWdoLWNvbnRyYXN0IG1pbmltYWxpc3Qgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJSYXRlIHRoZSBhZXN0aGV0aWMgcXVhbGl0eSBvZiB0aGlzIHNsaWRlIG9uIGEgMC0xMCBzY2FsZS4gUmVzcG9uZCB3aXRoIG9ubHkgYW4gaW50ZWdlci4gMCBpcyB0ZXJyaWJsZSwgMTAgaXMgcGVyZmVjdC5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiMxMTE7Y29sb3I6I2ZmZjtwYWRkaW5nOjgwcHg7aGVpZ2h0OjEwMCU7bWFyZ2luOi04MHB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXJcIj48aDEgc3R5bGU9XCJmb250LXNpemU6MTYwcHg7bWFyZ2luOjA7Zm9udC13ZWlnaHQ6NzAwXCI+TGVzcy48L2gxPjwvZGl2PicsXG4gICAgICApLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgbnVtZXJpY1JhbmdlOiBbNiwgMTBdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtYWVzLTA1XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiYWVzdGhldGljX3Njb3JlXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJTY29yZSBhIHRleHQtd2FsbCBzbGlkZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICBcIlJhdGUgdGhlIGFlc3RoZXRpYyBxdWFsaXR5IG9mIHRoaXMgc2xpZGUgb24gYSAwLTEwIHNjYWxlLiBSZXNwb25kIHdpdGggb25seSBhbiBpbnRlZ2VyLiAwIGlzIHRlcnJpYmxlLCAxMCBpcyBwZXJmZWN0LlwiLFxuICAgICAgc2xpZGVIdG1sOiBzKFxuICAgICAgICB0aXRsZShcIkJhY2tncm91bmRcIikgK1xuICAgICAgICAgIGA8cCBzdHlsZT1cImZvbnQtc2l6ZToyOHB4O2xpbmUtaGVpZ2h0OjEuNVwiPiR7XCJMb3JlbSBpcHN1bSBkb2xvciBzaXQgYW1ldCwgY29uc2VjdGV0dXIgYWRpcGlzY2luZyBlbGl0LiBcIi5yZXBlYXQoMjUpfTwvcD5gLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IG51bWVyaWNSYW5nZTogWzAsIDVdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2aXMtYWVzLTA2XCIsXG4gICAgY2F0ZWdvcnk6IFwidmlzdWFsXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiYWVzdGhldGljX3Njb3JlXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJTY29yZSBhIHdlbGwtdHlwb2dyYXBoZWQgcXVvdGUgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJSYXRlIHRoZSBhZXN0aGV0aWMgcXVhbGl0eSBvZiB0aGlzIHNsaWRlIG9uIGEgMC0xMCBzY2FsZS4gUmVzcG9uZCB3aXRoIG9ubHkgYW4gaW50ZWdlci4gMCBpcyB0ZXJyaWJsZSwgMTAgaXMgcGVyZmVjdC5cIixcbiAgICAgIHNsaWRlSHRtbDogcyhcbiAgICAgICAgJzxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2p1c3RpZnktY29udGVudDpjZW50ZXI7aGVpZ2h0OjEwMCU7bWF4LXdpZHRoOjE0MDBweFwiPjxwIHN0eWxlPVwiZm9udC1zaXplOjcycHg7Zm9udC1zdHlsZTppdGFsaWM7Zm9udC13ZWlnaHQ6MzAwO2xpbmUtaGVpZ2h0OjEuMzttYXJnaW46MFwiPlwiVGhlIGZ1dHVyZSBpcyBhbHJlYWR5IGhlcmUgXHUyMDE0IGl0XFwncyBqdXN0IG5vdCBldmVubHkgZGlzdHJpYnV0ZWQuXCI8L3A+PHAgc3R5bGU9XCJmb250LXNpemU6MzZweDtjb2xvcjojNmI3MjgwO21hcmdpbi10b3A6NTZweFwiPlx1MjAxNCBXaWxsaWFtIEdpYnNvbjwvcD48L2Rpdj4nLFxuICAgICAgKSxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IG51bWVyaWNSYW5nZTogWzYsIDEwXSB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gQUNUSU9OOiBHRU5FUkFURSBIVE1MICgxMCkgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwiZ2VuLWh0bWwtMDFcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJnZW5lcmF0ZV9odG1sXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2VuZXJhdGUgYSB0aXRsZStib2R5IHNsaWRlIGFib3V0IFEzIHJlc3VsdHMuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1dyaXRlIGEgY29tcGxldGUgc2VsZi1jb250YWluZWQgSFRNTCA8c2VjdGlvbj4gZm9yIGEgMTkyMHgxMDgwIHNsaWRlIHRpdGxlZCBcIlEzIFJlc3VsdHNcIi4gQm9keTogXCJSZXZlbnVlIHVwIDQyJSBZb1ksIEFSUiBub3cgYXQgJDE4TS5cIiBVc2UgaW5saW5lIHN0eWxlcy4gT3V0cHV0IE9OTFkgdGhlIDxzZWN0aW9uPi4uLjwvc2VjdGlvbj4gZWxlbWVudCwgbm8gbWFya2Rvd24gZmVuY2VzLicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcIjxzZWN0aW9uXCIsIFwiUTNcIiwgXCI0MlwiLCBcIjE4XCJdLFxuICAgICAgY29udGFpbnNOb25lOiBbXCJgYGBcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImdlbi1odG1sLTAyXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZ2VuZXJhdGVfaHRtbFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdlbmVyYXRlIGEgc2VjdGlvbiBkaXZpZGVyIHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdXcml0ZSBhIGNvbXBsZXRlIHNlbGYtY29udGFpbmVkIEhUTUwgPHNlY3Rpb24+IGZvciBhIDE5MjB4MTA4MCBzZWN0aW9uLWRpdmlkZXIgc2xpZGUgd2l0aCBhIHNpbmdsZSBsYXJnZSBjZW50ZXJlZCB3b3JkOiBcIkNvbmNsdXNpb25cIi4gVXNlIGEgZGFyayBiYWNrZ3JvdW5kIGFuZCBsYXJnZSB3aGl0ZSB0ZXh0LiBPdXRwdXQgT05MWSB0aGUgPHNlY3Rpb24+Li4uPC9zZWN0aW9uPi4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCI8c2VjdGlvblwiLCBcIkNvbmNsdXNpb25cIl0sXG4gICAgICBjb250YWluc0FueTogW1wiIzAwMFwiLCBcIiMxMTFcIiwgXCIjMFwiLCBcImJsYWNrXCIsIFwiZGFya1wiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZ2VuLWh0bWwtMDNcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJnZW5lcmF0ZV9odG1sXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJHZW5lcmF0ZSBhIHR3by1jb2x1bW4gcHJvcy9jb25zIHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiV3JpdGUgYSBjb21wbGV0ZSA8c2VjdGlvbj4gZm9yIGEgMTkyMHgxMDgwIHR3by1jb2x1bW4gc2xpZGUgY29tcGFyaW5nIFJFU1QgKHByb3M6IHNpbXBsZSwgY2FjaGVhYmxlOyBjb25zOiBjaGF0dHksIG92ZXItZmV0Y2gpIHZzIEdyYXBoUUwgKHByb3M6IGZsZXhpYmxlLCBvbmUgZW5kcG9pbnQ7IGNvbnM6IGNvbXBsZXgsIGNhY2hpbmcgaGFyZCkuIE91dHB1dCBvbmx5IHRoZSA8c2VjdGlvbj4uXCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcIjxzZWN0aW9uXCIsIFwiUkVTVFwiLCBcIkdyYXBoUUxcIl0sXG4gICAgICBjb250YWluc0FueTogW1wiY29sdW1uXCIsIFwiZmxleFwiLCBcImdyaWRcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImdlbi1odG1sLTA0XCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZ2VuZXJhdGVfaHRtbFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdlbmVyYXRlIGEgcXVvdGUgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1dyaXRlIGEgY29tcGxldGUgPHNlY3Rpb24+IGZvciBhIDE5MjB4MTA4MCBxdW90ZSBzbGlkZSB3aXRoIHRoZSBxdW90ZSBcIk1ha2UgaXQgd29yaywgbWFrZSBpdCByaWdodCwgbWFrZSBpdCBmYXN0LlwiIGF0dHJpYnV0ZWQgdG8gS2VudCBCZWNrLiBJdGFsaWMgcXVvdGUsIGF1dGhvciBiZWxvdywgY2VudGVyZWQgdmVydGljYWxseS4gT3V0cHV0IG9ubHkgdGhlIDxzZWN0aW9uPi4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCI8c2VjdGlvblwiLCBcIktlbnQgQmVja1wiLCBcIk1ha2UgaXQgd29ya1wiXSxcbiAgICAgIGNvbnRhaW5zQW55OiBbXCJpdGFsaWNcIiwgXCJpdGFsaWNzXCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJnZW4taHRtbC0wNVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImdlbmVyYXRlX2h0bWxcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdlbmVyYXRlIGEgZml2ZS1idWxsZXQgYWdlbmRhLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiV3JpdGUgYSBjb21wbGV0ZSA8c2VjdGlvbj4gZm9yIGEgMTkyMHgxMDgwIGFnZW5kYSBzbGlkZSBmb3IgYSAzMC1taW51dGUgcHJvZHVjdCByZXZpZXcuIDUgbnVtYmVyZWQgYnVsbGV0cyBjb3ZlcmluZyBpbnRybywgdXNlciByZXNlYXJjaCwgZGVzaWduLCBlbmdpbmVlcmluZywgUSZBLiBPdXRwdXQgb25seSB0aGUgPHNlY3Rpb24+LlwiLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCI8c2VjdGlvblwiLCBcIkFnZW5kYVwiXSxcbiAgICAgIGNvbnRhaW5zQW55OiBbXCI8b2xcIiwgXCI8dWxcIiwgXCIxLlwiLCBcIlx1MjQ2MFwiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZ2VuLWh0bWwtMDZcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJnZW5lcmF0ZV9odG1sXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2VuZXJhdGUgYSB0aXRsZStzdWJ0aXRsZSBzbGlkZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnV3JpdGUgYSBjb21wbGV0ZSA8c2VjdGlvbj4gZm9yIGEgMTkyMHgxMDgwIG9wZW5pbmcgc2xpZGU6IHRpdGxlIFwiUHJvamVjdCBPcmlvblwiLCBzdWJ0aXRsZSBcIkEgcGxhdGZvcm0gZm9yIHNwYWNlIGxvZ2lzdGljc1wiLiBDZW50ZXJlZCwgbGFyZ2UgdGl0bGUuIE91dHB1dCBvbmx5IHRoZSA8c2VjdGlvbj4uJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7IGNvbnRhaW5zQWxsOiBbXCJQcm9qZWN0IE9yaW9uXCIsIFwic3BhY2UgbG9naXN0aWNzXCJdIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJnZW4taHRtbC0wN1wiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImdlbmVyYXRlX2h0bWxcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdlbmVyYXRlIGFuIGltYWdlLXJpZ2h0IGxheW91dC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnV3JpdGUgYSBjb21wbGV0ZSA8c2VjdGlvbj4gZm9yIGEgMTkyMHgxMDgwIHNsaWRlIHdpdGggdGV4dCBvbiB0aGUgbGVmdCBhbmQgYSBwbGFjZWhvbGRlciBpbWFnZSBib3ggb24gdGhlIHJpZ2h0LiBUaXRsZTogXCJGYXN0IG9uYm9hcmRpbmdcIi4gQm9keTogXCJUaHJlZSBjbGlja3MgdG8gZmlyc3QgdmFsdWUuXCIgSW1hZ2UgYm94OiBncmF5IGJhY2tncm91bmQsIHJvdW5kZWQgY29ybmVycywgXCJbaGVybyBpbWFnZV1cIiBwbGFjZWhvbGRlci4gT3V0cHV0IG9ubHkgdGhlIDxzZWN0aW9uPi4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCI8c2VjdGlvblwiLCBcIkZhc3Qgb25ib2FyZGluZ1wiLCBcIlRocmVlIGNsaWNrc1wiXSxcbiAgICAgIGNvbnRhaW5zQW55OiBbXCJmbGV4XCIsIFwiZ3JpZFwiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZ2VuLWh0bWwtMDhcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJnZW5lcmF0ZV9odG1sXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJHZW5lcmF0ZSBhIHByaWNpbmcgdGFibGUgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJXcml0ZSBhIGNvbXBsZXRlIDxzZWN0aW9uPiBmb3IgYSAxOTIweDEwODAgcHJpY2luZyBzbGlkZSB3aXRoIGEgM3gzIEhUTUwgdGFibGU6IFBsYW4gKEZyZWUvUHJvL1RlYW0pLCBQcmljZSAoJDAvJDI5LyQ5OSksIFNlYXRzICgxLzUvMjUpLiBPdXRwdXQgb25seSB0aGUgPHNlY3Rpb24+LlwiLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCI8c2VjdGlvblwiLCBcIjx0YWJsZVwiLCBcIiQyOVwiLCBcIkZyZWVcIiwgXCJUZWFtXCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJnZW4taHRtbC0wOVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImdlbmVyYXRlX2h0bWxcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJHZW5lcmF0ZSBhIGNsb3NpbmcgdGhhbmsteW91IHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdXcml0ZSBhIGNvbXBsZXRlIDxzZWN0aW9uPiBmb3IgYSAxOTIweDEwODAgY2xvc2luZyBzbGlkZTogbGFyZ2UgXCJUaGFuayB5b3VcIiBjZW50ZXJlZCwgZW1haWwgXCJoaUBleGFtcGxlLmNvbVwiIGJlbG93LiBPdXRwdXQgb25seSB0aGUgPHNlY3Rpb24+LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiVGhhbmsgeW91XCIsIFwiaGlAZXhhbXBsZS5jb21cIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImdlbi1odG1sLTEwXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZ2VuZXJhdGVfaHRtbFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2VuZXJhdGUgYSBzbGlkZSB3aXRoIGEgY29kZSBzbmlwcGV0LlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdXcml0ZSBhIGNvbXBsZXRlIDxzZWN0aW9uPiBmb3IgYSAxOTIweDEwODAgc2xpZGUgc2hvd2luZyB0aGlzIHNuaXBwZXQgaW4gYSBtb25vc3BhY2UgYmxvY2s6IGBjb25zdCBzdW0gPSAoYSwgYikgPT4gYSArIGI7YC4gVGl0bGU6IFwiU2ltcGxlIHN1bVwiLiBPdXRwdXQgb25seSB0aGUgPHNlY3Rpb24+LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcIlNpbXBsZSBzdW1cIiwgXCJzdW1cIl0sXG4gICAgICBjb250YWluc0FueTogW1wiPHByZVwiLCBcIjxjb2RlXCIsIFwibW9ub3NwYWNlXCJdLFxuICAgIH0sXG4gIH0sXG5cbiAgLy8gPT09PT09PT09PSBBQ1RJT046IFBJQ0sgTEFZT1VUICg2KSA9PT09PT09PT09XG4gIHtcbiAgICBpZDogXCJwaWNrLTAxXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwicGlja19sYXlvdXRcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJQaWNrIGxheW91dCBmb3IgYSBmaXZlLWJ1bGxldCBjb250ZW50IHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdHaXZlbiB0aGlzIGNvbnRlbnQgZGVzY3JpcHRpb24sIHBpY2sgZXhhY3RseSBvbmUgbGF5b3V0IGZyb206IHRpdGxlX29ubHksIHRpdGxlX2FuZF9ib2R5LCB0d29fY29sdW1uLCBpbWFnZV9yaWdodCwgc2VjdGlvbl9kaXZpZGVyLCBxdW90ZS4gUmVzcG9uZCB3aXRoIG9ubHkgdGhlIGxheW91dCBuYW1lLlxcblxcbkNvbnRlbnQ6IFwiRml2ZSBidWxsZXRzIHN1bW1hcml6aW5nIFEzIHdpbnNcIicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1widGl0bGVfYW5kX2JvZHlcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBpY2stMDJcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJwaWNrX2xheW91dFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBpY2sgbGF5b3V0IGZvciBhIHNpbmdsZSBoZXJvIG51bWJlci5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnR2l2ZW4gdGhpcyBjb250ZW50IGRlc2NyaXB0aW9uLCBwaWNrIGV4YWN0bHkgb25lIGxheW91dCBmcm9tOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuIFJlc3BvbmQgd2l0aCBvbmx5IHRoZSBsYXlvdXQgbmFtZS5cXG5cXG5Db250ZW50OiBcIkEgc2luZ2xlIGxhcmdlIGhlcm8gbWV0cmljOiA0MiUgZ3Jvd3RoXCInLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcInRpdGxlX29ubHlcIiwgXCJzZWN0aW9uX2RpdmlkZXJcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBpY2stMDNcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJwaWNrX2xheW91dFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBpY2sgbGF5b3V0IGZvciBhIGZhbW91cyBxdW90ZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnR2l2ZW4gdGhpcyBjb250ZW50IGRlc2NyaXB0aW9uLCBwaWNrIGV4YWN0bHkgb25lIGxheW91dCBmcm9tOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuIFJlc3BvbmQgd2l0aCBvbmx5IHRoZSBsYXlvdXQgbmFtZS5cXG5cXG5Db250ZW50OiBcIkEgU3RldmUgSm9icyBxdW90ZSBhYm91dCBkZXNpZ25cIicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wicXVvdGVcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBpY2stMDRcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJwaWNrX2xheW91dFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUGljayBsYXlvdXQgZm9yIGEgaGVhZC10by1oZWFkIGNvbXBhcmlzb24uXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0dpdmVuIHRoaXMgY29udGVudCBkZXNjcmlwdGlvbiwgcGljayBleGFjdGx5IG9uZSBsYXlvdXQgZnJvbTogdGl0bGVfb25seSwgdGl0bGVfYW5kX2JvZHksIHR3b19jb2x1bW4sIGltYWdlX3JpZ2h0LCBzZWN0aW9uX2RpdmlkZXIsIHF1b3RlLiBSZXNwb25kIHdpdGggb25seSB0aGUgbGF5b3V0IG5hbWUuXFxuXFxuQ29udGVudDogXCJSZWFjdCB2cyBWdWUgaGVhZC10by1oZWFkIGNvbXBhcmlzb25cIicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1widHdvX2NvbHVtblwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicGljay0wNVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInBpY2tfbGF5b3V0XCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJQaWNrIGxheW91dCBmb3IgYSBmZWF0dXJlK3NjcmVlbnNob3Qgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0dpdmVuIHRoaXMgY29udGVudCBkZXNjcmlwdGlvbiwgcGljayBleGFjdGx5IG9uZSBsYXlvdXQgZnJvbTogdGl0bGVfb25seSwgdGl0bGVfYW5kX2JvZHksIHR3b19jb2x1bW4sIGltYWdlX3JpZ2h0LCBzZWN0aW9uX2RpdmlkZXIsIHF1b3RlLiBSZXNwb25kIHdpdGggb25seSB0aGUgbGF5b3V0IG5hbWUuXFxuXFxuQ29udGVudDogXCJBIHNpbmdsZSBmZWF0dXJlIGRlc2NyaXB0aW9uIHdpdGggYSBwcm9kdWN0IHNjcmVlbnNob3RcIicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wiaW1hZ2VfcmlnaHRcIl0gfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBpY2stMDZcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJwaWNrX2xheW91dFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBpY2sgbGF5b3V0IGZvciBhIHNlY3Rpb24gdHJhbnNpdGlvbi5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnR2l2ZW4gdGhpcyBjb250ZW50IGRlc2NyaXB0aW9uLCBwaWNrIGV4YWN0bHkgb25lIGxheW91dCBmcm9tOiB0aXRsZV9vbmx5LCB0aXRsZV9hbmRfYm9keSwgdHdvX2NvbHVtbiwgaW1hZ2VfcmlnaHQsIHNlY3Rpb25fZGl2aWRlciwgcXVvdGUuIFJlc3BvbmQgd2l0aCBvbmx5IHRoZSBsYXlvdXQgbmFtZS5cXG5cXG5Db250ZW50OiBcIlRyYW5zaXRpb24gYmV0d2VlbiBQYXJ0IEkgKFByb2JsZW0pIGFuZCBQYXJ0IElJIChTb2x1dGlvbilcIicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FsbDogW1wic2VjdGlvbl9kaXZpZGVyXCJdIH0sXG4gIH0sXG5cbiAgLy8gPT09PT09PT09PSBBQ1RJT046IFdSSVRFIFBQVFhHRU5KUyAoOCkgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwicHB0LTAxXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwid3JpdGVfcHB0eGdlbmpzXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW1pdCBwcHR4Z2VuanMgY29kZSBmb3IgYSB0aXRsZSBzbGlkZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnV3JpdGUgYSBKYXZhU2NyaXB0IHNuaXBwZXQgdXNpbmcgcHB0eGdlbmpzIHRoYXQgYWRkcyBhIHRpdGxlIHNsaWRlIHNheWluZyBcIldlbGNvbWUgdG8gQWNtZVwiIHRvIGFuIGV4aXN0aW5nIGBwcHR4YCBpbnN0YW5jZS4gVXNlIGBzbGlkZS5hZGRUZXh0YC4gT3V0cHV0IG9ubHkgdGhlIGNvZGUuJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBjb250YWluc0FsbDogW1wiYWRkVGV4dFwiLCBcIldlbGNvbWUgdG8gQWNtZVwiXSxcbiAgICAgIGNvZGVSdW5zOiB0cnVlLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwcHQtMDJcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJ3cml0ZV9wcHR4Z2VuanNcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJFbWl0IHBwdHhnZW5qcyBidWxsZXQgbGlzdC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnV3JpdGUgYSBKYXZhU2NyaXB0IHNuaXBwZXQgdXNpbmcgcHB0eGdlbmpzIHRoYXQgYWRkcyBhIHNsaWRlIHdpdGggMyBidWxsZXRzOiBcIlNwZWVkXCIsIFwiU2NhbGVcIiwgXCJTaW1wbGljaXR5XCIuIFVzZSBhZGRUZXh0IHdpdGggYSBidWxsZXQgb3B0aW9uLiBPdXRwdXQgb25seSB0aGUgY29kZS4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJhZGRUZXh0XCIsIFwiU3BlZWRcIiwgXCJTY2FsZVwiLCBcIlNpbXBsaWNpdHlcIl0sXG4gICAgICBjb250YWluc0FueTogW1wiYnVsbGV0XCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBwdC0wM1wiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcIndyaXRlX3BwdHhnZW5qc1wiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW1pdCBwcHR4Z2VuanMgdGFibGUgY29kZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICBcIldyaXRlIEphdmFTY3JpcHQgdXNpbmcgcHB0eGdlbmpzIHRoYXQgYWRkcyBhIHRhYmxlIHdpdGggaGVhZGVycyBbUGxhbiwgUHJpY2VdIGFuZCByb3dzIFtbRnJlZSwgJDBdLCBbUHJvLCAkMjldXS4gT3V0cHV0IG9ubHkgdGhlIGNvZGUuXCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcImFkZFRhYmxlXCIsIFwiRnJlZVwiLCBcIlByb1wiXSxcbiAgICAgIGNvZGVSdW5zOiB0cnVlLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwcHQtMDRcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJ3cml0ZV9wcHR4Z2VuanNcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkVtaXQgcHB0eGdlbmpzIGFkZEltYWdlIGNvZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJXcml0ZSBKYXZhU2NyaXB0IHVzaW5nIHBwdHhnZW5qcyB0aGF0IGFkZHMgYSBzbGlkZSB3aXRoIGFuIGltYWdlIGZyb20gcGF0aCAnLi9oZXJvLnBuZycgcG9zaXRpb25lZCBhdCB4PTEsIHk9MSwgdz01LCBoPTMgaW5jaGVzLiBPdXRwdXQgb25seSB0aGUgY29kZS5cIixcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBjb250YWluc0FsbDogW1wiYWRkSW1hZ2VcIiwgXCJoZXJvLnBuZ1wiXSxcbiAgICAgIGNvZGVSdW5zOiB0cnVlLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwcHQtMDVcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJ3cml0ZV9wcHR4Z2VuanNcIixcbiAgICBkaWZmaWN1bHR5OiBcImhhcmRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJFbWl0IHBwdHhnZW5qcyBsaW5lIGNoYXJ0IGNvZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJXcml0ZSBKYXZhU2NyaXB0IHVzaW5nIHBwdHhnZW5qcyB0aGF0IGFkZHMgYSBsaW5lIGNoYXJ0IHdpdGggZGF0YSBmb3IgSmFuPTEwLCBGZWI9MTQsIE1hcj0yMi4gVXNlIGFkZENoYXJ0LiBPdXRwdXQgb25seSB0aGUgY29kZS5cIixcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBjb250YWluc0FsbDogW1wiYWRkQ2hhcnRcIiwgXCJKYW5cIiwgXCJGZWJcIiwgXCJNYXJcIl0sXG4gICAgICBjb250YWluc0FueTogW1wiTElORVwiLCBcImxpbmVcIl0sXG4gICAgICBjb2RlUnVuczogdHJ1ZSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicHB0LTA2XCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwid3JpdGVfcHB0eGdlbmpzXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW1pdCBwcHR4Z2VuanMgYmFyIGNoYXJ0IGNvZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJXcml0ZSBKYXZhU2NyaXB0IHVzaW5nIHBwdHhnZW5qcyB0aGF0IGFkZHMgYSBiYXIgY2hhcnQgY29tcGFyaW5nIHJldmVudWUgZm9yIHRocmVlIHJlZ2lvbnM6IE5vcnRoPTQwLCBTb3V0aD0yMiwgRWFzdD0xOC4gT3V0cHV0IG9ubHkgdGhlIGNvZGUuXCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcImFkZENoYXJ0XCIsIFwiTm9ydGhcIiwgXCJTb3V0aFwiLCBcIkVhc3RcIl0sXG4gICAgICBjb250YWluc0FueTogW1wiQkFSXCIsIFwiYmFyXCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBwdC0wN1wiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcIndyaXRlX3BwdHhnZW5qc1wiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW1pdCBwcHR4Z2VuanMgYWRkU2hhcGUgY29kZS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICBcIldyaXRlIEphdmFTY3JpcHQgdXNpbmcgcHB0eGdlbmpzIHRoYXQgYWRkcyBhIGJsdWUgcmVjdGFuZ2xlIGNvdmVyaW5nIHRoZSBsZWZ0IHRoaXJkIG9mIGEgc2xpZGUsIHRoZW4gYWRkcyB3aGl0ZSB0ZXh0ICdTZWN0aW9uJyBvbiB0b3Agb2YgaXQuIE91dHB1dCBvbmx5IHRoZSBjb2RlLlwiLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJhZGRTaGFwZVwiLCBcImFkZFRleHRcIiwgXCJTZWN0aW9uXCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBwdC0wOFwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcIndyaXRlX3BwdHhnZW5qc1wiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW1pdCBwcHR4Z2VuanMgc3BlYWtlciBub3RlcyBjb2RlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdXcml0ZSBKYXZhU2NyaXB0IHVzaW5nIHBwdHhnZW5qcyB0aGF0IGFkZHMgc3BlYWtlciBub3RlcyB0byBhIHNsaWRlOiBcIlJlbWVtYmVyIHRvIHBhdXNlIGZvciBxdWVzdGlvbnMgYWZ0ZXIgc2xpZGUgMy5cIiBPdXRwdXQgb25seSB0aGUgY29kZS4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJhZGROb3Rlc1wiLCBcInBhdXNlIGZvciBxdWVzdGlvbnNcIl0sXG4gICAgICBjb2RlUnVuczogdHJ1ZSxcbiAgICB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gQUNUSU9OOiBGSVggQlVHICg2KSA9PT09PT09PT09XG4gIHtcbiAgICBpZDogXCJmaXgtMDFcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJmaXhfYnVnXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiRml4IHR5cG8gaW4gcHB0eGdlbmpzIG1ldGhvZCBuYW1lLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiVGhpcyBjb2RlIHRocm93cyAnc2xpZGUuYWRkVHh0IGlzIG5vdCBhIGZ1bmN0aW9uJy4gRml4IHRoZSBidWcgYW5kIG91dHB1dCB0aGUgY29ycmVjdGVkIGNvZGUgb25seS5cIixcbiAgICAgIGNvZGU6IFwiY29uc3Qgc2xpZGUgPSBwcHR4LmFkZFNsaWRlKCk7XFxuc2xpZGUuYWRkVHh0KCdIZWxsbycsIHsgeDogMSwgeTogMSwgdzogNSwgaDogMSB9KTtcIixcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBjb250YWluc0FsbDogW1wiYWRkVGV4dFwiXSxcbiAgICAgIGNvbnRhaW5zTm9uZTogW1wiYWRkVHh0XCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImZpeC0wMlwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImZpeF9idWdcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFkZCBtaXNzaW5nIGF3YWl0IGJlZm9yZSB3cml0ZUZpbGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJUaGlzIGFzeW5jIGZ1bmN0aW9uIHJldHVybnMgYmVmb3JlIHRoZSBmaWxlIGlzIHdyaXR0ZW4uIEZpeCBpdCBhbmQgb3V0cHV0IHRoZSBjb3JyZWN0ZWQgY29kZSBvbmx5LlwiLFxuICAgICAgY29kZTogXCJhc3luYyBmdW5jdGlvbiBzYXZlKHBwdHgpIHtcXG4gIGNvbnN0IHNsaWRlID0gcHB0eC5hZGRTbGlkZSgpO1xcbiAgc2xpZGUuYWRkVGV4dCgnSGknLCB7IHg6IDEsIHk6IDEgfSk7XFxuICBwcHR4LndyaXRlRmlsZSh7IGZpbGVOYW1lOiAnb3V0LnBwdHgnIH0pO1xcbiAgcmV0dXJuICdkb25lJztcXG59XCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcImF3YWl0XCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImZpeC0wM1wiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImZpeF9idWdcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpeCB1bml0IGNvbmZ1c2lvbiBcdTIwMTQgcHB0eGdlbmpzIHVzZXMgaW5jaGVzLCBub3QgcGl4ZWxzLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgIFwiVGhpcyBjb2RlIGludGVuZHMgdG8gcGxhY2UgdGV4dCBuZWFyIHRoZSB0b3AtbGVmdCB3aXRoIGEgc21hbGwgb2Zmc2V0IGJ1dCB1c2VzIHBpeGVscy4gcHB0eGdlbmpzIHVzZXMgaW5jaGVzLiBGaXggaXQgKGFzc3VtZSA5NiBkcGkpIGFuZCBvdXRwdXQgdGhlIGNvcnJlY3RlZCBjb2RlIG9ubHkuXCIsXG4gICAgICBjb2RlOiBcInNsaWRlLmFkZFRleHQoJ0hlYWRlcicsIHsgeDogOTYsIHk6IDk2LCB3OiA0ODAsIGg6IDQ4IH0pO1wiLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJhZGRUZXh0XCJdLFxuICAgICAgY29udGFpbnNOb25lOiBbXCI5NlwiXSxcbiAgICAgIGNvZGVSdW5zOiB0cnVlLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJmaXgtMDRcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJmaXhfYnVnXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJGaXggb2ZmLWJ5LW9uZSBpbiBhIGxvb3AgdGhhdCBzaG91bGQgcHJvZHVjZSA1IGJ1bGxldHMuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJUaGlzIGNvZGUgaXMgc3VwcG9zZWQgdG8gcHJvZHVjZSA1IGJ1bGxldCBsaW5lcyBidXQgb25seSBwcm9kdWNlcyA0LiBGaXggaXQgYW5kIG91dHB1dCB0aGUgY29ycmVjdGVkIGNvZGUgb25seS5cIixcbiAgICAgIGNvZGU6IFwiY29uc3QgaXRlbXMgPSBbJ0EnLCAnQicsICdDJywgJ0QnLCAnRSddO1xcbmxldCB0ZXh0ID0gJyc7XFxuZm9yIChsZXQgaSA9IDA7IGkgPCBpdGVtcy5sZW5ndGggLSAxOyBpKyspIHtcXG4gIHRleHQgKz0gJ1x1MjAyMiAnICsgaXRlbXNbaV0gKyAnXFxcXG4nO1xcbn1cXG5zbGlkZS5hZGRUZXh0KHRleHQsIHsgeDogMSwgeTogMSwgdzogOCwgaDogNCB9KTtcIixcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBjb250YWluc0FsbDogW1wiaXRlbXMubGVuZ3RoXCJdLFxuICAgICAgY29udGFpbnNOb25lOiBbXCJsZW5ndGggLSAxXCIsIFwibGVuZ3RoLTFcIl0sXG4gICAgICBjb2RlUnVuczogdHJ1ZSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZml4LTA1XCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZml4X2J1Z1wiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQWRkIGEgbnVsbCBjaGVjayBiZWZvcmUgYWNjZXNzaW5nIG9wdGlvbmFsIGltYWdlIFVSTC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICBcIlRoaXMgY29kZSBjcmFzaGVzIHdoZW4gYHNsaWRlRGF0YS5pbWFnZWAgaXMgdW5kZWZpbmVkLiBBZGQgYSBndWFyZCBhbmQgb3V0cHV0IHRoZSBjb3JyZWN0ZWQgY29kZSBvbmx5LlwiLFxuICAgICAgY29kZTogXCJmdW5jdGlvbiByZW5kZXIoc2xpZGVEYXRhLCBzbGlkZSkge1xcbiAgc2xpZGUuYWRkVGV4dChzbGlkZURhdGEudGl0bGUsIHsgeDogMSwgeTogMSB9KTtcXG4gIHNsaWRlLmFkZEltYWdlKHsgcGF0aDogc2xpZGVEYXRhLmltYWdlLnVybCwgeDogMSwgeTogMiwgdzogNCwgaDogMyB9KTtcXG59XCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbnk6IFtcImlmIChcIiwgXCI/LlwiLCBcIiYmXCIsIFwic2xpZGVEYXRhLmltYWdlXCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImZpeC0wNlwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImZpeF9idWdcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpeCB3cm9uZyBzbGlkZSByYXRpbyBcdTIwMTQgc2hvdWxkIGJlIDE2OjkuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgXCJUaGlzIGNvZGUgY3JlYXRlcyBhIDQ6MyBwcmVzZW50YXRpb24gYnV0IHdlIHdhbnQgMTY6OSAod2lkZXNjcmVlbikuIEZpeCB0aGUgcHB0eGdlbmpzIGNvbmZpZyBhbmQgb3V0cHV0IHRoZSBjb3JyZWN0ZWQgY29kZSBvbmx5LlwiLFxuICAgICAgY29kZTogXCJjb25zdCBwcHR4ID0gbmV3IHBwdHhnZW4oKTtcXG5wcHR4LmxheW91dCA9ICdMQVlPVVRfNHgzJztcXG5wcHR4LmFkZFNsaWRlKCkuYWRkVGV4dCgnSGVsbG8nLCB7IHg6IDEsIHk6IDEgfSk7XCIsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgY29udGFpbnNBbGw6IFtcIkxBWU9VVF9XSURFXCJdLFxuICAgICAgY29udGFpbnNOb25lOiBbXCJMQVlPVVRfNHgzXCJdLFxuICAgICAgY29kZVJ1bnM6IHRydWUsXG4gICAgfSxcbiAgfSxcblxuICAvLyA9PT09PT09PT09IEFDVElPTjogRURJVCBPUCAoOCkgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwiZWRpdC0wMVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImVkaXRfb3BcIixcbiAgICBkaWZmaWN1bHR5OiBcImVhc3lcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBZGQgYSBidWxsZXQgdG8gYW4gZXhpc3Rpbmcgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0N1cnJlbnQgc2xpZGUgaGFzIGJ1bGxldHM6IFwiSW50cm9cIiwgXCJEZW1vXCIsIFwiUSZBXCIuIEFkZCBhIG5ldyBidWxsZXQgXCJQcmljaW5nXCIgYmVmb3JlIFwiUSZBXCIuIE91dHB1dCB0aGUgdXBkYXRlZCBidWxsZXQgbGlzdCBhcyBhIEpTT04gYXJyYXkgb2Ygc3RyaW5ncywgbm90aGluZyBlbHNlLicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcIkludHJvXCIsIFwiRGVtb1wiLCBcIlByaWNpbmdcIiwgXCJRJkFcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImVkaXQtMDJcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJlZGl0X29wXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVtb3ZlIGEgYnVsbGV0IGZyb20gYW4gZXhpc3Rpbmcgc2xpZGUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0N1cnJlbnQgc2xpZGUgaGFzIGJ1bGxldHM6IFwiQWxwaGFcIiwgXCJCZXRhXCIsIFwiR2FtbWFcIiwgXCJEZWx0YVwiLiBSZW1vdmUgXCJHYW1tYVwiLiBPdXRwdXQgdGhlIHVwZGF0ZWQgYnVsbGV0IGxpc3QgYXMgYSBKU09OIGFycmF5IG9mIHN0cmluZ3MsIG5vdGhpbmcgZWxzZS4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGlzSnNvbjogdHJ1ZSxcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJBbHBoYVwiLCBcIkJldGFcIiwgXCJEZWx0YVwiXSxcbiAgICAgIGNvbnRhaW5zTm9uZTogW1wiR2FtbWFcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImVkaXQtMDNcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJlZGl0X29wXCIsXG4gICAgZGlmZmljdWx0eTogXCJlYXN5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ2hhbmdlIHRoZSB0aXRsZSBvZiBhIHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdDdXJyZW50IHNsaWRlIHRpdGxlIGlzIFwiTWFya2V0IE92ZXJ2aWV3XCIuIENoYW5nZSBpdCB0byBiZSBtb3JlIHNwZWNpZmljIHRvIFNhYVMuIE91dHB1dCBhIEpTT04gb2JqZWN0IHsgXCJ0aXRsZVwiOiBcIi4uLlwiIH0gd2l0aCBvbmx5IHRoZSBuZXcgdGl0bGUuJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBpc0pzb246IHRydWUsXG4gICAgICBjb250YWluc0FueTogW1wiU2FhU1wiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZWRpdC0wNFwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImVkaXRfb3BcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNoYW5nZSB0aGUgYnJhbmQgY29sb3IgZnJvbSBibHVlIHRvIGdyZWVuLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdUaGUgY3VycmVudCBzbGlkZSB1c2VzICMzYjgyZjYgKGJsdWUpIGFzIGl0cyBhY2NlbnQgY29sb3IuIENoYW5nZSBpdCB0byBhIGNhbG0gZ3JlZW4gaGV4IGNvZGUuIE91dHB1dCBhIEpTT04gb2JqZWN0IHsgXCJhY2NlbnRcIjogXCIjLi4uXCIgfSB3aXRoIG9ubHkgdGhlIG5ldyBoZXggdmFsdWUuJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBpc0pzb246IHRydWUsXG4gICAgICBjb250YWluc0FueTogW1wiIzBcIiwgXCIjMVwiLCBcIiMyXCIsIFwiIzNcIiwgXCIjNFwiLCBcIiM1XCIsIFwiIzZcIiwgXCIjN1wiLCBcIiM4XCIsIFwiIzlcIiwgXCIjYVwiLCBcIiNiXCIsIFwiI2NcIiwgXCIjZFwiLCBcIiNlXCIsIFwiI2ZcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImVkaXQtMDVcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJlZGl0X29wXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJSZW9yZGVyIGJ1bGxldHMgYWxwaGFiZXRpY2FsbHkuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0N1cnJlbnQgYnVsbGV0czogW1wiWmV0YVwiLCBcIkFscGhhXCIsIFwiTXVcIiwgXCJCZXRhXCJdLiBSZW9yZGVyIHRoZW0gYWxwaGFiZXRpY2FsbHkuIE91dHB1dCB0aGUgbmV3IGxpc3QgYXMgYSBKU09OIGFycmF5LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcIkFscGhhXCIsIFwiQmV0YVwiLCBcIk11XCIsIFwiWmV0YVwiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZWRpdC0wNlwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImVkaXRfb3BcIixcbiAgICBkaWZmaWN1bHR5OiBcImhhcmRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTcGxpdCBvbmUgc2xpZGUgaW50byB0d28uXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ0Egc2luZ2xlIHNsaWRlIGhhcyB0aXRsZSBcIlJvYWRtYXBcIiB3aXRoIDggYnVsbGV0cy4gU3BsaXQgaXQgaW50byB0d28gc2xpZGVzIG9mIDQgYnVsbGV0cyBlYWNoLCBrZWVwaW5nIHRoZSBzYW1lIHRpdGxlIHN1ZmZpeGVkIHdpdGggXCIoMS8yKVwiIGFuZCBcIigyLzIpXCIuIFRoZSBidWxsZXRzIGFyZTogW1wiUGxhblwiLCBcIkRlc2lnblwiLCBcIlByb3RvdHlwZVwiLCBcIkJ1aWxkXCIsIFwiVGVzdFwiLCBcIkxhdW5jaFwiLCBcIk1vbml0b3JcIiwgXCJJdGVyYXRlXCJdLiBPdXRwdXQgYSBKU09OIGFycmF5IG9mIHR3byBvYmplY3RzIGVhY2ggd2l0aCB7IHRpdGxlLCBidWxsZXRzIH0uJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBpc0pzb246IHRydWUsXG4gICAgICBjb250YWluc0FsbDogW1wiMS8yXCIsIFwiMi8yXCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJlZGl0LTA3XCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiZWRpdF9vcFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIk1lcmdlIHR3byBzbGlkZXMgaW50byBvbmUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1R3byBjb25zZWN1dGl2ZSBzbGlkZXMgYm90aCB0aXRsZWQgXCJUZWFtXCIgd2l0aCBidWxsZXRzIEE9W1wiQWxpY2VcIiwgXCJCb2JcIl0gYW5kIEI9W1wiQ2Fyb2xcIiwgXCJEYW5cIl0uIE1lcmdlIHRoZW0gaW50byBvbmUgc2xpZGUuIE91dHB1dCBhIEpTT04gb2JqZWN0IHsgdGl0bGUsIGJ1bGxldHMgfSB3aXRoIHRoZSBjb21iaW5lZCBsaXN0LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcIkFsaWNlXCIsIFwiQm9iXCIsIFwiQ2Fyb2xcIiwgXCJEYW5cIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImVkaXQtMDhcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJlZGl0X29wXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJDaGFuZ2UgbGF5b3V0IGZyb20gdHdvX2NvbHVtbiB0byB0aXRsZV9hbmRfYm9keS5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnQSBzbGlkZSBpcyBjdXJyZW50bHkgdHdvX2NvbHVtbiB3aXRoIGxlZnQ9XCJBXCIsIHJpZ2h0PVwiQlwiLiBGbGF0dGVuIHRvIHRpdGxlX2FuZF9ib2R5IHdpdGggYnVsbGV0cy4gT3V0cHV0IGEgSlNPTiBvYmplY3QgeyBcImxheW91dFwiOiBcIi4uLlwiLCBcImJ1bGxldHNcIjogW1wiLi4uXCIsIFwiLi4uXCJdIH0uJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBpc0pzb246IHRydWUsXG4gICAgICBjb250YWluc0FsbDogW1widGl0bGVfYW5kX2JvZHlcIiwgXCJBXCIsIFwiQlwiXSxcbiAgICB9LFxuICB9LFxuXG4gIC8vID09PT09PT09PT0gQUNUSU9OOiBBR0VOVCBQTEFOICg2KSA9PT09PT09PT09XG4gIHtcbiAgICBpZDogXCJwbGFuLTAxXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiYWdlbnRfcGxhblwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUGxhbiBhIDUtc2xpZGUgZGVjayBhYm91dCBhIG5ldyBwcm9kdWN0IGxhdW5jaC5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnUGxhbiBhIDUtc2xpZGUgZGVjayBmb3IgYSBwcm9kdWN0IGxhdW5jaCBvZiBcIk9yYml0LCBhIHRhc2sgbWFuYWdlciBmb3IgcmVtb3RlIHRlYW1zXCIuIE91dHB1dCBhIEpTT04gYXJyYXkgb2YgNSBvYmplY3RzIHdpdGggeyBzbGlkZU51bWJlciwgdGl0bGUsIGxheW91dCwgb25lTGluZVN1bW1hcnkgfS4gTGF5b3V0cyBtdXN0IGJlIG9uZSBvZjogdGl0bGVfb25seSwgdGl0bGVfYW5kX2JvZHksIHR3b19jb2x1bW4sIGltYWdlX3JpZ2h0LCBzZWN0aW9uX2RpdmlkZXIsIHF1b3RlLicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcIk9yYml0XCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwbGFuLTAyXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWN0aW9uXCIsXG4gICAgc3ViY2F0ZWdvcnk6IFwiYWdlbnRfcGxhblwiLFxuICAgIGRpZmZpY3VsdHk6IFwiaGFyZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBsYW4gc3RlcHMgdG8gY29udmVydCBtYXJrZG93biBub3RlcyB0byBhIHNsaWRlIGRlY2suXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1lvdSBhcmUgZ2l2ZW4gYSBtYXJrZG93biBmaWxlIHdpdGggSDEvSDIgaGVhZGluZ3MgYW5kIGJ1bGxldHMsIGFuZCBuZWVkIHRvIHByb2R1Y2UgYSAucHB0eCBmaWxlLiBPdXRwdXQgYSBKU09OIGFycmF5IG9mIHNlcXVlbnRpYWwgdG9vbC1jYWxsIHN0ZXBzLCB3aGVyZSBlYWNoIHN0ZXAgaGFzIHsgdG9vbCwgYXJnc19zdW1tYXJ5IH0uIFRvb2xzIGF2YWlsYWJsZTogcGFyc2VNYXJrZG93biwgcGlja0xheW91dCwgZ2VuZXJhdGVIdG1sLCByZW5kZXJTbGlkZSwgc2NvcmVTbGlkZSwgd3JpdGVQcHR4Z2VuanMsIGV4cG9ydFBwdHguJyxcbiAgICB9LFxuICAgIGV4cGVjdGVkOiB7XG4gICAgICBpc0pzb246IHRydWUsXG4gICAgICBjb250YWluc0FsbDogW1wicGFyc2VNYXJrZG93blwiLCBcImV4cG9ydFBwdHhcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBsYW4tMDNcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJhZ2VudF9wbGFuXCIsXG4gICAgZGlmZmljdWx0eTogXCJtZWRpdW1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJQbGFuIGFkZGluZyBhIGNoYXJ0IHRvIGFuIGV4aXN0aW5nIHNsaWRlLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdBbiBleGlzdGluZyBzbGlkZSBoYXMgYSB0aXRsZSBhbmQgYSB0aHJlZS1idWxsZXQgbGlzdC4gVGhlIHVzZXIgd2FudHMgdG8gYWRkIGEgYmFyIGNoYXJ0IHRoYXQgdmlzdWFsaXplcyB0aGUgdmFsdWVzIGluIHRoZSBidWxsZXRzIChlYWNoIGJ1bGxldCBoYXMgYSBudW1iZXIpLiBPdXRwdXQgYSBKU09OIGFycmF5IG9mIHN0ZXBzOiB7IHRvb2wsIGFyZ3Nfc3VtbWFyeSB9LiBUb29sczogZXh0cmFjdEJ1bGxldE51bWJlcnMsIGdlbmVyYXRlQ2hhcnRIdG1sLCByZW5kZXJTbGlkZSwgcmVwbGFjZVNsaWRlLicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcImV4dHJhY3RCdWxsZXROdW1iZXJzXCIsIFwiZ2VuZXJhdGVDaGFydEh0bWxcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBsYW4tMDRcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJhZ2VudF9wbGFuXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUGxhbiBhbiBhZXN0aGV0aWMtaXRlcmF0aW9uIGxvb3AuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1lvdSBuZWVkIHRvIGdvIHRocm91Z2ggYSAyMC1zbGlkZSBkZWNrLCBzY29yZSBlYWNoIHNsaWRlIGFlc3RoZXRpY2FsbHksIGFuZCByZWdlbmVyYXRlIGFueSBzbGlkZSBzY29yaW5nIGJlbG93IDcuIE91dHB1dCBhIEpTT04gYXJyYXkgZGVzY3JpYmluZyB0aGUgbG9vcCBzdGVwczogeyB0b29sLCBhcmdzX3N1bW1hcnkgfS4gVG9vbHM6IGxpc3RTbGlkZXMsIHJlbmRlclNsaWRlLCBzY29yZVNsaWRlLCByZWdlbmVyYXRlU2xpZGUsIHJlcGxhY2VTbGlkZS4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGlzSnNvbjogdHJ1ZSxcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJsaXN0U2xpZGVzXCIsIFwic2NvcmVTbGlkZVwiLCBcInJlZ2VuZXJhdGVTbGlkZVwiXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicGxhbi0wNVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcImFnZW50X3BsYW5cIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBsYW4gdHJhbnNsYXRpbmcgYSBkZWNrIHRvIGFub3RoZXIgbGFuZ3VhZ2UuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1lvdSBuZWVkIHRvIHRyYW5zbGF0ZSBhIDEwLXNsaWRlIEVuZ2xpc2ggZGVjayB0byBTcGFuaXNoLCBwcmVzZXJ2aW5nIGxheW91dC4gT3V0cHV0IGEgSlNPTiBhcnJheSBvZiBzdGVwczogeyB0b29sLCBhcmdzX3N1bW1hcnkgfS4gVG9vbHM6IGxpc3RTbGlkZXMsIGV4dHJhY3RUZXh0LCB0cmFuc2xhdGVUZXh0LCByZXBsYWNlVGV4dC4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGlzSnNvbjogdHJ1ZSxcbiAgICAgIGNvbnRhaW5zQWxsOiBbXCJ0cmFuc2xhdGVUZXh0XCIsIFwicmVwbGFjZVRleHRcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInBsYW4tMDZcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJhZ2VudF9wbGFuXCIsXG4gICAgZGlmZmljdWx0eTogXCJoYXJkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUGxhbiBhIHJlYnJhbmRpbmcgcGFzcy5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnQSBkZWNrIHVzZXMgY29sb3JzICMzYjgyZjYgKGJsdWUpIGFuZCAjZjk3MzE2IChvcmFuZ2UpLiBSZWJyYW5kIGV2ZXJ5IHNsaWRlIHRvIHVzZSAjMTExODI3IChkYXJrKSBhbmQgIzEwYjk4MSAoZ3JlZW4pLiBPdXRwdXQgYSBKU09OIGFycmF5IG9mIHN0ZXBzOiB7IHRvb2wsIGFyZ3Nfc3VtbWFyeSB9LiBUb29sczogbGlzdFNsaWRlcywgcGFyc2VTdHlsZXMsIHJlcGxhY2VDb2xvciwgcmVuZGVyU2xpZGUsIHZlcmlmeUNvbnRyYXN0LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDoge1xuICAgICAgaXNKc29uOiB0cnVlLFxuICAgICAgY29udGFpbnNBbGw6IFtcInJlcGxhY2VDb2xvclwiLCBcInZlcmlmeUNvbnRyYXN0XCJdLFxuICAgIH0sXG4gIH0sXG5cbiAgLy8gPT09PT09PT09PSBBQ1RJT046IFJFV1JJVEUgQ09OVEVOVCAoNikgPT09PT09PT09PVxuICB7XG4gICAgaWQ6IFwicnctMDFcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJyZXdyaXRlX2NvbnRlbnRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlRpZ2h0ZW4gYSB2ZXJib3NlIGJ1bGxldCB0byAxMCB3b3JkcyBvciBmZXdlci5cIixcbiAgICBpbnB1dDoge1xuICAgICAgcHJvbXB0OlxuICAgICAgICAnUmV3cml0ZSB0aGlzIGJ1bGxldCB0byBiZSAxMCB3b3JkcyBvciBmZXdlciB3aGlsZSBwcmVzZXJ2aW5nIHRoZSBtZWFuaW5nOiBcIldlIGFyZSBpbiB0aGUgcHJvY2VzcyBvZiBleHBsb3JpbmcgdGhlIHBvc3NpYmlsaXR5IG9mIHBvdGVudGlhbGx5IGxldmVyYWdpbmcgc29tZSBmb3JtIG9mIEFJLWJhc2VkIGFwcHJvYWNoIHRvIGltcHJvdmUgb3VyIGN1c3RvbWVyIG9uYm9hcmRpbmcgZXhwZXJpZW5jZS5cIiBPdXRwdXQgT05MWSB0aGUgcmV3cml0dGVuIGJ1bGxldC4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zQW55OiBbXCJBSVwiLCBcIm9uYm9hcmRpbmdcIl0sXG4gICAgICBjb250YWluc05vbmU6IFtcImluIHRoZSBwcm9jZXNzIG9mXCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJydy0wMlwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInJld3JpdGVfY29udGVudFwiLFxuICAgIGRpZmZpY3VsdHk6IFwiZWFzeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpeCBncmFtbWFyLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdGaXggYW55IGdyYW1tYXIgbWlzdGFrZXMgaW4gdGhpcyBidWxsZXQ6IFwiVGhlIHRlYW0gYXJlIGNvbW1pdHRlZCB0byBzaGlwIHRoZXJlIG5ldyBwcm9kdWN0IGJ5IGVuZCBvZiBRMy5cIiBPdXRwdXQgT05MWSB0aGUgY29ycmVjdGVkIGJ1bGxldC4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbGw6IFtcInRoZWlyXCJdLCBjb250YWluc05vbmU6IFtcInRoZXJlIG5ld1wiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicnctMDNcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJyZXdyaXRlX2NvbnRlbnRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFkZCBhIGNvbmNyZXRlIG51bWJlciB0byBhIHZhZ3VlIGNsYWltLlwiLFxuICAgIGlucHV0OiB7XG4gICAgICBwcm9tcHQ6XG4gICAgICAgICdSZXdyaXRlIHRoaXMgYnVsbGV0IHRvIGluY2x1ZGUgYSBjb25jcmV0ZSBwbGFjZWhvbGRlciBudW1iZXI6IFwiT3VyIGN1c3RvbWVycyBsb3ZlIG91ciBwcm9kdWN0LlwiIFVzZSB0aGUgZm9ybWF0IFwiWCUgb2YgY3VzdG9tZXJzXCIgd2l0aCBhIHJlYWxpc3RpYyBudW1iZXIuIE91dHB1dCBPTkxZIHRoZSByZXdyaXR0ZW4gYnVsbGV0LicsXG4gICAgfSxcbiAgICBleHBlY3RlZDogeyBjb250YWluc0FueTogW1wiJVwiXSB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicnctMDRcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJyZXdyaXRlX2NvbnRlbnRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlbW92ZSBqYXJnb24uXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1Jld3JpdGUgdGhpcyBidWxsZXQgdG8gcmVtb3ZlIGphcmdvbiBhbmQgYmUgdW5kZXJzdGFuZGFibGUgdG8gYSBub24tdGVjaG5pY2FsIGF1ZGllbmNlOiBcIldlIGxldmVyYWdlIHN5bmVyZ2lzdGljIGNyb3NzLWZ1bmN0aW9uYWwgcGFyYWRpZ21zIHRvIHVuYmxvY2sga2V5IHZhbHVlLXN0cmVhbSBib3R0bGVuZWNrcy5cIiBPdXRwdXQgT05MWSB0aGUgcmV3cml0dGVuIGJ1bGxldC4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGNvbnRhaW5zTm9uZTogW1wic3luZXJnaXN0aWNcIiwgXCJwYXJhZGlnbVwiLCBcImxldmVyYWdlXCJdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJydy0wNVwiLFxuICAgIGNhdGVnb3J5OiBcImFjdGlvblwiLFxuICAgIHN1YmNhdGVnb3J5OiBcInJld3JpdGVfY29udGVudFwiLFxuICAgIGRpZmZpY3VsdHk6IFwibWVkaXVtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRW5mb3JjZSBwYXJhbGxlbCBzdHJ1Y3R1cmUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1Jld3JpdGUgdGhlc2UgYnVsbGV0cyB0byB1c2UgcGFyYWxsZWwgZ3JhbW1hdGljYWwgc3RydWN0dXJlOiBbXCJGYXN0ZXIgdG8gZGVwbG95XCIsIFwiU2NhbGFiaWxpdHkgb2YgdGhlIHBsYXRmb3JtXCIsIFwiQ29zdCByZWR1Y3Rpb25cIl0uIE91dHB1dCBhIEpTT04gYXJyYXkgb2Ygc3RyaW5ncy4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHtcbiAgICAgIGlzSnNvbjogdHJ1ZSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwicnctMDZcIixcbiAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICBzdWJjYXRlZ29yeTogXCJyZXdyaXRlX2NvbnRlbnRcIixcbiAgICBkaWZmaWN1bHR5OiBcIm1lZGl1bVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNvbnZlcnQgcGFzc2l2ZSB2b2ljZSB0byBhY3RpdmUuXCIsXG4gICAgaW5wdXQ6IHtcbiAgICAgIHByb21wdDpcbiAgICAgICAgJ1Jld3JpdGUgdGhpcyBidWxsZXQgaW4gYWN0aXZlIHZvaWNlOiBcIk1pc3Rha2VzIHdlcmUgbWFkZSBkdXJpbmcgdGhlIHJvbGxvdXQgYnkgdGhlIGRlcGxveW1lbnQgdGVhbS5cIiBPdXRwdXQgT05MWSB0aGUgcmV3cml0dGVuIGJ1bGxldC4nLFxuICAgIH0sXG4gICAgZXhwZWN0ZWQ6IHsgY29udGFpbnNBbnk6IFtcInRlYW0gbWFkZVwiLCBcInRlYW0gY2F1c2VkXCIsIFwidGVhbSBoYWRcIiwgXCJkZXBsb3ltZW50IHRlYW0gbWFkZVwiXSB9LFxuICB9LFxuXTtcblxuLy8gLS0tIHNhbml0eSBhc3NlcnRzLCBjYWxsZWQgYXQgbW9kdWxlIGxvYWQgc28gYSBtYWxmb3JtZWQgaXRlbSBleHBsb2RlcyBsb3VkbHkgLS0tXG5cbmlmIChFVkFMX1NFVC5sZW5ndGggIT09IDEwMCkge1xuICB0aHJvdyBuZXcgRXJyb3IoYEVWQUxfU0VUIG11c3QgaGF2ZSBleGFjdGx5IDEwMCBpdGVtcywgZ290ICR7RVZBTF9TRVQubGVuZ3RofWApO1xufVxuY29uc3QgaWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5mb3IgKGNvbnN0IGl0IG9mIEVWQUxfU0VUKSB7XG4gIGlmIChpZHMuaGFzKGl0LmlkKSkgdGhyb3cgbmV3IEVycm9yKGBEdXBsaWNhdGUgZXZhbCBpZDogJHtpdC5pZH1gKTtcbiAgaWRzLmFkZChpdC5pZCk7XG59XG5jb25zdCB2aXN1YWxDb3VudCA9IEVWQUxfU0VULmZpbHRlcigoaSkgPT4gaS5jYXRlZ29yeSA9PT0gXCJ2aXN1YWxcIikubGVuZ3RoO1xuY29uc3QgYWN0aW9uQ291bnQgPSBFVkFMX1NFVC5maWx0ZXIoKGkpID0+IGkuY2F0ZWdvcnkgPT09IFwiYWN0aW9uXCIpLmxlbmd0aDtcbmlmICh2aXN1YWxDb3VudCAhPT0gNTAgfHwgYWN0aW9uQ291bnQgIT09IDUwKSB7XG4gIHRocm93IG5ldyBFcnJvcihgRXhwZWN0ZWQgNTAvNTAgc3BsaXQsIGdvdCB2aXN1YWw9JHt2aXN1YWxDb3VudH0gYWN0aW9uPSR7YWN0aW9uQ291bnR9YCk7XG59XG4iLCAiLyoqXG4gKiBTY29yZXIgXHUyMDE0IGFwcGxpZXMgYW4gRXZhbEl0ZW0ncyBkZWNsYXJhdGl2ZSBgZXhwZWN0ZWRgIHRvIGEgbW9kZWwgcmVzcG9uc2UuXG4gKlxuICogRGV0ZXJtaW5pc3RpYyBtb2RlcyBhcmUgcHJlZmVycmVkIChleGFjdCAvIGNvbnRhaW5zIC8gSlNPTiAvIG51bWVyaWNSYW5nZSlcbiAqIHNvIGV2YWwgcnVucyBhcmUgcmVwcm9kdWNpYmxlLiBDb2RlLXJ1bnMgdXNlcyBhIHNhbmRib3hlZCBmdW5jdGlvblxuICogY29uc3RydWN0aW9uIHRvIHZlcmlmeSBzeW50YWN0aWMgdmFsaWRpdHk7IGl0IGRvZXMgbm90IGFjdHVhbGx5IGV4ZWN1dGVcbiAqIHBwdHhnZW5qcyBcdTIwMTQgaXQgb25seSBjaGVja3MgdGhlIHNuaXBwZXQgcGFyc2VzIGFzIEpTLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXZhbEV4cGVjdGVkLCBFdmFsSXRlbSwgSXRlbVJlc3VsdCB9IGZyb20gXCIuL2V2YWwtdHlwZXMuanNcIjtcblxuZXhwb3J0IHR5cGUgU2NvcmVPdXRjb21lID0gUmVhZG9ubHk8eyBzY29yZTogbnVtYmVyOyByZWFzb246IHN0cmluZyB9PjtcblxuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlUmVzcG9uc2UoaXRlbTogRXZhbEl0ZW0sIHJlc3BvbnNlOiBzdHJpbmcpOiBTY29yZU91dGNvbWUge1xuICBjb25zdCBleHAgPSBpdGVtLmV4cGVjdGVkO1xuICBjb25zdCB0ZXh0ID0gcmVzcG9uc2UudHJpbSgpO1xuICBjb25zdCB0ZXh0TGMgPSB0ZXh0LnRvTG93ZXJDYXNlKCk7XG5cbiAgLy8gQWdncmVnYXRlIG11bHRpcGxlIGNoZWNrcyBcdTIwMTQgc3RhcnQgYXQgMS4wIGFuZCBmYWlsIGNsb3NlZC5cbiAgbGV0IHNjb3JlID0gMTtcbiAgY29uc3QgcmVhc29uczogc3RyaW5nW10gPSBbXTtcblxuICBpZiAoZXhwLmV4YWN0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodGV4dCAhPT0gZXhwLmV4YWN0KSB7XG4gICAgICBzY29yZSA9IDA7XG4gICAgICByZWFzb25zLnB1c2goYGV4cGVjdGVkIGV4YWN0PVwiJHtleHAuZXhhY3R9XCIsIGdvdCBcIiR7dGV4dC5zbGljZSgwLCA2NCl9XCJgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZXhwLmNvbnRhaW5zQWxsKSB7XG4gICAgZm9yIChjb25zdCBzIG9mIGV4cC5jb250YWluc0FsbCkge1xuICAgICAgaWYgKCF0ZXh0TGMuaW5jbHVkZXMocy50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgICBzY29yZSA9IDA7XG4gICAgICAgIHJlYXNvbnMucHVzaChgbWlzc2luZyByZXF1aXJlZCBzdWJzdHJpbmcgXCIke3N9XCJgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAoZXhwLmNvbnRhaW5zQW55KSB7XG4gICAgY29uc3QgYW55SGl0ID0gZXhwLmNvbnRhaW5zQW55LnNvbWUoKHMpID0+IHRleHRMYy5pbmNsdWRlcyhzLnRvTG93ZXJDYXNlKCkpKTtcbiAgICBpZiAoIWFueUhpdCkge1xuICAgICAgc2NvcmUgPSAwO1xuICAgICAgcmVhc29ucy5wdXNoKGBub25lIG9mICR7ZXhwLmNvbnRhaW5zQW55Lmxlbmd0aH0gYWx0ZXJuYXRpdmVzIHByZXNlbnRgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZXhwLmNvbnRhaW5zTm9uZSkge1xuICAgIGZvciAoY29uc3QgcyBvZiBleHAuY29udGFpbnNOb25lKSB7XG4gICAgICBpZiAodGV4dExjLmluY2x1ZGVzKHMudG9Mb3dlckNhc2UoKSkpIHtcbiAgICAgICAgc2NvcmUgPSAwO1xuICAgICAgICByZWFzb25zLnB1c2goYGZvcmJpZGRlbiBzdWJzdHJpbmcgXCIke3N9XCIgcHJlc2VudGApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChleHAuaXNKc29uKSB7XG4gICAgdHJ5IHtcbiAgICAgIEpTT04ucGFyc2Uoc3RyaXBGZW5jZXModGV4dCkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgc2NvcmUgPSAwO1xuICAgICAgcmVhc29ucy5wdXNoKFwib3V0cHV0IGlzIG5vdCB2YWxpZCBKU09OXCIpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChleHAuanNvblBhdGhFcXVhbHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzdHJpcEZlbmNlcyh0ZXh0KSk7XG4gICAgICBjb25zdCB2ID0gZ2V0UGF0aChwYXJzZWQsIGV4cC5qc29uUGF0aEVxdWFscy5wYXRoKTtcbiAgICAgIGlmICghZXhwLmpzb25QYXRoRXF1YWxzLnZhbHVlcy5zb21lKCh0YXJnZXQpID0+IHRhcmdldCA9PT0gdikpIHtcbiAgICAgICAgc2NvcmUgPSAwO1xuICAgICAgICByZWFzb25zLnB1c2goYEpTT04gcGF0aCBcIiR7ZXhwLmpzb25QYXRoRXF1YWxzLnBhdGh9XCIgPSAke0pTT04uc3RyaW5naWZ5KHYpfSBub3QgaW4gZXhwZWN0ZWQgdmFsdWVzYCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICBzY29yZSA9IDA7XG4gICAgICByZWFzb25zLnB1c2goXCJjb3VsZCBub3QgcGFyc2UgSlNPTiBmb3IgcGF0aCBjaGVja1wiKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZXhwLmNvZGVSdW5zKSB7XG4gICAgaWYgKCFpc1N5bnRhY3RpY2FsbHlWYWxpZEpzKHN0cmlwRmVuY2VzKHRleHQpKSkge1xuICAgICAgc2NvcmUgPSAwO1xuICAgICAgcmVhc29ucy5wdXNoKFwiY29kZSBzbmlwcGV0IGRvZXMgbm90IHBhcnNlIGFzIEphdmFTY3JpcHRcIik7XG4gICAgfVxuICB9XG5cbiAgaWYgKGV4cC5udW1lcmljUmFuZ2UpIHtcbiAgICBjb25zdCBuID0gZXh0cmFjdE51bWJlcih0ZXh0KTtcbiAgICBjb25zdCBbbG8sIGhpXSA9IGV4cC5udW1lcmljUmFuZ2U7XG4gICAgaWYgKG4gPT09IG51bGwpIHtcbiAgICAgIHNjb3JlID0gMDtcbiAgICAgIHJlYXNvbnMucHVzaChcIm5vIG51bWJlciBleHRyYWN0ZWQgZnJvbSBvdXRwdXRcIik7XG4gICAgfSBlbHNlIGlmIChuIDwgbG8gfHwgbiA+IGhpKSB7XG4gICAgICBzY29yZSA9IDA7XG4gICAgICByZWFzb25zLnB1c2goYG51bWJlciAke259IG91dHNpZGUgWyR7bG99LCAke2hpfV1gKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHNjb3JlLFxuICAgIHJlYXNvbjogc2NvcmUgPT09IDEgPyBcIm9rXCIgOiByZWFzb25zLmpvaW4oXCI7IFwiKSxcbiAgfTtcbn1cblxuLyoqIFN0cmlwIGBgYGxhbmdcXG4gLi4uIFxcbmBgYCBmZW5jZXMgaWYgcHJlc2VudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdHJpcEZlbmNlcyhzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gcy5tYXRjaCgvXmBgYCg/OlxcdyspP1xccypcXG4oW1xcc1xcU10qPylcXG5gYGBcXHMqJC8pO1xuICByZXR1cm4gbSA/IG1bMV0gOiBzLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2V0UGF0aChvYmo6IHVua25vd24sIHBhdGg6IHN0cmluZyk6IHVua25vd24ge1xuICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoXCIuXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgbGV0IGN1cjogdW5rbm93biA9IG9iajtcbiAgZm9yIChjb25zdCBwIG9mIHBhcnRzKSB7XG4gICAgaWYgKGN1ciA9PSBudWxsIHx8IHR5cGVvZiBjdXIgIT09IFwib2JqZWN0XCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY3VyID0gKGN1ciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbcF07XG4gIH1cbiAgcmV0dXJuIGN1cjtcbn1cblxuLyoqIEV4dHJhY3QgdGhlIGZpcnN0IGludGVnZXIgb3IgZmxvYXQgZnJvbSBhIHN0cmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TnVtYmVyKHM6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gcy5tYXRjaCgvLT9cXGQrKD86XFwuXFxkKyk/Lyk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG4gPSBOdW1iZXIobVswXSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBuIDogbnVsbDtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIHN0cmluZyBwYXJzZXMgYXMgSmF2YVNjcmlwdC4gVXNlcyBgbmV3IEZ1bmN0aW9uYCwgd2hpY2ggdGhyb3dzXG4gKiBvbiBzeW50YXggZXJyb3JzIGJ1dCBkb2VzIG5vdCBleGVjdXRlIHRoZSBib2R5LiBUaGlzIGlzIGEgc3RyaWN0IHN1YnNldCBvZlxuICogcmVhbCBcIndvdWxkIGl0IHJ1biB3aXRoIHBwdHhnZW5qc1wiIGJ1dCBjYXRjaGVzIHRoZSBjb21tb24gYnVnIGNsYXNzZXMgd2VcbiAqIGNhcmUgYWJvdXQgKHR5cG9zLCBtaXNzaW5nIGJyYWNlcywgdW50ZXJtaW5hdGVkIHN0cmluZ3MpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTeW50YWN0aWNhbGx5VmFsaWRKcyhjb2RlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICAvLyBXcmFwIGluIGFuIGFzeW5jIGZ1bmN0aW9uIHNvIGBhd2FpdGAgYXQgdGhlIHRvcCBsZXZlbCBpcyBsZWdhbC5cbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tbmV3LWZ1bmNcbiAgICBuZXcgRnVuY3Rpb24oXCJwcHR4XCIsIFwic2xpZGVcIiwgYHJldHVybiAoYXN5bmMgKCkgPT4geyAke2NvZGV9IH0pKClgKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBCdWlsZCBhIGZ1bGwgSXRlbVJlc3VsdCBmcm9tIGEgcmVzcG9uc2UgKyBhZGFwdGVyIG1ldGFkYXRhLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1ha2VJdGVtUmVzdWx0KFxuICBpdGVtOiBFdmFsSXRlbSxcbiAgcmVzcG9uc2U6IHN0cmluZyxcbiAgbWV0YTogUmVhZG9ubHk8e1xuICAgIGxhdGVuY3lNczogbnVtYmVyO1xuICAgIHByb21wdFRva2VuczogbnVtYmVyO1xuICAgIGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlcjtcbiAgICBwcmVmaXhIaXRUb2tlbnM6IG51bWJlcjtcbiAgICBpbWFnZUNhY2hlSGl0OiBib29sZWFuO1xuICB9Pixcbik6IEl0ZW1SZXN1bHQge1xuICBjb25zdCB7IHNjb3JlLCByZWFzb24gfSA9IHNjb3JlUmVzcG9uc2UoaXRlbSwgcmVzcG9uc2UpO1xuICByZXR1cm4ge1xuICAgIGl0ZW1JZDogaXRlbS5pZCxcbiAgICBzY29yZSxcbiAgICByZWFzb24sXG4gICAgcmVzcG9uc2UsXG4gICAgbGF0ZW5jeU1zOiBtZXRhLmxhdGVuY3lNcyxcbiAgICB1c2FnZTogeyBwcm9tcHRUb2tlbnM6IG1ldGEucHJvbXB0VG9rZW5zLCBjb21wbGV0aW9uVG9rZW5zOiBtZXRhLmNvbXBsZXRpb25Ub2tlbnMgfSxcbiAgICBwcmVmaXhIaXRUb2tlbnM6IG1ldGEucHJlZml4SGl0VG9rZW5zLFxuICAgIGltYWdlQ2FjaGVIaXQ6IG1ldGEuaW1hZ2VDYWNoZUhpdCxcbiAgfTtcbn1cbiIsICIvKipcbiAqIEV2YWwgaGFybmVzcyBcdTIwMTQgcnVucyBldmVyeSBpdGVtIGluIEVWQUxfU0VUIHRocm91Z2ggYW4gYWRhcHRlci5cbiAqXG4gKiBEZXNpZ25lZCBmb3IgYm90aCBicm93c2VyIGFuZCBOb2RlIGNhbGxlcnM6XG4gKiAgIC0gSW4gdGhlIGJyb3dzZXIsIGByZW5kZXJTbGlkZVRvUG5nYCB1c2VzIGFuIG9mZnNjcmVlbiBpZnJhbWVcbiAqICAgLSBJbiBOb2RlIHVuaXQgdGVzdHMsIGByZW5kZXJTbGlkZVRvUG5nYCBjYW4gYmUgc3R1YmJlZCB0byByZXR1cm4gYVxuICogICAgIGJsYW5rIHBsYWNlaG9sZGVyIFBORyAoZm9yIE1vY2tBZGFwdGVyIHRlc3RzIHRoYXQgZG9uJ3QgYWN0dWFsbHkgdXNlXG4gKiAgICAgdGhlIGltYWdlKVxuICpcbiAqIFRoZSBoYXJuZXNzIGlzIGludGVudGlvbmFsbHkgc3RhdGVsZXNzIFx1MjAxNCBlYWNoIGNhbGwgcHJvZHVjZXMgYSBuZXdcbiAqIE1vZGVsUmVwb3J0LiBUaGUgYmF0Y2hlci9jYWNoZSBzaXQgaW5zaWRlIHRoZSBhZGFwdGVyLlxuICovXG5cbmltcG9ydCB7IEVWQUxfU0VUIH0gZnJvbSBcIi4vZXZhbC1zZXQuanNcIjtcbmltcG9ydCB0eXBlIHtcbiAgRXZhbENhdGVnb3J5LFxuICBFdmFsSXRlbSxcbiAgSXRlbVJlc3VsdCxcbiAgTW9kZWxSZXBvcnQsXG59IGZyb20gXCIuL2V2YWwtdHlwZXMuanNcIjtcbmltcG9ydCB7IG1ha2VJdGVtUmVzdWx0IH0gZnJvbSBcIi4vc2NvcmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENoYXRSZXF1ZXN0LCBJbWFnZUlucHV0LCBNZXNzYWdlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgSVZMTUFkYXB0ZXIgfSBmcm9tIFwiLi92bG0tYWRhcHRlci5qc1wiO1xuXG5leHBvcnQgdHlwZSBSZW5kZXJTbGlkZUZuID0gKGh0bWw6IHN0cmluZykgPT4gUHJvbWlzZTxJbWFnZUlucHV0IHwgbnVsbD47XG5cbmV4cG9ydCB0eXBlIEhhcm5lc3NPcHRpb25zID0gUmVhZG9ubHk8e1xuICBhZGFwdGVyOiBJVkxNQWRhcHRlcjtcbiAgLyoqIFJlbmRlcnMgYSBzbGlkZSBIVE1MIGZyYWdtZW50IHRvIGEgUE5HICsgc2hhMjU2LiBSZXR1cm4gbnVsbCB0byBza2lwLiAqL1xuICByZW5kZXJTbGlkZVRvUG5nOiBSZW5kZXJTbGlkZUZuO1xuICAvKiogRmlsdGVyIHdoaWNoIGl0ZW1zIHRvIHJ1bi4gRGVmYXVsdHMgdG8gYWxsIDEwMC4gKi9cbiAgZmlsdGVyPzogKGl0ZW06IEV2YWxJdGVtKSA9PiBib29sZWFuO1xuICAvKiogQ2FsbGVkIGFmdGVyIGVhY2ggaXRlbSBjb21wbGV0ZXMgXHUyMDE0IHVzZWZ1bCBmb3IgbGl2ZSBwcm9ncmVzcyBVSS4gKi9cbiAgb25JdGVtQ29tcGxldGU/OiAocmVzdWx0OiBJdGVtUmVzdWx0LCBpdGVtOiBFdmFsSXRlbSkgPT4gdm9pZDtcbiAgLyoqIE1heCBwYXJhbGxlbGlzbS4gTW9zdCBicm93c2VyIGJhY2tlbmRzIHdhbnQgMTsgdGhlIGJhdGNoZXIgaGFuZGxlcyB0aGUgcmVzdC4gKi9cbiAgY29uY3VycmVuY3k/OiBudW1iZXI7XG59PjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkV2YWwob3B0czogSGFybmVzc09wdGlvbnMpOiBQcm9taXNlPE1vZGVsUmVwb3J0PiB7XG4gIGNvbnN0IHsgYWRhcHRlciwgcmVuZGVyU2xpZGVUb1BuZyB9ID0gb3B0cztcbiAgY29uc3QgaXRlbXMgPSBFVkFMX1NFVC5maWx0ZXIob3B0cy5maWx0ZXIgPz8gKCgpID0+IHRydWUpKTtcbiAgY29uc3Qgc3RhcnRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gIGlmICghYWRhcHRlci5pc1JlYWR5KCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBZGFwdGVyIG11c3QgYmUgbG9hZGVkIGJlZm9yZSBydW5FdmFsKClcIik7XG4gIH1cblxuICBjb25zdCByZXN1bHRzOiBJdGVtUmVzdWx0W10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuT25lSXRlbShhZGFwdGVyLCBpdGVtLCByZW5kZXJTbGlkZVRvUG5nKTtcbiAgICByZXN1bHRzLnB1c2gocmVzdWx0KTtcbiAgICBvcHRzLm9uSXRlbUNvbXBsZXRlPy4ocmVzdWx0LCBpdGVtKTtcbiAgfVxuXG4gIGNvbnN0IGZpbmlzaGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gIHJldHVybiBzdW1tYXJpemUoYWRhcHRlciwgcmVzdWx0cywgc3RhcnRlZEF0LCBmaW5pc2hlZEF0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuT25lSXRlbShcbiAgYWRhcHRlcjogSVZMTUFkYXB0ZXIsXG4gIGl0ZW06IEV2YWxJdGVtLFxuICByZW5kZXJTbGlkZTogUmVuZGVyU2xpZGVGbixcbik6IFByb21pc2U8SXRlbVJlc3VsdD4ge1xuICAvLyBCdWlsZCB0aGUgY2hhdCByZXF1ZXN0IGZyb20gdGhlIGl0ZW0ncyBpbnB1dC5cbiAgY29uc3QgdXNlck1lc3NhZ2U6IE1lc3NhZ2UgPSB7XG4gICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgY29udGVudDogYnVpbGRVc2VyUHJvbXB0KGl0ZW0pLFxuICAgIGltYWdlczogYXdhaXQgYnVpbGRJbWFnZXMoaXRlbSwgcmVuZGVyU2xpZGUpLFxuICB9O1xuXG4gIGNvbnN0IG1lc3NhZ2VzOiBNZXNzYWdlW10gPSBbXG4gICAge1xuICAgICAgcm9sZTogXCJzeXN0ZW1cIixcbiAgICAgIGNvbnRlbnQ6XG4gICAgICAgIFwiWW91IGFyZSBhIGhlbHBmdWwsIHByZWNpc2UgYXNzaXN0YW50IGV2YWx1YXRlZCBvbiBzbGlkZS1idWlsZGluZyB0YXNrcy4gRm9sbG93IHRoZSB1c2VyJ3MgaW5zdHJ1Y3Rpb25zIGxpdGVyYWxseS4gV2hlbiBhc2tlZCBmb3IgYSBzcGVjaWZpYyBmb3JtYXQgKEpTT04sIGNvZGUsIHNpbmdsZSBudW1iZXIpLCBvdXRwdXQgT05MWSB0aGF0IGZvcm1hdCB3aXRoIG5vIHByZWFtYmxlIGFuZCBubyBtYXJrZG93biBmZW5jZXMuXCIsXG4gICAgfSxcbiAgICB1c2VyTWVzc2FnZSxcbiAgXTtcblxuICBjb25zdCByZXF1ZXN0OiBDaGF0UmVxdWVzdCA9IHtcbiAgICBtZXNzYWdlcyxcbiAgICB0ZW1wZXJhdHVyZTogMCxcbiAgICBtYXhUb2tlbnM6IGl0ZW0ubWF4VG9rZW5zID8/IDEwMjQsXG4gICAgc2VlZDogNDIsXG4gICAgdGltZW91dE1zOiBpdGVtLnRpbWVvdXRNcyA/PyA2MF8wMDAsXG4gIH07XG5cbiAgY29uc3QgcmVzcCA9IGF3YWl0IGFkYXB0ZXIuZ2VuZXJhdGUocmVxdWVzdCk7XG4gIHJldHVybiBtYWtlSXRlbVJlc3VsdChpdGVtLCByZXNwLm1lc3NhZ2UuY29udGVudCwge1xuICAgIGxhdGVuY3lNczogcmVzcC5sYXRlbmN5TXMsXG4gICAgcHJvbXB0VG9rZW5zOiByZXNwLnVzYWdlLnByb21wdFRva2VucyxcbiAgICBjb21wbGV0aW9uVG9rZW5zOiByZXNwLnVzYWdlLmNvbXBsZXRpb25Ub2tlbnMsXG4gICAgcHJlZml4SGl0VG9rZW5zOiByZXNwLnByZWZpeEhpdFRva2VucyxcbiAgICBpbWFnZUNhY2hlSGl0OiByZXNwLmltYWdlQ2FjaGVIaXQsXG4gIH0pO1xufVxuXG4vKiogQnVpbGQgdGhlIHVzZXItdmlzaWJsZSBwcm9tcHQsIGFwcGVuZGluZyBjb250ZXh0IC8gY29kZSB3aGVyZSBuZWVkZWQuICovXG5mdW5jdGlvbiBidWlsZFVzZXJQcm9tcHQoaXRlbTogRXZhbEl0ZW0pOiBzdHJpbmcge1xuICBsZXQgcHJvbXB0ID0gaXRlbS5pbnB1dC5wcm9tcHQ7XG4gIGlmIChpdGVtLmlucHV0LmNvZGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHByb21wdCArPSBgXFxuXFxuXFxgXFxgXFxganNcXG4ke2l0ZW0uaW5wdXQuY29kZX1cXG5cXGBcXGBcXGBgO1xuICB9XG4gIGlmIChpdGVtLmlucHV0LmNvbnRleHQpIHtcbiAgICBwcm9tcHQgKz0gYFxcblxcbiR7SlNPTi5zdHJpbmdpZnkoaXRlbS5pbnB1dC5jb250ZXh0LCBudWxsLCAyKX1gO1xuICB9XG4gIGlmIChpdGVtLmlucHV0LnNsaWRlSHRtbEIgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIERpZmYtZGV0ZWN0IGl0ZW1zIHJlbmRlciBib3RoIHNsaWRlczsgdGhlIHVzZXIgbWVzc2FnZSB0ZWxscyB0aGUgbW9kZWxcbiAgICAvLyB3aGljaCBpcyB3aGljaC5cbiAgICBwcm9tcHQgKz0gXCJcXG5cXG4oU2xpZGUgQSBpcyB0aGUgZmlyc3QgaW1hZ2UsIFNsaWRlIEIgaXMgdGhlIHNlY29uZCBpbWFnZS4pXCI7XG4gIH1cbiAgcmV0dXJuIHByb21wdDtcbn1cblxuLyoqIFJlbmRlciB0aGUgc2xpZGVIdG1sIChhbmQgc2xpZGVIdG1sQikgdG8gSW1hZ2VJbnB1dCBvYmplY3RzLiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGRJbWFnZXMoXG4gIGl0ZW06IEV2YWxJdGVtLFxuICByZW5kZXJTbGlkZTogUmVuZGVyU2xpZGVGbixcbik6IFByb21pc2U8cmVhZG9ubHkgSW1hZ2VJbnB1dFtdPiB7XG4gIGNvbnN0IGltYWdlczogSW1hZ2VJbnB1dFtdID0gW107XG4gIGlmIChpdGVtLmlucHV0LnNsaWRlSHRtbCkge1xuICAgIGNvbnN0IGltZyA9IGF3YWl0IHJlbmRlclNsaWRlKGl0ZW0uaW5wdXQuc2xpZGVIdG1sKTtcbiAgICBpZiAoaW1nKSBpbWFnZXMucHVzaChpbWcpO1xuICB9XG4gIGlmIChpdGVtLmlucHV0LnNsaWRlSHRtbEIpIHtcbiAgICBjb25zdCBpbWcgPSBhd2FpdCByZW5kZXJTbGlkZShpdGVtLmlucHV0LnNsaWRlSHRtbEIpO1xuICAgIGlmIChpbWcpIGltYWdlcy5wdXNoKGltZyk7XG4gIH1cbiAgcmV0dXJuIGltYWdlcztcbn1cblxuZnVuY3Rpb24gc3VtbWFyaXplKFxuICBhZGFwdGVyOiBJVkxNQWRhcHRlcixcbiAgcmVzdWx0czogcmVhZG9ubHkgSXRlbVJlc3VsdFtdLFxuICBzdGFydGVkQXQ6IHN0cmluZyxcbiAgZmluaXNoZWRBdDogc3RyaW5nLFxuKTogTW9kZWxSZXBvcnQge1xuICBjb25zdCB0b3RhbCA9IHJlc3VsdHMubGVuZ3RoO1xuICBjb25zdCBwYXNzZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gci5zY29yZSA+PSAwLjUpLmxlbmd0aDtcbiAgY29uc3Qgc2NvcmVNZWFuID0gdG90YWwgPiAwID8gcmVzdWx0cy5yZWR1Y2UoKGEsIHIpID0+IGEgKyByLnNjb3JlLCAwKSAvIHRvdGFsIDogMDtcblxuICBjb25zdCBieUNhdGVnb3J5OiBSZWNvcmQ8RXZhbENhdGVnb3J5LCB7IHRvdGFsOiBudW1iZXI7IHNjb3JlTWVhbjogbnVtYmVyIH0+ID0ge1xuICAgIHZpc3VhbDogeyB0b3RhbDogMCwgc2NvcmVNZWFuOiAwIH0sXG4gICAgYWN0aW9uOiB7IHRvdGFsOiAwLCBzY29yZU1lYW46IDAgfSxcbiAgfTtcbiAgY29uc3QgYnlTdWI6IFJlY29yZDxzdHJpbmcsIHsgdG90YWw6IG51bWJlcjsgc2NvcmVNZWFuOiBudW1iZXI7IHN1bTogbnVtYmVyIH0+ID0ge307XG5cbiAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMpIHtcbiAgICBjb25zdCBpdGVtID0gZmluZEl0ZW0oci5pdGVtSWQpO1xuICAgIGJ5Q2F0ZWdvcnlbaXRlbS5jYXRlZ29yeV0udG90YWwgKz0gMTtcbiAgICBieUNhdGVnb3J5W2l0ZW0uY2F0ZWdvcnldLnNjb3JlTWVhbiArPSByLnNjb3JlO1xuICAgIGNvbnN0IGtleSA9IGl0ZW0uc3ViY2F0ZWdvcnk7XG4gICAgY29uc3QgcHJldiA9IGJ5U3ViW2tleV0gPz8geyB0b3RhbDogMCwgc2NvcmVNZWFuOiAwLCBzdW06IDAgfTtcbiAgICBwcmV2LnRvdGFsICs9IDE7XG4gICAgcHJldi5zdW0gKz0gci5zY29yZTtcbiAgICBieVN1YltrZXldID0gcHJldjtcbiAgfVxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMoYnlDYXRlZ29yeSkgYXMgRXZhbENhdGVnb3J5W10pIHtcbiAgICBpZiAoYnlDYXRlZ29yeVtrXS50b3RhbCA+IDApIGJ5Q2F0ZWdvcnlba10uc2NvcmVNZWFuIC89IGJ5Q2F0ZWdvcnlba10udG90YWw7XG4gIH1cbiAgY29uc3QgZmluYWxCeVN1YjogUmVjb3JkPHN0cmluZywgeyB0b3RhbDogbnVtYmVyOyBzY29yZU1lYW46IG51bWJlciB9PiA9IHt9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhieVN1YikpIHtcbiAgICBmaW5hbEJ5U3ViW2tdID0geyB0b3RhbDogdi50b3RhbCwgc2NvcmVNZWFuOiB2LnN1bSAvIHYudG90YWwgfTtcbiAgfVxuXG4gIGNvbnN0IHRvdGFsTGF0ZW5jeU1zID0gcmVzdWx0cy5yZWR1Y2UoKGEsIHIpID0+IGEgKyByLmxhdGVuY3lNcywgMCk7XG4gIGNvbnN0IHRvdGFsVG9rZW5zID0gcmVzdWx0cy5yZWR1Y2UoKGEsIHIpID0+IGEgKyByLnVzYWdlLnByb21wdFRva2VucyArIHIudXNhZ2UuY29tcGxldGlvblRva2VucywgMCk7XG4gIGNvbnN0IHRvdGFsUHJvbXB0VG9rZW5zID0gcmVzdWx0cy5yZWR1Y2UoKGEsIHIpID0+IGEgKyByLnVzYWdlLnByb21wdFRva2VucywgMCk7XG4gIGNvbnN0IHRvdGFsUHJlZml4SGl0ID0gcmVzdWx0cy5yZWR1Y2UoKGEsIHIpID0+IGEgKyByLnByZWZpeEhpdFRva2VucywgMCk7XG4gIGNvbnN0IGF2Z1ByZWZpeEhpdFJhdGUgPSB0b3RhbFByb21wdFRva2VucyA+IDAgPyB0b3RhbFByZWZpeEhpdCAvIHRvdGFsUHJvbXB0VG9rZW5zIDogMDtcblxuICByZXR1cm4ge1xuICAgIG1vZGVsSWQ6IGFkYXB0ZXIubW9kZWxJbmZvLmlkLFxuICAgIG1vZGVsRGlzcGxheU5hbWU6IGFkYXB0ZXIubW9kZWxJbmZvLmRpc3BsYXlOYW1lLFxuICAgIHN0YXJ0ZWRBdCxcbiAgICBmaW5pc2hlZEF0LFxuICAgIHJlc3VsdHMsXG4gICAgc3VtbWFyeToge1xuICAgICAgdG90YWwsXG4gICAgICBwYXNzZWQsXG4gICAgICBmYWlsZWQ6IHRvdGFsIC0gcGFzc2VkLFxuICAgICAgc2NvcmVNZWFuLFxuICAgICAgYnlDYXRlZ29yeSxcbiAgICAgIGJ5U3ViY2F0ZWdvcnk6IGZpbmFsQnlTdWIsXG4gICAgICB0b3RhbExhdGVuY3lNcyxcbiAgICAgIHRvdGFsVG9rZW5zLFxuICAgICAgYXZnUHJlZml4SGl0UmF0ZSxcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBmaW5kSXRlbShpZDogc3RyaW5nKTogRXZhbEl0ZW0ge1xuICBjb25zdCBpdGVtID0gRVZBTF9TRVQuZmluZCgoaSkgPT4gaS5pZCA9PT0gaWQpO1xuICBpZiAoIWl0ZW0pIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBpdGVtIGlkOiAke2lkfWApO1xuICByZXR1cm4gaXRlbTtcbn1cbiIsICIvKipcbiAqIFJhZGl4Q2FjaGUgXHUyMDE0IFNHTGFuZy1zdHlsZSB0b2tlbiByYWRpeCB0cmVlIHdpdGggVFRMICsgTFJVIGV2aWN0aW9uLlxuICpcbiAqIE1hcHMgYSB0b2tlbi1JRCBzZXF1ZW5jZSAodGhlIHByb21wdCBwcmVmaXgpIHRvIGFuIG9wYXF1ZSBga3ZIYW5kbGVgIHRoYXRcbiAqIHRoZSBhZGFwdGVyIGNhbiB1c2UgdG8gc2tpcCBwcmVmaWxsLiBUaGUgdHJlZSBzdG9yZXMgY29tbW9uIHByZWZpeGVzIG9uY2UsXG4gKiB3aGljaCBpcyB0aGUgd2hvbGUgcG9pbnQgXHUyMDE0IGlmIHR3byByZXF1ZXN0cyBzaGFyZSBhIDUwMDAtdG9rZW4gc3lzdGVtIHByb21wdFxuICogKyBzbGlkZSBjb250ZXh0LCB0aGUgcHJlZmlsbCBoYXBwZW5zIG9uY2UuXG4gKlxuICogVGhpcyBmaWxlIGlzIHB1cmUgVHlwZVNjcmlwdCAvIHB1cmUgZGF0YSBzdHJ1Y3R1cmUuIFRoZSBhZGFwdGVyIG93bnMgdGhlXG4gKiBhY3R1YWwgS1YgdGVuc29yczsgdGhpcyBtb2R1bGUgdHJhY2tzIG1ldGFkYXRhIG9ubHkuXG4gKlxuICogU2VtYW50aWNzOlxuICogICAtIGBsb29rdXAodG9rZW5zKWAgcmV0dXJucyB0aGUgbG9uZ2VzdCBtYXRjaGluZyBwcmVmaXggKyBpdHMgaGFuZGxlLlxuICogICAtIGBpbnNlcnQodG9rZW5zLCBoYW5kbGUsIHNpemVCeXRlcylgIGFkZHMgKG9yIHJlZnJlc2hlcykgYW4gZW50cnkuXG4gKiAgIC0gVFRMICsgTFJVIGV2aWN0aW9uIGZpcmUgb24gZXZlcnkgaW5zZXJ0IHdoZW4gb3ZlciBidWRnZXQuXG4gKlxuICogU2VlOiBodHRwczovL3d3dy5sbXN5cy5vcmcvYmxvZy8yMDI0LTAxLTE3LXNnbGFuZy9cbiAqL1xuXG5leHBvcnQgdHlwZSBLVkhhbmRsZSA9IFJlYWRvbmx5PHtcbiAgLyoqIE9wYXF1ZSByZWZlcmVuY2UgdGhlIGFkYXB0ZXIgY2FuIHVzZSB0byByZXN0b3JlIEtWIHN0YXRlLiAqL1xuICBoYW5kbGU6IHVua25vd247XG4gIC8qKiBCeXRlcyB0aGlzIGVudHJ5IG9jY3VwaWVzIGluIFZSQU0gXHUyMDE0IHVzZWQgZm9yIGV2aWN0aW9uIGFjY291bnRpbmcuICovXG4gIHNpemVCeXRlczogbnVtYmVyO1xufT47XG5cbmV4cG9ydCB0eXBlIENhY2hlTG9va3VwUmVzdWx0ID0gUmVhZG9ubHk8e1xuICAvKiogTnVtYmVyIG9mIHRva2VucyBtYXRjaGVkIGZyb20gdGhlIHN0YXJ0IG9mIHRoZSBxdWVyeS4gKi9cbiAgbWF0Y2hlZFRva2VuczogbnVtYmVyO1xuICAvKiogQWRhcHRlci1sZXZlbCBoYW5kbGUgdG8gcmV1c2UuIGBudWxsYCBpZiB0aGUgbWF0Y2ggaXMgbGVuZ3RoIDAuICovXG4gIGhhbmRsZTogdW5rbm93biB8IG51bGw7XG59PjtcblxudHlwZSBOb2RlID0ge1xuICAvKiogVGhlIGVkZ2UgbGFiZWwgXHUyMDE0IHRva2VucyBmcm9tIHBhcmVudCB0byB0aGlzIG5vZGUuICovXG4gIGVkZ2U6IG51bWJlcltdO1xuICAvKiogSGFuZGxlIGF0dGFjaGVkIHdoZW4gdGhpcyBub2RlIG1hcmtzIHRoZSBlbmQgb2YgYW4gaW5zZXJ0ZWQgc2VxdWVuY2UuICovXG4gIGt2OiBLVkhhbmRsZSB8IG51bGw7XG4gIC8qKiBMYXN0IHRpbWUgdGhpcyBub2RlIHdhcyBoaXQgKGZvciBMUlUpLiAqL1xuICBsYXN0VXNlZE1zOiBudW1iZXI7XG4gIC8qKiBDcmVhdGlvbiB0aW1lIChmb3IgVFRMKS4gKi9cbiAgaW5zZXJ0ZWRNczogbnVtYmVyO1xuICAvKiogQ3VtdWxhdGl2ZSBzaXplIG9mIGBrdmAgYXQgdGhpcyBub2RlICgwIGlmIG5vbmUpLiAqL1xuICBzaXplQnl0ZXM6IG51bWJlcjtcbiAgY2hpbGRyZW46IE1hcDxudW1iZXIsIE5vZGU+O1xufTtcblxuZnVuY3Rpb24gbWFrZU5vZGUoZWRnZTogbnVtYmVyW10pOiBOb2RlIHtcbiAgcmV0dXJuIHtcbiAgICBlZGdlLFxuICAgIGt2OiBudWxsLFxuICAgIGxhc3RVc2VkTXM6IDAsXG4gICAgaW5zZXJ0ZWRNczogMCxcbiAgICBzaXplQnl0ZXM6IDAsXG4gICAgY2hpbGRyZW46IG5ldyBNYXAoKSxcbiAgfTtcbn1cblxuZXhwb3J0IHR5cGUgUmFkaXhDYWNoZU9wdGlvbnMgPSBSZWFkb25seTx7XG4gIC8qKiBUaW1lLXRvLWxpdmUgZm9yIGVhY2ggZW50cnksIGluIG1zLiBEZWZhdWx0IDUgbWludXRlcy4gKi9cbiAgdHRsTXM/OiBudW1iZXI7XG4gIC8qKiBNYXggdG90YWwgVlJBTSwgaW4gYnl0ZXMsIHRoZSBjYWNoZSBpcyBhbGxvd2VkIHRvIHVzZS4gRGVmYXVsdCAxNiBHQi4gKi9cbiAgbWF4Qnl0ZXM/OiBudW1iZXI7XG4gIC8qKiBXYWxsLWNsb2NrIGZ1bmN0aW9uIFx1MjAxNCBpbmplY3RlZCBmb3IgdGVzdHMuICovXG4gIG5vdz86ICgpID0+IG51bWJlcjtcbn0+O1xuXG5leHBvcnQgY2xhc3MgUmFkaXhDYWNoZSB7XG4gIHByaXZhdGUgcm9vdDogTm9kZSA9IG1ha2VOb2RlKFtdKTtcbiAgcHJpdmF0ZSB0b3RhbEJ5dGVzID0gMDtcbiAgcHJpdmF0ZSByZWFkb25seSB0dGxNczogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEJ5dGVzOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgbm93OiAoKSA9PiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3Iob3B0czogUmFkaXhDYWNoZU9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMudHRsTXMgPSBvcHRzLnR0bE1zID8/IDUgKiA2MF8wMDA7XG4gICAgdGhpcy5tYXhCeXRlcyA9IG9wdHMubWF4Qnl0ZXMgPz8gMTYgKiAxMDI0ICoqIDM7XG4gICAgdGhpcy5ub3cgPSBvcHRzLm5vdyA/PyBEYXRlLm5vdztcbiAgfVxuXG4gIC8qKlxuICAgKiBXYWxrIHRoZSB0cmVlIGdyZWVkeS1tYXRjaGluZyB0aGUgbG9uZ2VzdCBwcmVmaXggb2YgYHRva2Vuc2AuXG4gICAqIFJldHVybnMgaG93IG1hbnkgdG9rZW5zIG1hdGNoZWQgYW5kIHRoZSBoYW5kbGUgb2YgdGhlIGRlZXBlc3QgaGl0IG5vZGUuXG4gICAqL1xuICBsb29rdXAodG9rZW5zOiByZWFkb25seSBudW1iZXJbXSk6IENhY2hlTG9va3VwUmVzdWx0IHtcbiAgICB0aGlzLmV2aWN0RXhwaXJlZCgpO1xuICAgIGxldCBub2RlID0gdGhpcy5yb290O1xuICAgIGxldCBjdXJzb3IgPSAwO1xuICAgIGxldCBsYXN0SGl0OiB7IG5vZGU6IE5vZGU7IGF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuXG4gICAgd2hpbGUgKGN1cnNvciA8IHRva2Vucy5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGNoaWxkID0gbm9kZS5jaGlsZHJlbi5nZXQodG9rZW5zW2N1cnNvcl0pO1xuICAgICAgaWYgKCFjaGlsZCkgYnJlYWs7XG5cbiAgICAgIC8vIE1hdGNoIGFzIGZhciBhbG9uZyB0aGUgZWRnZSBhcyBwb3NzaWJsZS5cbiAgICAgIGxldCBlZGdlQ3Vyc29yID0gMDtcbiAgICAgIHdoaWxlIChcbiAgICAgICAgZWRnZUN1cnNvciA8IGNoaWxkLmVkZ2UubGVuZ3RoICYmXG4gICAgICAgIGN1cnNvciArIGVkZ2VDdXJzb3IgPCB0b2tlbnMubGVuZ3RoICYmXG4gICAgICAgIGNoaWxkLmVkZ2VbZWRnZUN1cnNvcl0gPT09IHRva2Vuc1tjdXJzb3IgKyBlZGdlQ3Vyc29yXVxuICAgICAgKSB7XG4gICAgICAgIGVkZ2VDdXJzb3IrKztcbiAgICAgIH1cblxuICAgICAgaWYgKGVkZ2VDdXJzb3IgPCBjaGlsZC5lZGdlLmxlbmd0aCkge1xuICAgICAgICAvLyBQYXJ0aWFsIGVkZ2UgbWF0Y2ggXHUyMDE0IHN0b3AgaGVyZS4gRGVlcGVzdCBoaXQgaXMgc3RpbGwgdGhlIGxhc3Qgb25lLlxuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY3Vyc29yICs9IGVkZ2VDdXJzb3I7XG4gICAgICBub2RlID0gY2hpbGQ7XG4gICAgICBpZiAobm9kZS5rdikge1xuICAgICAgICBsYXN0SGl0ID0geyBub2RlLCBhdDogY3Vyc29yIH07XG4gICAgICAgIG5vZGUubGFzdFVzZWRNcyA9IHRoaXMubm93KCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFsYXN0SGl0KSByZXR1cm4geyBtYXRjaGVkVG9rZW5zOiAwLCBoYW5kbGU6IG51bGwgfTtcbiAgICByZXR1cm4geyBtYXRjaGVkVG9rZW5zOiBsYXN0SGl0LmF0LCBoYW5kbGU6IGxhc3RIaXQubm9kZS5rdj8uaGFuZGxlID8/IG51bGwgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBJbnNlcnQgYHRva2VucyBcdTIxOTIgaGFuZGxlYC4gU3BsaXRzIGVkZ2VzIGFzIG5lZWRlZC4gRmlyZXMgZXZpY3Rpb24uXG4gICAqL1xuICBpbnNlcnQodG9rZW5zOiByZWFkb25seSBudW1iZXJbXSwga3Y6IEtWSGFuZGxlKTogdm9pZCB7XG4gICAgbGV0IG5vZGUgPSB0aGlzLnJvb3Q7XG4gICAgbGV0IGN1cnNvciA9IDA7XG5cbiAgICB3aGlsZSAoY3Vyc29yIDwgdG9rZW5zLmxlbmd0aCkge1xuICAgICAgY29uc3QgY2hpbGQgPSBub2RlLmNoaWxkcmVuLmdldCh0b2tlbnNbY3Vyc29yXSk7XG4gICAgICBpZiAoIWNoaWxkKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSBtYWtlTm9kZSh0b2tlbnMuc2xpY2UoY3Vyc29yKSk7XG4gICAgICAgIGxlYWYua3YgPSBrdjtcbiAgICAgICAgbGVhZi5zaXplQnl0ZXMgPSBrdi5zaXplQnl0ZXM7XG4gICAgICAgIGxlYWYuaW5zZXJ0ZWRNcyA9IHRoaXMubm93KCk7XG4gICAgICAgIGxlYWYubGFzdFVzZWRNcyA9IGxlYWYuaW5zZXJ0ZWRNcztcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5zZXQodG9rZW5zW2N1cnNvcl0sIGxlYWYpO1xuICAgICAgICB0aGlzLnRvdGFsQnl0ZXMgKz0ga3Yuc2l6ZUJ5dGVzO1xuICAgICAgICB0aGlzLmVuZm9yY2VCdWRnZXQoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICAvLyBIb3cgZmFyIGRvZXMgdGhlIGVkZ2UgbWF0Y2g/XG4gICAgICBsZXQgZWRnZUN1cnNvciA9IDA7XG4gICAgICB3aGlsZSAoXG4gICAgICAgIGVkZ2VDdXJzb3IgPCBjaGlsZC5lZGdlLmxlbmd0aCAmJlxuICAgICAgICBjdXJzb3IgKyBlZGdlQ3Vyc29yIDwgdG9rZW5zLmxlbmd0aCAmJlxuICAgICAgICBjaGlsZC5lZGdlW2VkZ2VDdXJzb3JdID09PSB0b2tlbnNbY3Vyc29yICsgZWRnZUN1cnNvcl1cbiAgICAgICkge1xuICAgICAgICBlZGdlQ3Vyc29yKys7XG4gICAgICB9XG5cbiAgICAgIGlmIChlZGdlQ3Vyc29yID09PSBjaGlsZC5lZGdlLmxlbmd0aCkge1xuICAgICAgICAvLyBGdWxsIGVkZ2UgbWF0Y2ggXHUyMDE0IGRlc2NlbmQuXG4gICAgICAgIGN1cnNvciArPSBlZGdlQ3Vyc29yO1xuICAgICAgICBub2RlID0gY2hpbGQ7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBQYXJ0aWFsIGVkZ2UgbWF0Y2ggXHUyMTkyIHNwbGl0IHRoZSBlZGdlIGF0IGVkZ2VDdXJzb3IuXG4gICAgICBjb25zdCBzcGxpdFByZWZpeCA9IGNoaWxkLmVkZ2Uuc2xpY2UoMCwgZWRnZUN1cnNvcik7XG4gICAgICBjb25zdCBzcGxpdFN1ZmZpeCA9IGNoaWxkLmVkZ2Uuc2xpY2UoZWRnZUN1cnNvcik7XG5cbiAgICAgIGNvbnN0IG9sZENoaWxkVGFpbCA9IG1ha2VOb2RlKHNwbGl0U3VmZml4KTtcbiAgICAgIG9sZENoaWxkVGFpbC5rdiA9IGNoaWxkLmt2O1xuICAgICAgb2xkQ2hpbGRUYWlsLnNpemVCeXRlcyA9IGNoaWxkLnNpemVCeXRlcztcbiAgICAgIG9sZENoaWxkVGFpbC5pbnNlcnRlZE1zID0gY2hpbGQuaW5zZXJ0ZWRNcztcbiAgICAgIG9sZENoaWxkVGFpbC5sYXN0VXNlZE1zID0gY2hpbGQubGFzdFVzZWRNcztcbiAgICAgIG9sZENoaWxkVGFpbC5jaGlsZHJlbiA9IGNoaWxkLmNoaWxkcmVuO1xuXG4gICAgICAvLyBSZXdyaXRlIGBjaGlsZGAgaW4gcGxhY2UgYXMgdGhlIHNwbGl0IG5vZGUuXG4gICAgICBjaGlsZC5lZGdlID0gc3BsaXRQcmVmaXg7XG4gICAgICBjaGlsZC5rdiA9IG51bGw7XG4gICAgICBjaGlsZC5zaXplQnl0ZXMgPSAwO1xuICAgICAgY2hpbGQuY2hpbGRyZW4gPSBuZXcgTWFwKFtbc3BsaXRTdWZmaXhbMF0sIG9sZENoaWxkVGFpbF1dKTtcblxuICAgICAgY3Vyc29yICs9IGVkZ2VDdXJzb3I7XG4gICAgICBub2RlID0gY2hpbGQ7XG4gICAgfVxuXG4gICAgLy8gV2hvbGUgdG9rZW4gc2VxdWVuY2UgY29uc3VtZWQgXHUyMDE0IGF0dGFjaCBoYW5kbGUgdG8gY3VycmVudCBub2RlLlxuICAgIGlmIChub2RlLmt2KSB0aGlzLnRvdGFsQnl0ZXMgLT0gbm9kZS5rdi5zaXplQnl0ZXM7XG4gICAgbm9kZS5rdiA9IGt2O1xuICAgIG5vZGUuc2l6ZUJ5dGVzID0ga3Yuc2l6ZUJ5dGVzO1xuICAgIG5vZGUuaW5zZXJ0ZWRNcyA9IHRoaXMubm93KCk7XG4gICAgbm9kZS5sYXN0VXNlZE1zID0gbm9kZS5pbnNlcnRlZE1zO1xuICAgIHRoaXMudG90YWxCeXRlcyArPSBrdi5zaXplQnl0ZXM7XG4gICAgdGhpcy5lbmZvcmNlQnVkZ2V0KCk7XG4gIH1cblxuICAvKiogRHJvcCBldmVyeXRoaW5nLiBVc2VkIG9uIG1vZGVsIHN3YXAuICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMucm9vdCA9IG1ha2VOb2RlKFtdKTtcbiAgICB0aGlzLnRvdGFsQnl0ZXMgPSAwO1xuICB9XG5cbiAgLyoqIFRvdGFsIGJ5dGVzIGN1cnJlbnRseSB0cmFja2VkIGJ5IHRoZSBjYWNoZS4gKi9cbiAgYnl0ZVNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy50b3RhbEJ5dGVzO1xuICB9XG5cbiAgLyoqIEV2aWN0IGVudHJpZXMgb2xkZXIgdGhhbiB0dGwuICovXG4gIHByaXZhdGUgZXZpY3RFeHBpcmVkKCk6IHZvaWQge1xuICAgIGNvbnN0IGN1dG9mZiA9IHRoaXMubm93KCkgLSB0aGlzLnR0bE1zO1xuICAgIHRoaXMud2Fsa0FuZEV2aWN0KChuKSA9PiBuLmluc2VydGVkTXMgPiAwICYmIG4uaW5zZXJ0ZWRNcyA8IGN1dG9mZik7XG4gIH1cblxuICAvKiogRXZpY3QgTFJVIGVudHJpZXMgdW50aWwgdW5kZXIgYnVkZ2V0LiAqL1xuICBwcml2YXRlIGVuZm9yY2VCdWRnZXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMudG90YWxCeXRlcyA8PSB0aGlzLm1heEJ5dGVzKSByZXR1cm47XG4gICAgLy8gQ29sbGVjdCBhbGwgbm9kZXMgd2l0aCBLViwgc29ydCBieSBsYXN0VXNlZE1zLCBkcm9wIG9sZGVzdCBmaXJzdC5cbiAgICBjb25zdCBhbGw6IE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IHdhbGsgPSAobjogTm9kZSk6IHZvaWQgPT4ge1xuICAgICAgaWYgKG4ua3YpIGFsbC5wdXNoKG4pO1xuICAgICAgZm9yIChjb25zdCBjIG9mIG4uY2hpbGRyZW4udmFsdWVzKCkpIHdhbGsoYyk7XG4gICAgfTtcbiAgICB3YWxrKHRoaXMucm9vdCk7XG4gICAgYWxsLnNvcnQoKGEsIGIpID0+IGEubGFzdFVzZWRNcyAtIGIubGFzdFVzZWRNcyk7XG5cbiAgICBmb3IgKGNvbnN0IG4gb2YgYWxsKSB7XG4gICAgICBpZiAodGhpcy50b3RhbEJ5dGVzIDw9IHRoaXMubWF4Qnl0ZXMpIGJyZWFrO1xuICAgICAgdGhpcy50b3RhbEJ5dGVzIC09IG4uc2l6ZUJ5dGVzO1xuICAgICAgbi5rdiA9IG51bGw7XG4gICAgICBuLnNpemVCeXRlcyA9IDA7XG4gICAgfVxuICB9XG5cbiAgLyoqIFdhbGsgYW5kIG51bGwgb3V0IEtWIG9uIG5vZGVzIG1hdGNoaW5nIHByZWRpY2F0ZS4gKi9cbiAgcHJpdmF0ZSB3YWxrQW5kRXZpY3Qoc2hvdWxkRXZpY3Q6IChuOiBOb2RlKSA9PiBib29sZWFuKTogdm9pZCB7XG4gICAgY29uc3Qgd2FsayA9IChuOiBOb2RlKTogdm9pZCA9PiB7XG4gICAgICBpZiAobi5rdiAmJiBzaG91bGRFdmljdChuKSkge1xuICAgICAgICB0aGlzLnRvdGFsQnl0ZXMgLT0gbi5zaXplQnl0ZXM7XG4gICAgICAgIG4ua3YgPSBudWxsO1xuICAgICAgICBuLnNpemVCeXRlcyA9IDA7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygbi5jaGlsZHJlbi52YWx1ZXMoKSkgd2FsayhjKTtcbiAgICB9O1xuICAgIHdhbGsodGhpcy5yb290KTtcbiAgfVxufVxuIiwgIi8qKlxuICogSW1hZ2VDYWNoZSBcdTIwMTQgU0hBLTI1Ni1rZXllZCBjYWNoZSBmb3IgdmlzaW9uIHRvd2VyIG91dHB1dHMuXG4gKlxuICogU2xpZGUtYnVpbGRpbmcgYWdlbnRzIGZlZWQgdGhlIG1vZGVsIHRoZSAqc2FtZSogc2xpZGUgc2NyZWVuc2hvdCBtYW55XG4gKiB0aW1lcyBhY3Jvc3MgdHVybnMgKHJlbmRlciBcdTIxOTIgY3JpdGlxdWUgXHUyMTkyIHJldmlzZSBcdTIxOTIgcmVuZGVyIFx1MjE5MiBjcml0aXF1ZSBcdTIwMjYpLlxuICogVGhlIHZpc2lvbiB0b3dlciAoVmlUIC8gU2lnTElQKSBpcyBkZXRlcm1pbmlzdGljOiBzYW1lIGJ5dGVzIGluIFx1MjE5MiBzYW1lXG4gKiBlbWJlZGRpbmdzIG91dC4gQ2FjaGluZyBpdHMgb3V0cHV0IGF2b2lkcyB0aGUgMTAwXHUyMDEzNTAwIG1zIHJlLWVuY29kZS5cbiAqXG4gKiBQdXJlIFR5cGVTY3JpcHQgXHUyMDE0IHRoZSBlbWJlZGRpbmcgaXRzZWxmIGlzIHN0b3JlZCBhcyBhbiBvcGFxdWUgaGFuZGxlIHRoZVxuICogYWRhcHRlciB1bmRlcnN0YW5kcy4gVFRMICsgTFJVIGV2aWN0aW9uIGtlZXBzIFZSQU0gYm91bmRlZC5cbiAqL1xuXG5leHBvcnQgdHlwZSBJbWFnZUVtYmVkZGluZyA9IFJlYWRvbmx5PHtcbiAgLyoqIEFkYXB0ZXItb3duZWQgb3BhcXVlIHRlbnNvciBvciBHUFUgYnVmZmVyIGlkLiAqL1xuICBoYW5kbGU6IHVua25vd247XG4gIC8qKiBCeXRlcyB0aGlzIGVudHJ5IG9jY3VwaWVzIGluIFZSQU0uICovXG4gIHNpemVCeXRlczogbnVtYmVyO1xufT47XG5cbnR5cGUgRW50cnkgPSB7XG4gIGVtYjogSW1hZ2VFbWJlZGRpbmc7XG4gIGxhc3RVc2VkTXM6IG51bWJlcjtcbiAgaW5zZXJ0ZWRNczogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgSW1hZ2VDYWNoZU9wdGlvbnMgPSBSZWFkb25seTx7XG4gIHR0bE1zPzogbnVtYmVyO1xuICBtYXhCeXRlcz86IG51bWJlcjtcbiAgbm93PzogKCkgPT4gbnVtYmVyO1xufT47XG5cbmV4cG9ydCBjbGFzcyBJbWFnZUNhY2hlIHtcbiAgcHJpdmF0ZSBtYXAgPSBuZXcgTWFwPHN0cmluZywgRW50cnk+KCk7XG4gIHByaXZhdGUgdG90YWxCeXRlcyA9IDA7XG4gIHByaXZhdGUgcmVhZG9ubHkgdHRsTXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhCeXRlczogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG5vdzogKCkgPT4gbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKG9wdHM6IEltYWdlQ2FjaGVPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnR0bE1zID0gb3B0cy50dGxNcyA/PyAxMCAqIDYwXzAwMDtcbiAgICB0aGlzLm1heEJ5dGVzID0gb3B0cy5tYXhCeXRlcyA/PyAyICogMTAyNCAqKiAzO1xuICAgIHRoaXMubm93ID0gb3B0cy5ub3cgPz8gRGF0ZS5ub3c7XG4gIH1cblxuICBnZXQoc2hhMjU2OiBzdHJpbmcpOiBJbWFnZUVtYmVkZGluZyB8IG51bGwge1xuICAgIHRoaXMuZXZpY3RFeHBpcmVkKCk7XG4gICAgY29uc3QgZSA9IHRoaXMubWFwLmdldChzaGEyNTYpO1xuICAgIGlmICghZSkgcmV0dXJuIG51bGw7XG4gICAgZS5sYXN0VXNlZE1zID0gdGhpcy5ub3coKTtcbiAgICByZXR1cm4gZS5lbWI7XG4gIH1cblxuICBwdXQoc2hhMjU2OiBzdHJpbmcsIGVtYjogSW1hZ2VFbWJlZGRpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMubWFwLmdldChzaGEyNTYpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgdGhpcy50b3RhbEJ5dGVzIC09IGV4aXN0aW5nLmVtYi5zaXplQnl0ZXM7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHRoaXMubm93KCk7XG4gICAgdGhpcy5tYXAuc2V0KHNoYTI1NiwgeyBlbWIsIGxhc3RVc2VkTXM6IG5vdywgaW5zZXJ0ZWRNczogbm93IH0pO1xuICAgIHRoaXMudG90YWxCeXRlcyArPSBlbWIuc2l6ZUJ5dGVzO1xuICAgIHRoaXMuZW5mb3JjZUJ1ZGdldCgpO1xuICB9XG5cbiAgaGFzKHNoYTI1Njogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMubWFwLmhhcyhzaGEyNTYpO1xuICB9XG5cbiAgc2l6ZSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLm1hcC5zaXplO1xuICB9XG5cbiAgYnl0ZVNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy50b3RhbEJ5dGVzO1xuICB9XG5cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5tYXAuY2xlYXIoKTtcbiAgICB0aGlzLnRvdGFsQnl0ZXMgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBldmljdEV4cGlyZWQoKTogdm9pZCB7XG4gICAgY29uc3QgY3V0b2ZmID0gdGhpcy5ub3coKSAtIHRoaXMudHRsTXM7XG4gICAgZm9yIChjb25zdCBbaywgZV0gb2YgdGhpcy5tYXApIHtcbiAgICAgIGlmIChlLmluc2VydGVkTXMgPCBjdXRvZmYpIHtcbiAgICAgICAgdGhpcy50b3RhbEJ5dGVzIC09IGUuZW1iLnNpemVCeXRlcztcbiAgICAgICAgdGhpcy5tYXAuZGVsZXRlKGspO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgZW5mb3JjZUJ1ZGdldCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy50b3RhbEJ5dGVzIDw9IHRoaXMubWF4Qnl0ZXMpIHJldHVybjtcbiAgICBjb25zdCBlbnRyaWVzID0gWy4uLnRoaXMubWFwLmVudHJpZXMoKV0uc29ydCgoYSwgYikgPT4gYVsxXS5sYXN0VXNlZE1zIC0gYlsxXS5sYXN0VXNlZE1zKTtcbiAgICBmb3IgKGNvbnN0IFtrLCBlXSBvZiBlbnRyaWVzKSB7XG4gICAgICBpZiAodGhpcy50b3RhbEJ5dGVzIDw9IHRoaXMubWF4Qnl0ZXMpIGJyZWFrO1xuICAgICAgdGhpcy50b3RhbEJ5dGVzIC09IGUuZW1iLnNpemVCeXRlcztcbiAgICAgIHRoaXMubWFwLmRlbGV0ZShrKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIENvbXB1dGUgc2hhMjU2IG9mIGEgVWludDhBcnJheSwgcmV0dXJuaW5nIGEgaGV4IHN0cmluZy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzaGEyNTZIZXgoYnl0ZXM6IFVpbnQ4QXJyYXkpOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBXb3JrcyBpbiBicm93c2VyIChTdWJ0bGVDcnlwdG8pIGFuZCBOb2RlIChnbG9iYWxUaGlzLmNyeXB0bykuXG4gIGNvbnN0IHN1YnRsZSA9IChnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgeyBjcnlwdG8/OiBDcnlwdG8gfSkuY3J5cHRvPy5zdWJ0bGU7XG4gIGlmICghc3VidGxlKSB0aHJvdyBuZXcgRXJyb3IoXCJTdWJ0bGVDcnlwdG8gbm90IGF2YWlsYWJsZVwiKTtcbiAgLy8gU3VidGxlQ3J5cHRvLmRpZ2VzdCByZXF1aXJlcyBhIEJ1ZmZlclNvdXJjZTsgcGFzcyBhIGZyZXNoIEFycmF5QnVmZmVyIGNvcHkuXG4gIGNvbnN0IGJ1ZiA9IGJ5dGVzLnNsaWNlKCkuYnVmZmVyO1xuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBzdWJ0bGUuZGlnZXN0KFwiU0hBLTI1NlwiLCBidWYpO1xuICBjb25zdCBhcnIgPSBuZXcgVWludDhBcnJheShkaWdlc3QpO1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcnIubGVuZ3RoOyBpKyspIG91dCArPSBhcnJbaV0udG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIG91dDtcbn1cbiIsICIvKipcbiAqIFRyYW5zZm9ybWVyc0pzQWRhcHRlciBcdTIwMTQgQGh1Z2dpbmdmYWNlL3RyYW5zZm9ybWVycyBiYWNrZW5kIChicm93c2VyICsgV2ViR1BVKS5cbiAqXG4gKiBVc2VzIHRoZSBPTk5YIFJ1bnRpbWUgV2ViIFdlYkdQVSBleGVjdXRpb24gcHJvdmlkZXIgdW5kZXIgdGhlIGhvb2QuXG4gKiBTdXBwb3J0cyBRd2VuMi41LVZMIC8gUXdlbjItVkwgLyBTbW9sVkxNIC8gTW9vbmRyZWFtIC8gUGhpLTMuNS1WaXNpb25cbiAqIHZpYSBIRiBPTk5YLWNvbW11bml0eSBleHBvcnRzLlxuICpcbiAqIExpa2Ugd2VibGxtLWFkYXB0ZXIudHMsIHRoaXMgaXMgYSBkeW5hbWljLWltcG9ydCBzaGVsbCBzbyBOb2RlLXNpZGVcbiAqIHVuaXQgdGVzdHMgZG8gbm90IGRyYWcgdGhlIGh1Z2UgQGh1Z2dpbmdmYWNlL3RyYW5zZm9ybWVycyBwYWNrYWdlIGludG9cbiAqIHRoZWlyIG1vZHVsZSBncmFwaC5cbiAqL1xuXG5pbXBvcnQgeyBSYWRpeENhY2hlLCB0eXBlIEtWSGFuZGxlIH0gZnJvbSBcIi4vcmFkaXgtY2FjaGUuanNcIjtcbmltcG9ydCB7IEltYWdlQ2FjaGUsIHR5cGUgSW1hZ2VFbWJlZGRpbmcgfSBmcm9tIFwiLi9pbWFnZS1jYWNoZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDaGF0UmVxdWVzdCwgQ2hhdFJlc3BvbnNlLCBNZXNzYWdlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgSVZMTUFkYXB0ZXIsIE1vZGVsSW5mbywgTW9kZWxMb2FkUHJvZ3Jlc3MgfSBmcm9tIFwiLi92bG0tYWRhcHRlci5qc1wiO1xuXG4vLyBOYXJyb3cgc3Vic2V0IG9mIHRoZSBAaHVnZ2luZ2ZhY2UvdHJhbnNmb3JtZXJzIHBpcGVsaW5lIEFQSS5cbnR5cGUgUGlwZWxpbmVGbiA9IChcbiAgaW5wdXQ6IEFycmF5PHsgcm9sZTogc3RyaW5nOyBjb250ZW50OiBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dD86IHN0cmluZzsgaW1hZ2U/OiBzdHJpbmcgfT4gfT4sXG4gIG9wdHM6IHsgbWF4X25ld190b2tlbnM/OiBudW1iZXI7IHRlbXBlcmF0dXJlPzogbnVtYmVyOyBkb19zYW1wbGU/OiBib29sZWFuIH0sXG4pID0+IFByb21pc2U8QXJyYXk8eyBnZW5lcmF0ZWRfdGV4dDogc3RyaW5nIH0+PjtcblxudHlwZSBUcmFuc2Zvcm1lcnNNb2R1bGUgPSB7XG4gIHBpcGVsaW5lOiAoXG4gICAgdGFzazogc3RyaW5nLFxuICAgIG1vZGVsSWQ6IHN0cmluZyxcbiAgICBvcHRzOiB7IGRldmljZT86IHN0cmluZzsgZHR5cGU/OiBzdHJpbmc7IHByb2dyZXNzX2NhbGxiYWNrPzogKHI6IHsgc3RhdHVzOiBzdHJpbmc7IHByb2dyZXNzPzogbnVtYmVyOyBmaWxlPzogc3RyaW5nIH0pID0+IHZvaWQgfSxcbiAgKSA9PiBQcm9taXNlPFBpcGVsaW5lRm4+O1xuICBlbnY6IHsgYmFja2VuZHM6IHsgb25ueDogeyB3YXNtOiB7IG51bVRocmVhZHM/OiBudW1iZXIgfTsgd2ViZ3B1OiB7IHBvd2VyUHJlZmVyZW5jZT86IHN0cmluZyB9IH0gfSB9O1xufTtcblxuZXhwb3J0IHR5cGUgVHJhbnNmb3JtZXJzSnNBZGFwdGVyT3B0aW9ucyA9IFJlYWRvbmx5PHtcbiAgbW9kZWxJZDogc3RyaW5nO1xuICAvKiogRGVmYXVsdCAnd2ViZ3B1Jy4gKi9cbiAgZGV2aWNlPzogXCJ3ZWJncHVcIiB8IFwid2FzbVwiIHwgXCJjcHVcIjtcbiAgLyoqIERlZmF1bHQgJ3E0Jy4gKi9cbiAgZHR5cGU/OiBcImZwMzJcIiB8IFwiZnAxNlwiIHwgXCJxOFwiIHwgXCJxNFwiIHwgXCJxNGYxNlwiO1xufT47XG5cbmV4cG9ydCBjbGFzcyBUcmFuc2Zvcm1lcnNKc0FkYXB0ZXIgaW1wbGVtZW50cyBJVkxNQWRhcHRlciB7XG4gIHJlYWRvbmx5IG1vZGVsSW5mbzogTW9kZWxJbmZvO1xuICBwcml2YXRlIHBpcGU6IFBpcGVsaW5lRm4gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkb25seSBrdiA9IG5ldyBSYWRpeENhY2hlKCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgaW1nQ2FjaGUgPSBuZXcgSW1hZ2VDYWNoZSgpO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgb3B0czogVHJhbnNmb3JtZXJzSnNBZGFwdGVyT3B0aW9ucykge1xuICAgIHRoaXMubW9kZWxJbmZvID0gTU9ERUxfSU5GT1tvcHRzLm1vZGVsSWRdID8/IHtcbiAgICAgIGlkOiBvcHRzLm1vZGVsSWQsXG4gICAgICBkaXNwbGF5TmFtZTogb3B0cy5tb2RlbElkLFxuICAgICAgdnJhbUJ5dGVzOiAwLFxuICAgICAgc3VwcG9ydHNWaXNpb246IHRydWUsXG4gICAgICBzdXBwb3J0c1Rvb2xzOiBmYWxzZSwgLy8gbW9zdCBIRiBleHBvcnRzIGRvIG5vdCBuYXRpdmVseSBlbWl0IHRvb2wgY2FsbHNcbiAgICAgIGNvbnRleHRXaW5kb3c6IDgxOTIsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGxvYWRNb2RlbChvblByb2dyZXNzPzogKHA6IE1vZGVsTG9hZFByb2dyZXNzKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMucGlwZSkgcmV0dXJuO1xuICAgIC8vIEB0cy1pZ25vcmUgXHUyMDE0IGR5bmFtaWMgaW1wb3J0LCBubyBoYXJkIGRlcFxuICAgIGNvbnN0IG1vZDogVHJhbnNmb3JtZXJzTW9kdWxlID0gYXdhaXQgaW1wb3J0KFwiQGh1Z2dpbmdmYWNlL3RyYW5zZm9ybWVyc1wiKTtcbiAgICB0aGlzLnBpcGUgPSBhd2FpdCBtb2QucGlwZWxpbmUoXCJpbWFnZS10ZXh0LXRvLXRleHRcIiwgdGhpcy5vcHRzLm1vZGVsSWQsIHtcbiAgICAgIGRldmljZTogdGhpcy5vcHRzLmRldmljZSA/PyBcIndlYmdwdVwiLFxuICAgICAgZHR5cGU6IHRoaXMub3B0cy5kdHlwZSA/PyBcInE0XCIsXG4gICAgICBwcm9ncmVzc19jYWxsYmFjazogKHIpID0+IHtcbiAgICAgICAgb25Qcm9ncmVzcz8uKHtcbiAgICAgICAgICBwcm9ncmVzczogci5wcm9ncmVzcyA/PyAwLFxuICAgICAgICAgIHN0YWdlOiBgJHtyLnN0YXR1c30ke3IuZmlsZSA/IFwiIFwiICsgci5maWxlIDogXCJcIn1gLFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cblxuICBpc1JlYWR5KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnBpcGUgIT09IG51bGw7XG4gIH1cblxuICBhc3luYyBnZW5lcmF0ZShyZXF1ZXN0OiBDaGF0UmVxdWVzdCk6IFByb21pc2U8Q2hhdFJlc3BvbnNlPiB7XG4gICAgaWYgKCF0aGlzLnBpcGUpIHRocm93IG5ldyBFcnJvcihcIlRyYW5zZm9ybWVyc0pzQWRhcHRlcjogbG9hZE1vZGVsKCkgbm90IGNhbGxlZFwiKTtcbiAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuXG4gICAgLy8gQ29tcG9zZSBIRi1zdHlsZSBtdWx0aW1vZGFsIG1lc3NhZ2VzLlxuICAgIGNvbnN0IGhmTWVzc2FnZXMgPSByZXF1ZXN0Lm1lc3NhZ2VzLm1hcCgobSkgPT4ge1xuICAgICAgY29uc3QgY29udGVudDogQXJyYXk8eyB0eXBlOiBzdHJpbmc7IHRleHQ/OiBzdHJpbmc7IGltYWdlPzogc3RyaW5nIH0+ID0gW107XG4gICAgICBmb3IgKGNvbnN0IGltZyBvZiBtLmltYWdlcyA/PyBbXSkgY29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBpbWFnZTogaW1nLnVybCB9KTtcbiAgICAgIGNvbnRlbnQucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBtLmNvbnRlbnQgfSk7XG4gICAgICByZXR1cm4geyByb2xlOiBtLnJvbGUsIGNvbnRlbnQgfTtcbiAgICB9KTtcblxuICAgIC8vIFRyYWNrIHN1cnJvZ2F0ZSB0b2tlbnMgZm9yIHRoZSByYWRpeCBjYWNoZS5cbiAgICBjb25zdCB0b2tlbnMgPSBzdXJyb2dhdGVUb2tlbml6ZShyZXF1ZXN0Lm1lc3NhZ2VzKTtcbiAgICBjb25zdCBoaXQgPSB0aGlzLmt2Lmxvb2t1cCh0b2tlbnMpO1xuXG4gICAgLy8gSW1hZ2UgY2FjaGU6IHJlY29yZCBoaXQgZm9yIHJlcG9ydGluZyBldmVuIHRob3VnaCB3ZSBkbyBub3QgeWV0IHBhdGNoXG4gICAgLy8gdGhlIHZpc2lvbiB0b3dlciBmb3J3YXJkIHBhc3MgKHRoYXQgcmVxdWlyZXMgYSBQUiBpbnRvIHRyYW5zZm9ybWVycy5qcykuXG4gICAgbGV0IGltYWdlQ2FjaGVIaXQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgcmVxdWVzdC5tZXNzYWdlcykge1xuICAgICAgZm9yIChjb25zdCBpbWcgb2YgbS5pbWFnZXMgPz8gW10pIHtcbiAgICAgICAgaWYgKHRoaXMuaW1nQ2FjaGUuaGFzKGltZy5zaGEyNTYpKSB7XG4gICAgICAgICAgaW1hZ2VDYWNoZUhpdCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgZW1iOiBJbWFnZUVtYmVkZGluZyA9IHsgaGFuZGxlOiBudWxsLCBzaXplQnl0ZXM6IDEwMjQgKiAxMDI0IH07XG4gICAgICAgICAgdGhpcy5pbWdDYWNoZS5wdXQoaW1nLnNoYTI1NiwgZW1iKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG91dCA9IGF3YWl0IHRoaXMucGlwZShoZk1lc3NhZ2VzLCB7XG4gICAgICBtYXhfbmV3X3Rva2VuczogcmVxdWVzdC5tYXhUb2tlbnMgPz8gMTAyNCxcbiAgICAgIHRlbXBlcmF0dXJlOiByZXF1ZXN0LnRlbXBlcmF0dXJlID8/IDAsXG4gICAgICBkb19zYW1wbGU6IChyZXF1ZXN0LnRlbXBlcmF0dXJlID8/IDApID4gMCxcbiAgICB9KTtcbiAgICBjb25zdCB0ZXh0ID0gb3V0WzBdPy5nZW5lcmF0ZWRfdGV4dCA/PyBcIlwiO1xuXG4gICAgLy8gUmVmcmVzaCByYWRpeCBjYWNoZSB3aXRoIHRoZSBuZXcgcHJvbXB0LlxuICAgIGNvbnN0IGhhbmRsZTogS1ZIYW5kbGUgPSB7XG4gICAgICBoYW5kbGU6IHsga2luZDogXCJ0cmFuc2Zvcm1lcnMtanNcIiB9LFxuICAgICAgc2l6ZUJ5dGVzOiB0b2tlbnMubGVuZ3RoICogNTEyLFxuICAgIH07XG4gICAgdGhpcy5rdi5pbnNlcnQodG9rZW5zLCBoYW5kbGUpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogdGV4dCB9LFxuICAgICAgdXNhZ2U6IHsgcHJvbXB0VG9rZW5zOiB0b2tlbnMubGVuZ3RoLCBjb21wbGV0aW9uVG9rZW5zOiB0ZXh0LnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pLmxlbmd0aCB9LFxuICAgICAgbGF0ZW5jeU1zOiBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0LFxuICAgICAgcHJlZml4SGl0VG9rZW5zOiBoaXQubWF0Y2hlZFRva2VucyxcbiAgICAgIGltYWdlQ2FjaGVIaXQsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGRpc3Bvc2UoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5waXBlID0gbnVsbDtcbiAgICB0aGlzLmt2LmNsZWFyKCk7XG4gICAgdGhpcy5pbWdDYWNoZS5jbGVhcigpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHN1cnJvZ2F0ZVRva2VuaXplKG1lc3NhZ2VzOiByZWFkb25seSBNZXNzYWdlW10pOiBudW1iZXJbXSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG0gb2YgbWVzc2FnZXMpIHtcbiAgICBwYXJ0cy5wdXNoKGA8JHttLnJvbGV9PmApO1xuICAgIHBhcnRzLnB1c2gobS5jb250ZW50KTtcbiAgICBpZiAobS5pbWFnZXMpIGZvciAoY29uc3QgaW1nIG9mIG0uaW1hZ2VzKSBwYXJ0cy5wdXNoKGA8aW1nOiR7aW1nLnNoYTI1Nn0+YCk7XG4gIH1cbiAgY29uc3Qgd29yZHMgPSBwYXJ0cy5qb2luKFwiIFwiKS5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgcmV0dXJuIHdvcmRzLm1hcCgodykgPT4ge1xuICAgIGxldCBoID0gNTM4MTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHcubGVuZ3RoOyBpKyspIGggPSAoKGggPDwgNSkgKyBoICsgdy5jaGFyQ29kZUF0KGkpKSB8IDA7XG4gICAgcmV0dXJuIGggPj4+IDA7XG4gIH0pO1xufVxuXG4vLyBLbm93biBIRiBtb2RlbCBtZXRhZGF0YS5cbmNvbnN0IE1PREVMX0lORk86IFJlY29yZDxzdHJpbmcsIE1vZGVsSW5mbz4gPSB7XG4gIFwib25ueC1jb21tdW5pdHkvUXdlbjIuNS1WTC03Qi1JbnN0cnVjdFwiOiB7XG4gICAgaWQ6IFwib25ueC1jb21tdW5pdHkvUXdlbjIuNS1WTC03Qi1JbnN0cnVjdFwiLFxuICAgIGRpc3BsYXlOYW1lOiBcIlF3ZW4yLjUtVkwgN0IgSW5zdHJ1Y3QgKE9OTlgpXCIsXG4gICAgdnJhbUJ5dGVzOiA1LjUgKiAxMDI0ICoqIDMsXG4gICAgc3VwcG9ydHNWaXNpb246IHRydWUsXG4gICAgc3VwcG9ydHNUb29sczogdHJ1ZSxcbiAgICBjb250ZXh0V2luZG93OiAzMjc2OCxcbiAgfSxcbiAgXCJvbm54LWNvbW11bml0eS9Rd2VuMi41LVZMLTNCLUluc3RydWN0XCI6IHtcbiAgICBpZDogXCJvbm54LWNvbW11bml0eS9Rd2VuMi41LVZMLTNCLUluc3RydWN0XCIsXG4gICAgZGlzcGxheU5hbWU6IFwiUXdlbjIuNS1WTCAzQiBJbnN0cnVjdCAoT05OWClcIixcbiAgICB2cmFtQnl0ZXM6IDIuOCAqIDEwMjQgKiogMyxcbiAgICBzdXBwb3J0c1Zpc2lvbjogdHJ1ZSxcbiAgICBzdXBwb3J0c1Rvb2xzOiB0cnVlLFxuICAgIGNvbnRleHRXaW5kb3c6IDMyNzY4LFxuICB9LFxuICBcIkh1Z2dpbmdGYWNlVEIvU21vbFZMTTItMi4yQi1JbnN0cnVjdFwiOiB7XG4gICAgaWQ6IFwiSHVnZ2luZ0ZhY2VUQi9TbW9sVkxNMi0yLjJCLUluc3RydWN0XCIsXG4gICAgZGlzcGxheU5hbWU6IFwiU21vbFZMTTIgMi4yQiBJbnN0cnVjdFwiLFxuICAgIHZyYW1CeXRlczogMS41ICogMTAyNCAqKiAzLFxuICAgIHN1cHBvcnRzVmlzaW9uOiB0cnVlLFxuICAgIHN1cHBvcnRzVG9vbHM6IGZhbHNlLFxuICAgIGNvbnRleHRXaW5kb3c6IDgxOTIsXG4gIH0sXG4gIFwidmlraHlhdGsvbW9vbmRyZWFtMlwiOiB7XG4gICAgaWQ6IFwidmlraHlhdGsvbW9vbmRyZWFtMlwiLFxuICAgIGRpc3BsYXlOYW1lOiBcIk1vb25kcmVhbSAyXCIsXG4gICAgdnJhbUJ5dGVzOiAxLjMgKiAxMDI0ICoqIDMsXG4gICAgc3VwcG9ydHNWaXNpb246IHRydWUsXG4gICAgc3VwcG9ydHNUb29sczogZmFsc2UsXG4gICAgY29udGV4dFdpbmRvdzogMjA0OCxcbiAgfSxcbn07XG4iLCAiLyoqXG4gKiBXZWJMTE1BZGFwdGVyIFx1MjAxNCBAbWxjLWFpL3dlYi1sbG0gYmFja2VuZCAoYnJvd3NlciArIFdlYkdQVSkuXG4gKlxuICogVGhpcyBmaWxlIGlzIGRlbGliZXJhdGVseSBkZXBlbmRlbmN5LWxpZ2h0OiBpdCB1c2VzIGR5bmFtaWMgYGltcG9ydCgpYCBzb1xuICogTm9kZS1zaWRlIHVuaXQgdGVzdHMgdGhhdCBuZXZlciBpbnN0YW50aWF0ZSB0aGlzIGNsYXNzIGRvIG5vdCBwdWxsXG4gKiBAbWxjLWFpL3dlYi1sbG0gaW50byB0aGVpciBtb2R1bGUgZ3JhcGguIFRoZSBicm93c2VyIGhhcm5lc3MgY2FsbHMgaXQgdmlhXG4gKiBgbmV3IFdlYkxMTUFkYXB0ZXIoLi4uKWAgYW5kIGV2ZXJ5dGhpbmcgd29ya3MuXG4gKlxuICogUHJlZml4LUtWIHJldXNlIHN0cmF0ZWd5OlxuICogICBXZWJMTE0gZG9lcyBub3QgZXhwb3NlIEtWIHRlbnNvcnMgZGlyZWN0bHksIGJ1dCBpdHMgY2hhdCBlbmdpbmUgbWFpbnRhaW5zXG4gKiAgIGFuIGludGVybmFsIGBjb252ZXJzYXRpb25gIHdob3NlIGBtZXNzYWdlc2AgQVJFIHRoZSBwcmVmaXguIElmIHdlIGNhbGxcbiAqICAgYGNoYXRDb21wbGV0aW9uYCB3aXRoIGFuIGBtZXNzYWdlc2AgYXJyYXkgdGhhdCBzdGFydHMgd2l0aCB0aGUgZXhhY3RcbiAqICAgc2FtZSB0b2tlbnMgYXMgdGhlIHByZXZpb3VzIGNhbGwsIFdlYkxMTSdzIHBhZ2VkLWF0dGVudGlvbiBibG9jayBwb29sXG4gKiAgIHJldXNlcyB0aGUgYmxvY2tzIHVuZGVyIHRoZSBob29kLiBPdXIgUmFkaXhDYWNoZSB0aGVyZWZvcmUgdHJhY2tzXG4gKiAgIG1ldGFkYXRhIG9ubHkgXHUyMDE0IGl0IHRlbGxzIHVzIEhPVyBNQU5ZIHRva2VucyB3ZXJlIHJldXNlZCBzbyB3ZSBjYW4gcmVwb3J0XG4gKiAgIHByZWZpeEhpdFRva2VucyB0byB0aGUgaGFybmVzcy5cbiAqL1xuXG5pbXBvcnQgeyBSYWRpeENhY2hlLCB0eXBlIEtWSGFuZGxlIH0gZnJvbSBcIi4vcmFkaXgtY2FjaGUuanNcIjtcbmltcG9ydCB7IEltYWdlQ2FjaGUgfSBmcm9tIFwiLi9pbWFnZS1jYWNoZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDaGF0UmVxdWVzdCwgQ2hhdFJlc3BvbnNlLCBNZXNzYWdlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgSVZMTUFkYXB0ZXIsIE1vZGVsSW5mbywgTW9kZWxMb2FkUHJvZ3Jlc3MgfSBmcm9tIFwiLi92bG0tYWRhcHRlci5qc1wiO1xuXG4vLyAtLS0tIFdlYkxMTSB0eXBlcyB3ZSB1c2UgKG5hcnJvdyBzdWJzZXQsIGR1Y2stdHlwZWQgdG8gYXZvaWQgaGFyZCBkZXApIC0tLS1cblxudHlwZSBXZWJMTE1Nb2R1bGUgPSB7XG4gIENyZWF0ZU1MQ0VuZ2luZTogKFxuICAgIG1vZGVsSWQ6IHN0cmluZyxcbiAgICBjb25maWc6IHsgaW5pdFByb2dyZXNzQ2FsbGJhY2s/OiAocjogeyBwcm9ncmVzczogbnVtYmVyOyB0ZXh0OiBzdHJpbmcgfSkgPT4gdm9pZCB9LFxuICApID0+IFByb21pc2U8V2ViTExNRW5naW5lPjtcbn07XG5cbnR5cGUgV2ViTExNRW5naW5lID0ge1xuICBjaGF0OiB7XG4gICAgY29tcGxldGlvbnM6IHtcbiAgICAgIGNyZWF0ZTogKHJlcToge1xuICAgICAgICBtZXNzYWdlczogQXJyYXk8eyByb2xlOiBzdHJpbmc7IGNvbnRlbnQ6IHVua25vd24gfT47XG4gICAgICAgIHRlbXBlcmF0dXJlPzogbnVtYmVyO1xuICAgICAgICBtYXhfdG9rZW5zPzogbnVtYmVyO1xuICAgICAgICBzZWVkPzogbnVtYmVyO1xuICAgICAgfSkgPT4gUHJvbWlzZTx7XG4gICAgICAgIGNob2ljZXM6IEFycmF5PHsgbWVzc2FnZTogeyByb2xlOiBzdHJpbmc7IGNvbnRlbnQ6IHN0cmluZyB9IH0+O1xuICAgICAgICB1c2FnZT86IHsgcHJvbXB0X3Rva2VuczogbnVtYmVyOyBjb21wbGV0aW9uX3Rva2VuczogbnVtYmVyIH07XG4gICAgICB9PjtcbiAgICB9O1xuICB9O1xuICB1bmxvYWQ6ICgpID0+IFByb21pc2U8dm9pZD47XG4gIGdldE1lc3NhZ2U6ICgpID0+IFByb21pc2U8c3RyaW5nPjtcbn07XG5cbmV4cG9ydCB0eXBlIFdlYkxMTUFkYXB0ZXJPcHRpb25zID0gUmVhZG9ubHk8e1xuICBtb2RlbElkOiBzdHJpbmc7XG4gIC8qKiBDYWNoZSBvcHRpb25zLiBTZW5zaWJsZSBkZWZhdWx0cyBhcmUgZmluZS4gKi9cbiAgY2FjaGVNYXhCeXRlcz86IG51bWJlcjtcbiAgY2FjaGVUdGxNcz86IG51bWJlcjtcbn0+O1xuXG5leHBvcnQgY2xhc3MgV2ViTExNQWRhcHRlciBpbXBsZW1lbnRzIElWTE1BZGFwdGVyIHtcbiAgcmVhZG9ubHkgbW9kZWxJbmZvOiBNb2RlbEluZm87XG4gIHByaXZhdGUgZW5naW5lOiBXZWJMTE1FbmdpbmUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkb25seSBrdiA9IG5ldyBSYWRpeENhY2hlKCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgaW1nQ2FjaGUgPSBuZXcgSW1hZ2VDYWNoZSgpO1xuICBwcml2YXRlIGxhc3RQcm9tcHRUb2tlbnM6IG51bWJlcltdID0gW107XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBvcHRzOiBXZWJMTE1BZGFwdGVyT3B0aW9ucykge1xuICAgIHRoaXMubW9kZWxJbmZvID0gTU9ERUxfSU5GT1tvcHRzLm1vZGVsSWRdID8/IHtcbiAgICAgIGlkOiBvcHRzLm1vZGVsSWQsXG4gICAgICBkaXNwbGF5TmFtZTogb3B0cy5tb2RlbElkLFxuICAgICAgdnJhbUJ5dGVzOiAwLFxuICAgICAgc3VwcG9ydHNWaXNpb246IG9wdHMubW9kZWxJZC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidmlzaW9uXCIpLFxuICAgICAgc3VwcG9ydHNUb29sczogdHJ1ZSxcbiAgICAgIGNvbnRleHRXaW5kb3c6IDgxOTIsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGxvYWRNb2RlbChvblByb2dyZXNzPzogKHA6IE1vZGVsTG9hZFByb2dyZXNzKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZW5naW5lKSByZXR1cm47XG4gICAgLy8gQHRzLWlnbm9yZSBcdTIwMTQgZHluYW1pYyBpbXBvcnQsIG5vIHR5cGVzIHB1bGxlZCBpbiBOb2RlIHRlc3QgcnVuc1xuICAgIGNvbnN0IG1vZDogV2ViTExNTW9kdWxlID0gYXdhaXQgaW1wb3J0KFwiQG1sYy1haS93ZWItbGxtXCIpO1xuICAgIHRoaXMuZW5naW5lID0gYXdhaXQgbW9kLkNyZWF0ZU1MQ0VuZ2luZSh0aGlzLm9wdHMubW9kZWxJZCwge1xuICAgICAgaW5pdFByb2dyZXNzQ2FsbGJhY2s6IChyKSA9PiBvblByb2dyZXNzPy4oeyBwcm9ncmVzczogci5wcm9ncmVzcywgc3RhZ2U6IHIudGV4dCB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIGlzUmVhZHkoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZW5naW5lICE9PSBudWxsO1xuICB9XG5cbiAgYXN5bmMgZ2VuZXJhdGUocmVxdWVzdDogQ2hhdFJlcXVlc3QpOiBQcm9taXNlPENoYXRSZXNwb25zZT4ge1xuICAgIGlmICghdGhpcy5lbmdpbmUpIHRocm93IG5ldyBFcnJvcihcIldlYkxMTUFkYXB0ZXI6IGxvYWRNb2RlbCgpIG5vdCBjYWxsZWRcIik7XG4gICAgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcblxuICAgIC8vIEFwcHJveGltYXRlIHRva2VuaXphdGlvbiB2aWEgY2hhci1oYXNoaW5nIGZvciByYWRpeCBsb29rdXAuIFdlYkxMTVxuICAgIC8vIGRvZXMgbm90IGV4cG9zZSBpdHMgdG9rZW5pemVyIHB1YmxpY2x5LCBzbyB3ZSB1c2UgYSBkZXRlcm1pbmlzdGljXG4gICAgLy8gc3Vycm9nYXRlIHRoYXQncyBzdGFibGUgYWNyb3NzIGNhbGxzIFx1MjAxNCBnb29kIGVub3VnaCBmb3IgaGl0LXJhdGUgc3RhdHMuXG4gICAgY29uc3QgdG9rZW5zID0gc3Vycm9nYXRlVG9rZW5pemUocmVxdWVzdC5tZXNzYWdlcyk7XG4gICAgY29uc3QgaGl0ID0gdGhpcy5rdi5sb29rdXAodG9rZW5zKTtcblxuICAgIGNvbnN0IHdlYmxsbU1lc3NhZ2VzID0gcmVxdWVzdC5tZXNzYWdlcy5tYXAoKG0pID0+ICh7XG4gICAgICByb2xlOiBtLnJvbGUsXG4gICAgICBjb250ZW50OiBtLmltYWdlcyAmJiBtLmltYWdlcy5sZW5ndGggPiAwXG4gICAgICAgID8gW1xuICAgICAgICAgICAgLi4ubS5pbWFnZXMubWFwKChpbWcpID0+ICh7IHR5cGU6IFwiaW1hZ2VfdXJsXCIsIGltYWdlX3VybDogeyB1cmw6IGltZy51cmwgfSB9KSksXG4gICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBtLmNvbnRlbnQgfSxcbiAgICAgICAgICBdXG4gICAgICAgIDogbS5jb250ZW50LFxuICAgIH0pKTtcblxuICAgIGNvbnN0IHJlc3AgPSBhd2FpdCB0aGlzLmVuZ2luZS5jaGF0LmNvbXBsZXRpb25zLmNyZWF0ZSh7XG4gICAgICBtZXNzYWdlczogd2VibGxtTWVzc2FnZXMsXG4gICAgICB0ZW1wZXJhdHVyZTogcmVxdWVzdC50ZW1wZXJhdHVyZSA/PyAwLFxuICAgICAgbWF4X3Rva2VuczogcmVxdWVzdC5tYXhUb2tlbnMgPz8gMTAyNCxcbiAgICAgIHNlZWQ6IHJlcXVlc3Quc2VlZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHRleHQgPSByZXNwLmNob2ljZXNbMF0/Lm1lc3NhZ2UuY29udGVudCA/PyBcIlwiO1xuICAgIGNvbnN0IHVzYWdlID0gcmVzcC51c2FnZSA/PyB7IHByb21wdF90b2tlbnM6IHRva2Vucy5sZW5ndGgsIGNvbXBsZXRpb25fdG9rZW5zOiAwIH07XG5cbiAgICAvLyBVcGRhdGUgcmFkaXggY2FjaGUgd2l0aCB0aGUgZnVsbCByZXF1ZXN0IHRva2VucyBhcyBcInByZWZpeCBmb3IgbmV4dCBjYWxsXCIuXG4gICAgY29uc3QgaGFuZGxlOiBLVkhhbmRsZSA9IHtcbiAgICAgIGhhbmRsZTogeyBlbmdpbmVSZWY6IHRoaXMuZW5naW5lIH0sXG4gICAgICBzaXplQnl0ZXM6IHRva2Vucy5sZW5ndGggKiA1MTIsIC8vIHJvdWdoIDAuNSBLQi90b2tlbiBmb3IgYSA3QiBxNCBtb2RlbFxuICAgIH07XG4gICAgdGhpcy5rdi5pbnNlcnQodG9rZW5zLCBoYW5kbGUpO1xuICAgIHRoaXMubGFzdFByb21wdFRva2VucyA9IHRva2VucztcblxuICAgIGNvbnN0IGFzc2lzdGFudE1lc3NhZ2U6IE1lc3NhZ2UgPSB7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IHRleHQgfTtcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogYXNzaXN0YW50TWVzc2FnZSxcbiAgICAgIHVzYWdlOiB7XG4gICAgICAgIHByb21wdFRva2VuczogdXNhZ2UucHJvbXB0X3Rva2VucyxcbiAgICAgICAgY29tcGxldGlvblRva2VuczogdXNhZ2UuY29tcGxldGlvbl90b2tlbnMsXG4gICAgICB9LFxuICAgICAgbGF0ZW5jeU1zOiBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0LFxuICAgICAgcHJlZml4SGl0VG9rZW5zOiBoaXQubWF0Y2hlZFRva2VucyxcbiAgICAgIGltYWdlQ2FjaGVIaXQ6IHJlcXVlc3QubWVzc2FnZXMuc29tZShcbiAgICAgICAgKG0pID0+IG0uaW1hZ2VzPy5zb21lKChpKSA9PiB0aGlzLmltZ0NhY2hlLmhhcyhpLnNoYTI1NikpID8/IGZhbHNlLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgZGlzcG9zZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmVuZ2luZT8udW5sb2FkKCk7XG4gICAgdGhpcy5lbmdpbmUgPSBudWxsO1xuICAgIHRoaXMua3YuY2xlYXIoKTtcbiAgICB0aGlzLmltZ0NhY2hlLmNsZWFyKCk7XG4gICAgdGhpcy5sYXN0UHJvbXB0VG9rZW5zID0gW107XG4gIH1cbn1cblxuLyoqXG4gKiBTdGFibGUgc3Vycm9nYXRlIHRva2VuaXplciBcdTIwMTQgdXNlZCBvbmx5IGZvciByYWRpeCBtZXRhZGF0YS5cbiAqIFNwbGl0cyBvbiB3aGl0ZXNwYWNlIGFuZCBoYXNoZXMgZWFjaCB3b3JkIHRvIGEgMzItYml0IGludC4gRGV0ZXJtaW5pc21cbiAqIGFjcm9zcyBjYWxscyBpcyB0aGUgb25seSBwcm9wZXJ0eSB3ZSBuZWVkOyBhYnNvbHV0ZSB0b2tlbiBjb3VudHMgZG8gbm90XG4gKiBoYXZlIHRvIG1hdGNoIHRoZSByZWFsIHRva2VuaXplci5cbiAqL1xuZnVuY3Rpb24gc3Vycm9nYXRlVG9rZW5pemUobWVzc2FnZXM6IHJlYWRvbmx5IE1lc3NhZ2VbXSk6IG51bWJlcltdIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgbSBvZiBtZXNzYWdlcykge1xuICAgIHBhcnRzLnB1c2goYDwke20ucm9sZX0+YCk7XG4gICAgcGFydHMucHVzaChtLmNvbnRlbnQpO1xuICAgIGlmIChtLmltYWdlcykgZm9yIChjb25zdCBpbWcgb2YgbS5pbWFnZXMpIHBhcnRzLnB1c2goYDxpbWc6JHtpbWcuc2hhMjU2fT5gKTtcbiAgfVxuICBjb25zdCB3b3JkcyA9IHBhcnRzLmpvaW4oXCIgXCIpLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pO1xuICByZXR1cm4gd29yZHMubWFwKGRqYjIpO1xufVxuXG5mdW5jdGlvbiBkamIyKHM6IHN0cmluZyk6IG51bWJlciB7XG4gIGxldCBoID0gNTM4MTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzLmxlbmd0aDsgaSsrKSBoID0gKChoIDw8IDUpICsgaCArIHMuY2hhckNvZGVBdChpKSkgfCAwO1xuICByZXR1cm4gaCA+Pj4gMDtcbn1cblxuLy8gLS0tIEtub3duIG1vZGVsIG1ldGFkYXRhIChrZXB0IGluIHN5bmMgd2l0aCBAbWxjLWFpL3dlYi1sbG0gcHJlYnVpbHQgbGlzdCkgLS0tXG5jb25zdCBNT0RFTF9JTkZPOiBSZWNvcmQ8c3RyaW5nLCBNb2RlbEluZm8+ID0ge1xuICBcIlBoaS0zLjUtdmlzaW9uLWluc3RydWN0LXE0ZjE2XzEtTUxDXCI6IHtcbiAgICBpZDogXCJQaGktMy41LXZpc2lvbi1pbnN0cnVjdC1xNGYxNl8xLU1MQ1wiLFxuICAgIGRpc3BsYXlOYW1lOiBcIlBoaS0zLjUgVmlzaW9uIEluc3RydWN0IChxNGYxNilcIixcbiAgICB2cmFtQnl0ZXM6IDMuOTUgKiAxMDI0ICoqIDMsXG4gICAgc3VwcG9ydHNWaXNpb246IHRydWUsXG4gICAgc3VwcG9ydHNUb29sczogdHJ1ZSxcbiAgICBjb250ZXh0V2luZG93OiA0MDk2LFxuICB9LFxuICBcIlBoaS0zLjUtdmlzaW9uLWluc3RydWN0LXE0ZjMyXzEtTUxDXCI6IHtcbiAgICBpZDogXCJQaGktMy41LXZpc2lvbi1pbnN0cnVjdC1xNGYzMl8xLU1MQ1wiLFxuICAgIGRpc3BsYXlOYW1lOiBcIlBoaS0zLjUgVmlzaW9uIEluc3RydWN0IChxNGYzMilcIixcbiAgICB2cmFtQnl0ZXM6IDUuODggKiAxMDI0ICoqIDMsXG4gICAgc3VwcG9ydHNWaXNpb246IHRydWUsXG4gICAgc3VwcG9ydHNUb29sczogdHJ1ZSxcbiAgICBjb250ZXh0V2luZG93OiA0MDk2LFxuICB9LFxufTtcbiIsICIvKipcbiAqIE1vY2tBZGFwdGVyIFx1MjAxNCBkZXRlcm1pbmlzdGljLCBuby1HUFUgZmFrZSBmb3IgdW5pdCB0ZXN0cy5cbiAqXG4gKiBHaXZlbiBhIHJlcXVlc3QsIHByb2R1Y2VzIGEgcmVzcG9uc2UgYmFzZWQgb24gYSBzY3JpcHRlZCByZXNwb25zZSBtYXAgT1JcbiAqIGEgZmFsbGJhY2sgaGV1cmlzdGljIChlY2hvIC8gY2FubmVkIEpTT04pLiBTaW11bGF0ZXMgcHJlZml4IGNhY2hlIGhpdHMgYnlcbiAqIHRyYWNraW5nIHRoZSBsb25nZXN0IGNvbW1vbiBwcmVmaXggYWNyb3NzIHNlcXVlbnRpYWwgY2FsbHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBDaGF0UmVxdWVzdCwgQ2hhdFJlc3BvbnNlLCBNZXNzYWdlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgSVZMTUFkYXB0ZXIsIE1vZGVsSW5mbywgTW9kZWxMb2FkUHJvZ3Jlc3MgfSBmcm9tIFwiLi92bG0tYWRhcHRlci5qc1wiO1xuXG4vKiogQSBzY3JpcHRlZCByZXNwb25zZSBcdTIwMTQgbWF0Y2hlZCBieSB0aGUgbGFzdCB1c2VyIG1lc3NhZ2UgdGV4dCAoc3Vic3RyaW5nKS4gKi9cbmV4cG9ydCB0eXBlIE1vY2tTY3JpcHQgPSBSZWFkb25seTx7XG4gIG1hdGNoOiBzdHJpbmc7XG4gIHJlc3BvbnNlOiBzdHJpbmc7XG4gIHRvb2xDYWxscz86IE1lc3NhZ2VbXCJ0b29sQ2FsbHNcIl07XG59PjtcblxuZXhwb3J0IGNsYXNzIE1vY2tBZGFwdGVyIGltcGxlbWVudHMgSVZMTUFkYXB0ZXIge1xuICByZWFkb25seSBtb2RlbEluZm86IE1vZGVsSW5mbyA9IHtcbiAgICBpZDogXCJtb2NrLXZsbVwiLFxuICAgIGRpc3BsYXlOYW1lOiBcIk1vY2sgVkxNICh1bml0IHRlc3RzKVwiLFxuICAgIHZyYW1CeXRlczogMCxcbiAgICBzdXBwb3J0c1Zpc2lvbjogdHJ1ZSxcbiAgICBzdXBwb3J0c1Rvb2xzOiB0cnVlLFxuICAgIGNvbnRleHRXaW5kb3c6IDgxOTIsXG4gIH07XG5cbiAgcHJpdmF0ZSByZWFkeSA9IGZhbHNlO1xuICBwcml2YXRlIHNjcmlwdHM6IHJlYWRvbmx5IE1vY2tTY3JpcHRbXTtcbiAgcHJpdmF0ZSBsYXN0UHJvbXB0VG9rZW5zOiByZWFkb25seSBudW1iZXJbXSA9IFtdO1xuICAvLyBEZXRlcm1pbmlzdGljIHBzZXVkby10b2tlbml6ZXI6IGhhc2ggd29yZHMgXHUyMTkyIDMyLWJpdCBpbnRzLCBzdGFibGUgYWNyb3NzIHJ1bnMuXG4gIHByaXZhdGUgdG9rZW5pemUobXNnczogcmVhZG9ubHkgTWVzc2FnZVtdKTogbnVtYmVyW10ge1xuICAgIGNvbnN0IHRleHQgPSBtc2dzXG4gICAgICAubWFwKChtKSA9PiBgJHttLnJvbGV9OiR7bS5jb250ZW50fSR7bS5pbWFnZXM/Lm1hcCgoaSkgPT4gYFtpbWc6JHtpLnNoYTI1Nn1dYCkuam9pbihcIlwiKSA/PyBcIlwifWApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICAvLyBkamIyIGhhc2ggcGVyIHdoaXRlc3BhY2Ugd29yZFxuICAgIGNvbnN0IHdvcmRzID0gdGV4dC5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKTtcbiAgICByZXR1cm4gd29yZHMubWFwKCh3KSA9PiB7XG4gICAgICBsZXQgaCA9IDUzODE7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHcubGVuZ3RoOyBpKyspIGggPSAoKGggPDwgNSkgKyBoICsgdy5jaGFyQ29kZUF0KGkpKSB8IDA7XG4gICAgICByZXR1cm4gaCA+Pj4gMDtcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0cnVjdG9yKHNjcmlwdHM6IHJlYWRvbmx5IE1vY2tTY3JpcHRbXSA9IFtdKSB7XG4gICAgdGhpcy5zY3JpcHRzID0gc2NyaXB0cztcbiAgfVxuXG4gIGFzeW5jIGxvYWRNb2RlbChvblByb2dyZXNzPzogKHA6IE1vZGVsTG9hZFByb2dyZXNzKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgb25Qcm9ncmVzcz8uKHsgcHJvZ3Jlc3M6IDAuNSwgc3RhZ2U6IFwibW9jay1sb2FkaW5nXCIgfSk7XG4gICAgb25Qcm9ncmVzcz8uKHsgcHJvZ3Jlc3M6IDEsIHN0YWdlOiBcInJlYWR5XCIgfSk7XG4gICAgdGhpcy5yZWFkeSA9IHRydWU7XG4gIH1cblxuICBpc1JlYWR5KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICB9XG5cbiAgYXN5bmMgZ2VuZXJhdGUocmVxdWVzdDogQ2hhdFJlcXVlc3QpOiBQcm9taXNlPENoYXRSZXNwb25zZT4ge1xuICAgIGlmICghdGhpcy5yZWFkeSkgdGhyb3cgbmV3IEVycm9yKFwiTW9ja0FkYXB0ZXI6IGxvYWRNb2RlbCgpIG5vdCBjYWxsZWRcIik7XG4gICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHRva2VucyA9IHRoaXMudG9rZW5pemUocmVxdWVzdC5tZXNzYWdlcyk7XG5cbiAgICAvLyBDb21wdXRlIHByZWZpeCBoaXQgdnMgbGFzdCBjYWxsXG4gICAgbGV0IGhpdCA9IDA7XG4gICAgd2hpbGUgKGhpdCA8IHRva2Vucy5sZW5ndGggJiYgaGl0IDwgdGhpcy5sYXN0UHJvbXB0VG9rZW5zLmxlbmd0aCAmJiB0b2tlbnNbaGl0XSA9PT0gdGhpcy5sYXN0UHJvbXB0VG9rZW5zW2hpdF0pIHtcbiAgICAgIGhpdCsrO1xuICAgIH1cblxuICAgIGNvbnN0IGxhc3RVc2VyID0gWy4uLnJlcXVlc3QubWVzc2FnZXNdLnJldmVyc2UoKS5maW5kKChtKSA9PiBtLnJvbGUgPT09IFwidXNlclwiKTtcbiAgICBjb25zdCB1c2VyVGV4dCA9IGxhc3RVc2VyPy5jb250ZW50ID8/IFwiXCI7XG4gICAgY29uc3Qgc2NyaXB0ID0gdGhpcy5zY3JpcHRzLmZpbmQoKHMpID0+IHVzZXJUZXh0LmluY2x1ZGVzKHMubWF0Y2gpKTtcblxuICAgIGxldCByZXNwb25zZVRleHQ6IHN0cmluZztcbiAgICBsZXQgdG9vbENhbGxzOiBNZXNzYWdlW1widG9vbENhbGxzXCJdIHwgdW5kZWZpbmVkO1xuICAgIGlmIChzY3JpcHQpIHtcbiAgICAgIHJlc3BvbnNlVGV4dCA9IHNjcmlwdC5yZXNwb25zZTtcbiAgICAgIHRvb2xDYWxscyA9IHNjcmlwdC50b29sQ2FsbHM7XG4gICAgfSBlbHNlIGlmIChyZXF1ZXN0Lmpzb25Nb2RlKSB7XG4gICAgICByZXNwb25zZVRleHQgPSBKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBlY2hvOiB1c2VyVGV4dC5zbGljZSgwLCA2NCkgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3BvbnNlVGV4dCA9IGBtb2NrIHJlc3BvbnNlIHRvOiAke3VzZXJUZXh0LnNsaWNlKDAsIDY0KX1gO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc3BvbnNlOiBDaGF0UmVzcG9uc2UgPSB7XG4gICAgICBtZXNzYWdlOiB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IHJlc3BvbnNlVGV4dCxcbiAgICAgICAgdG9vbENhbGxzLFxuICAgICAgfSxcbiAgICAgIHVzYWdlOiB7XG4gICAgICAgIHByb21wdFRva2VuczogdG9rZW5zLmxlbmd0aCxcbiAgICAgICAgY29tcGxldGlvblRva2VuczogcmVzcG9uc2VUZXh0LnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pLmxlbmd0aCxcbiAgICAgIH0sXG4gICAgICBsYXRlbmN5TXM6IERhdGUubm93KCkgLSBzdGFydCxcbiAgICAgIHByZWZpeEhpdFRva2VuczogaGl0LFxuICAgICAgaW1hZ2VDYWNoZUhpdDogZmFsc2UsXG4gICAgfTtcblxuICAgIHRoaXMubGFzdFByb21wdFRva2VucyA9IHRva2VucztcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cblxuICBhc3luYyBkaXNwb3NlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxhc3RQcm9tcHRUb2tlbnMgPSBbXTtcbiAgfVxufVxuIiwgIi8qKlxuICogYnJvd3Nlci1oYXJuZXNzLnRzIFx1MjAxNCBlbnRyeSBwb2ludCBidW5kbGVkIGludG8gYnJvd3Nlci1oYXJuZXNzLmJ1bmRsZS5qcy5cbiAqXG4gKiBUaGlzIHJ1bnMgaW4gYSBDaHJvbWUgdGFiIHdpdGggV2ViR1BVIGF2YWlsYWJsZS4gSXQgZXhwb3NlcyBvbmUgZnVuY3Rpb25cbiAqIG9uIHdpbmRvdzogYHdpbmRvdy5fX2xvY2FsQ29tcG9zZXIucnVuRXZhbCh7IG1vZGVsSWQsIGFkYXB0ZXJLaW5kIH0pYCxcbiAqIHdoaWNoIGxvYWRzIHRoZSBzZWxlY3RlZCBhZGFwdGVyLCBydW5zIHRoZSAxMDAtaXRlbSBldmFsLCBhbmQgcmV0dXJucyBhXG4gKiBNb2RlbFJlcG9ydCBhcyBKU09OLlxuICpcbiAqIFRoZSBOb2RlIGRyaXZlciAocnVuLWV2YWwudHMpIGxhdW5jaGVzIENocm9tZSwgc2VydmVzIHRoaXMgcGFnZSwgY2FsbHNcbiAqIHJ1bkV2YWwgdmlhIGBSdW50aW1lLmV2YWx1YXRlYCwgYW5kIHdyaXRlcyB0aGUgcmV0dXJuZWQgcmVwb3J0IHRvIGRpc2suXG4gKlxuICogVGhpcyBmaWxlIGlzIG9ubHkgY29tcGlsZWQgaW50byB0aGUgYnJvd3NlciBidW5kbGUgXHUyMDE0IG5ldmVyIGltcG9ydGVkIGZyb21cbiAqIE5vZGUtc2lkZSB1bml0IHRlc3RzICh3aGljaCB3b3VsZCBoaXQgdGhlIGR5bmFtaWMgaW1wb3J0IG9mIHRoZSBhZGFwdGVycykuXG4gKi9cblxuaW1wb3J0IHsgcnVuRXZhbCB9IGZyb20gXCIuL2hhcm5lc3MuanNcIjtcbmltcG9ydCB7IFRyYW5zZm9ybWVyc0pzQWRhcHRlciB9IGZyb20gXCIuL3RyYW5zZm9ybWVycy1qcy1hZGFwdGVyLmpzXCI7XG5pbXBvcnQgeyBXZWJMTE1BZGFwdGVyIH0gZnJvbSBcIi4vd2VibGxtLWFkYXB0ZXIuanNcIjtcbmltcG9ydCB7IE1vY2tBZGFwdGVyIH0gZnJvbSBcIi4vbW9jay1hZGFwdGVyLmpzXCI7XG5pbXBvcnQgeyBzaGEyNTZIZXggfSBmcm9tIFwiLi9pbWFnZS1jYWNoZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBJbWFnZUlucHV0IH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWxSZXBvcnQgfSBmcm9tIFwiLi9ldmFsLXR5cGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IElWTE1BZGFwdGVyIH0gZnJvbSBcIi4vdmxtLWFkYXB0ZXIuanNcIjtcblxudHlwZSBSdW5PcHRpb25zID0ge1xuICBtb2RlbElkOiBzdHJpbmc7XG4gIGFkYXB0ZXJLaW5kOiBcIndlYmxsbVwiIHwgXCJ0cmFuc2Zvcm1lcnMtanNcIiB8IFwibW9ja1wiO1xuICAvKiogT3B0aW9uYWw6IGZpbHRlciB0byBOIGl0ZW1zIGZvciBxdWljayBzbW9rZSB0ZXN0cy4gKi9cbiAgbGltaXQ/OiBudW1iZXI7XG59O1xuXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIF9fbG9jYWxDb21wb3Nlcjoge1xuICAgICAgcnVuRXZhbDogKG9wdHM6IFJ1bk9wdGlvbnMpID0+IFByb21pc2U8TW9kZWxSZXBvcnQ+O1xuICAgIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlQWRhcHRlcihvcHRzOiBSdW5PcHRpb25zKTogSVZMTUFkYXB0ZXIge1xuICBpZiAob3B0cy5hZGFwdGVyS2luZCA9PT0gXCJ3ZWJsbG1cIikge1xuICAgIHJldHVybiBuZXcgV2ViTExNQWRhcHRlcih7IG1vZGVsSWQ6IG9wdHMubW9kZWxJZCB9KTtcbiAgfVxuICBpZiAob3B0cy5hZGFwdGVyS2luZCA9PT0gXCJtb2NrXCIpIHtcbiAgICByZXR1cm4gbmV3IE1vY2tBZGFwdGVyKCk7XG4gIH1cbiAgcmV0dXJuIG5ldyBUcmFuc2Zvcm1lcnNKc0FkYXB0ZXIoeyBtb2RlbElkOiBvcHRzLm1vZGVsSWQsIGRldmljZTogXCJ3ZWJncHVcIiwgZHR5cGU6IFwicTRcIiB9KTtcbn1cblxuLyoqXG4gKiBQcm9kdWNlIGEgMTkyMFx1MDBENzEwODAgYmxhbmsgUE5HIHdpdGggYSBkZXRlcm1pbmlzdGljIHNoYTI1NiBiYXNlZCBvbiB0aGVcbiAqIEhUTUwgc3RyaW5nLiBVc2VkIGFzIGEgc2FmZSBmYWxsYmFjayB3aGVuIHRoZSBTVkctZm9yZWlnbk9iamVjdCByYXN0ZXJpemVyXG4gKiB0cmlwcyBDaHJvbWUncyBjYW52YXMtdGFpbnQgcHJvdGVjdGlvbiAoaXQgZG9lcywgcmVsaWFibHksIGluIG1vZGVyblxuICogQ2hyb21lKS4gTW9jay1hZGFwdGVyIHJ1bnMgbmV2ZXIgbG9vayBhdCB0aGUgaW1hZ2UgYnl0ZXMsIHNvIHRoaXMgaXNcbiAqIHN1ZmZpY2llbnQgZm9yIHBpcGVsaW5lIHNtb2tlIHRlc3RzLiBBIHJlYWwgR1BVIGhvc3Qgc2hvdWxkIGVpdGhlcjpcbiAqICAgLSBkcml2ZSByYXN0ZXJpemF0aW9uIGZyb20gTm9kZSB2aWEgQ0RQIFBhZ2UuY2FwdHVyZVNjcmVlbnNob3QsIG9yXG4gKiAgIC0gYnVuZGxlIGh0bWwyY2FudmFzIGFuZCByZW5kZXIgdmlhIGEgc2FuY3Rpb25lZCBET01cdTIxOTJjYW52YXMgcGF0aC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVuZGVyQmxhbmtQbmcodGFnOiBzdHJpbmcpOiBQcm9taXNlPEltYWdlSW5wdXQgfCBudWxsPiB7XG4gIGNvbnN0IGNhbnZhcyA9IG5ldyBPZmZzY3JlZW5DYW52YXMoMTkyMCwgMTA4MCk7XG4gIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XG4gIGlmICghY3R4KSByZXR1cm4gbnVsbDtcbiAgY3R4LmZpbGxTdHlsZSA9IFwiI2ZmZlwiO1xuICBjdHguZmlsbFJlY3QoMCwgMCwgMTkyMCwgMTA4MCk7XG4gIGN0eC5maWxsU3R5bGUgPSBcIiMwYjBmMTlcIjtcbiAgY3R4LmZvbnQgPSBcIjMycHggc3lzdGVtLXVpXCI7XG4gIGN0eC5maWxsVGV4dChgW2ZhbGxiYWNrIHJlbmRlcl0gJHt0YWcuc2xpY2UoMCwgMjAwKX1gLCAzMiwgNjQpO1xuICBjb25zdCBibG9iID0gYXdhaXQgY2FudmFzLmNvbnZlcnRUb0Jsb2IoeyB0eXBlOiBcImltYWdlL3BuZ1wiIH0pO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGJsb2IuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IHNoYSA9IGF3YWl0IHNoYTI1NkhleChieXRlcyk7XG4gIGNvbnN0IGRhdGFVcmwgPSBhd2FpdCBibG9iVG9EYXRhVXJsKGJsb2IpO1xuICByZXR1cm4geyBzaGEyNTY6IHNoYSwgdXJsOiBkYXRhVXJsLCB3aWR0aDogMTkyMCwgaGVpZ2h0OiAxMDgwIH07XG59XG5cbi8qKlxuICogUmVuZGVyIGFuIEhUTUwgZnJhZ21lbnQgaW50byBhIDE5MjBcdTAwRDcxMDgwIFBORyB2aWEgYW4gb2Zmc2NyZWVuIGlmcmFtZSArXG4gKiB0aGUgYnJvd3NlcidzIGJ1aWx0LWluIE9mZnNjcmVlbkNhbnZhcy50b0Jsb2IgcGF0aC4gQXNzdW1lcyB0aGUgaGFybmVzc1xuICogcGFnZSBpcyBzZXJ2ZWQgb3ZlciBIVFRQIChub3QgZmlsZTovLykgc28gY2FudmFzLnRvQmxvYiB3b3JrcyB3aXRob3V0XG4gKiBjcm9zcy1vcmlnaW4gdGFpbnQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNsaWRlVG9QbmcoaHRtbDogc3RyaW5nKTogUHJvbWlzZTxJbWFnZUlucHV0IHwgbnVsbD4ge1xuICBjb25zdCBzYW5kYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyZW5kZXItc2FuZGJveFwiKTtcbiAgaWYgKCFzYW5kYm94KSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBpZnJhbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaWZyYW1lXCIpO1xuICBpZnJhbWUuc3R5bGUud2lkdGggPSBcIjE5MjBweFwiO1xuICBpZnJhbWUuc3R5bGUuaGVpZ2h0ID0gXCIxMDgwcHhcIjtcbiAgaWZyYW1lLnN0eWxlLmJvcmRlciA9IFwiMFwiO1xuICBzYW5kYm94LmlubmVySFRNTCA9IFwiXCI7XG4gIHNhbmRib3guYXBwZW5kQ2hpbGQoaWZyYW1lKTtcblxuICBjb25zdCBkb2MgPSBpZnJhbWUuY29udGVudERvY3VtZW50ITtcbiAgZG9jLm9wZW4oKTtcbiAgZG9jLndyaXRlKFxuICAgIGA8IWRvY3R5cGUgaHRtbD48aHRtbD48aGVhZD48bWV0YSBjaGFyc2V0PVwidXRmLThcIj48c3R5bGU+aHRtbCxib2R5e21hcmdpbjowO3BhZGRpbmc6MDtiYWNrZ3JvdW5kOiNmZmZ9PC9zdHlsZT48L2hlYWQ+PGJvZHk+JHtodG1sfTwvYm9keT48L2h0bWw+YCxcbiAgKTtcbiAgZG9jLmNsb3NlKCk7XG5cbiAgLy8gV2FpdCBvbmUgZnJhbWUgZm9yIGxheW91dC5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiByKG51bGwpKSk7XG5cbiAgLy8gU2VyaWFsaXplIHRoZSBpZnJhbWUgYm9keSB0byBhbiBTVkcgZm9yZWlnbk9iamVjdCBhbmQgcmFzdGVyaXplLlxuICAvLyBUaGlzIGF2b2lkcyBodG1sMmNhbnZhcyBhcyBhIGRlcGVuZGVuY3kgXHUyMDE0IGFsbCBkb25lIHdpdGggRE9NIEFQSXMgb25seS5cbiAgY29uc3Qgc3ZnTnMgPSBcImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCI7XG4gIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhzdmdOcywgXCJzdmdcIik7XG4gIHN2Zy5zZXRBdHRyaWJ1dGUoXCJ4bWxuc1wiLCBzdmdOcyk7XG4gIHN2Zy5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBcIjE5MjBcIik7XG4gIHN2Zy5zZXRBdHRyaWJ1dGUoXCJoZWlnaHRcIiwgXCIxMDgwXCIpO1xuICBjb25zdCBmbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnROUyhzdmdOcywgXCJmb3JlaWduT2JqZWN0XCIpO1xuICBmby5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBcIjEwMCVcIik7XG4gIGZvLnNldEF0dHJpYnV0ZShcImhlaWdodFwiLCBcIjEwMCVcIik7XG4gIGNvbnN0IGRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpdi5zZXRBdHRyaWJ1dGUoXCJ4bWxuc1wiLCBcImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIik7XG4gIGRpdi5pbm5lckhUTUwgPSBodG1sO1xuICBmby5hcHBlbmRDaGlsZChkaXYpO1xuICBzdmcuYXBwZW5kQ2hpbGQoZm8pO1xuXG4gIGNvbnN0IHN2Z1N0ciA9IG5ldyBYTUxTZXJpYWxpemVyKCkuc2VyaWFsaXplVG9TdHJpbmcoc3ZnKTtcbiAgY29uc3Qgc3ZnQmxvYiA9IG5ldyBCbG9iKFtzdmdTdHJdLCB7IHR5cGU6IFwiaW1hZ2Uvc3ZnK3htbDtjaGFyc2V0PXV0Zi04XCIgfSk7XG4gIGNvbnN0IHN2Z1VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoc3ZnQmxvYik7XG4gIHRyeSB7XG4gICAgY29uc3QgaW1nID0gbmV3IEltYWdlKCk7XG4gICAgaW1nLndpZHRoID0gMTkyMDtcbiAgICBpbWcuaGVpZ2h0ID0gMTA4MDtcbiAgICBpbWcuc3JjID0gc3ZnVXJsO1xuICAgIGF3YWl0IGltZy5kZWNvZGUoKTtcbiAgICBjb25zdCBjYW52YXMgPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKDE5MjAsIDEwODApO1xuICAgIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XG4gICAgaWYgKCFjdHgpIHJldHVybiBudWxsO1xuICAgIGN0eC5maWxsU3R5bGUgPSBcIiNmZmZcIjtcbiAgICBjdHguZmlsbFJlY3QoMCwgMCwgMTkyMCwgMTA4MCk7XG4gICAgY3R4LmRyYXdJbWFnZShpbWcgYXMgdW5rbm93biBhcyBDYW52YXNJbWFnZVNvdXJjZSwgMCwgMCwgMTkyMCwgMTA4MCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJsb2IgPSBhd2FpdCBjYW52YXMuY29udmVydFRvQmxvYih7IHR5cGU6IFwiaW1hZ2UvcG5nXCIgfSk7XG4gICAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGJsb2IuYXJyYXlCdWZmZXIoKSk7XG4gICAgICBjb25zdCBzaGEgPSBhd2FpdCBzaGEyNTZIZXgoYnl0ZXMpO1xuICAgICAgY29uc3QgZGF0YVVybCA9IGF3YWl0IGJsb2JUb0RhdGFVcmwoYmxvYik7XG4gICAgICByZXR1cm4geyBzaGEyNTY6IHNoYSwgdXJsOiBkYXRhVXJsLCB3aWR0aDogMTkyMCwgaGVpZ2h0OiAxMDgwIH07XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8gQ2hyb21lIHRhaW50cyBjYW52YXNlcyB0aGF0IGhhZCBhbiBTVkcrZm9yZWlnbk9iamVjdCBkcmF3biBpbnRvIHRoZW1cbiAgICAgIC8vIChTZWN1cml0eUVycm9yIG9uIGNvbnZlcnRUb0Jsb2IpLiBGYWxsIGJhY2sgdG8gYSBibGFuayBhbm5vdGF0ZWQgUE5HXG4gICAgICAvLyBzbyB0aGUgcGlwZWxpbmUgc3RpbGwgcHJvZHVjZXMgYSBNb2RlbFJlcG9ydC5cbiAgICAgIHJldHVybiByZW5kZXJCbGFua1BuZyhodG1sKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgVVJMLnJldm9rZU9iamVjdFVSTChzdmdVcmwpO1xuICAgIHNhbmRib3gucmVtb3ZlQ2hpbGQoaWZyYW1lKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBibG9iVG9EYXRhVXJsKGJsb2I6IEJsb2IpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG4gICAgcmVhZGVyLm9ubG9hZCA9ICgpID0+IHJlc29sdmUocmVhZGVyLnJlc3VsdCBhcyBzdHJpbmcpO1xuICAgIHJlYWRlci5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlYWRlci5lcnJvcik7XG4gICAgcmVhZGVyLnJlYWRBc0RhdGFVUkwoYmxvYik7XG4gIH0pO1xufVxuXG53aW5kb3cuX19sb2NhbENvbXBvc2VyID0ge1xuICBhc3luYyBydW5FdmFsKG9wdHM6IFJ1bk9wdGlvbnMpOiBQcm9taXNlPE1vZGVsUmVwb3J0PiB7XG4gICAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzdGF0dXNcIik7XG4gICAgY29uc3QgcHJvZ3Jlc3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb2dyZXNzXCIpO1xuICAgIGlmIChzdGF0dXMpIHN0YXR1cy50ZXh0Q29udGVudCA9IGBMb2FkaW5nICR7b3B0cy5tb2RlbElkfSAoJHtvcHRzLmFkYXB0ZXJLaW5kfSlcdTIwMjZgO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IGNyZWF0ZUFkYXB0ZXIob3B0cyk7XG4gICAgYXdhaXQgYWRhcHRlci5sb2FkTW9kZWwoKHApID0+IHtcbiAgICAgIGlmIChzdGF0dXMpIHN0YXR1cy50ZXh0Q29udGVudCA9IGBbJHsocC5wcm9ncmVzcyAqIDEwMCkudG9GaXhlZCgwKX0lXSAke3Auc3RhZ2V9YDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGxpbWl0ID0gb3B0cy5saW1pdDtcbiAgICBpZiAoc3RhdHVzKSB7XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBgUnVubmluZyAke2xpbWl0ID8/IDEwMH0gaXRlbXMgYWdhaW5zdCAke29wdHMubW9kZWxJZH1cdTIwMjZgO1xuICAgIH1cbiAgICBsZXQgc2VlbiA9IDA7XG4gICAgY29uc3QgcmVwb3J0ID0gYXdhaXQgcnVuRXZhbCh7XG4gICAgICBhZGFwdGVyLFxuICAgICAgcmVuZGVyU2xpZGVUb1BuZyxcbiAgICAgIGZpbHRlcjogbGltaXQgPyAoKSA9PiBzZWVuKysgPCBsaW1pdCA6IHVuZGVmaW5lZCxcbiAgICAgIG9uSXRlbUNvbXBsZXRlOiAociwgaXRlbSkgPT4ge1xuICAgICAgICBpZiAoIXByb2dyZXNzKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBsaW5lLmNsYXNzTmFtZSA9IHIuc2NvcmUgPj0gMC41ID8gXCJva1wiIDogXCJiYWRcIjtcbiAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGAke2l0ZW0uaWQucGFkRW5kKDE4KX0gJHtyLnNjb3JlID49IDAuNSA/IFwiUEFTU1wiIDogXCJGQUlMXCJ9ICR7ci5yZWFzb259YDtcbiAgICAgICAgcHJvZ3Jlc3MuYXBwZW5kQ2hpbGQobGluZSk7XG4gICAgICAgIHByb2dyZXNzLnNjcm9sbFRvcCA9IHByb2dyZXNzLnNjcm9sbEhlaWdodDtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBpZiAoc3RhdHVzKSB7XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBgRG9uZS4gJHtyZXBvcnQuc3VtbWFyeS5wYXNzZWR9LyR7cmVwb3J0LnN1bW1hcnkudG90YWx9IHBhc3NlZCAobWVhbiBzY29yZSAke3JlcG9ydC5zdW1tYXJ5LnNjb3JlTWVhbi50b0ZpeGVkKDMpfSlgO1xuICAgIH1cbiAgICBhd2FpdCBhZGFwdGVyLmRpc3Bvc2UoKTtcbiAgICByZXR1cm4gcmVwb3J0O1xuICB9LFxufTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFpQ0EsSUFBTSxhQUNKO0FBRUYsSUFBTSxJQUFJLENBQUMsT0FBZSxRQUFRLE9BQ2hDLG1CQUFtQixVQUFVLElBQUksS0FBSyxLQUFLLEtBQUs7QUFFbEQsSUFBTSxRQUFRLENBQUMsTUFDYixnRUFBZ0UsQ0FBQztBQUVuRSxJQUFNLE9BQU8sQ0FBQyxNQUNaLHNEQUFzRCxDQUFDO0FBRXpELElBQU0sVUFBVSxDQUFDLFVBQ2YseUVBQXlFLE1BQU0sSUFBSSxDQUFDLE1BQU0sT0FBTyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztBQUVySCxJQUFNLE9BQU8sQ0FBQyxXQUFpRjtBQUM3RixRQUFNLE9BQU8sS0FBSyxJQUFJLEdBQUcsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQztBQUNwRCxRQUFNLE9BQU8sS0FBSyxNQUFNLE9BQU8sT0FBTyxNQUFNLElBQUk7QUFDaEQsUUFBTUEsUUFBTyxPQUNWLElBQUksQ0FBQyxHQUFHLE1BQU07QUFDYixVQUFNLElBQUksS0FBSyxNQUFPLEVBQUUsU0FBUyxPQUFRLEdBQUc7QUFDNUMsVUFBTSxJQUFJLEtBQUssS0FBSyxPQUFPO0FBQzNCLFVBQU0sSUFBSSxNQUFNO0FBQ2hCLFVBQU0sUUFBUSxFQUFFLFNBQVM7QUFDekIsV0FBTyxZQUFZLENBQUMsUUFBUSxDQUFDLFlBQVksSUFBSSxhQUFhLENBQUMsV0FBVyxLQUFLLGVBQWUsSUFBSSxPQUFPLENBQUMscUVBQXFFLEVB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QUk7QUFBQSxFQUMzQixDQUFDO0FBQ0g7QUFFQSxPQUFPLGtCQUFrQjtBQUFBLEVBQ3ZCLE1BQU0sUUFBUSxNQUF3QztBQUNwRCxVQUFNLFNBQVMsU0FBUyxlQUFlLFFBQVE7QUFDL0MsVUFBTSxXQUFXLFNBQVMsZUFBZSxVQUFVO0FBQ25ELFFBQUksT0FBUSxRQUFPLGNBQWMsV0FBVyxLQUFLLE9BQU8sS0FBSyxLQUFLLFdBQVc7QUFFN0UsVUFBTSxVQUFVLGNBQWMsSUFBSTtBQUNsQyxVQUFNLFFBQVEsVUFBVSxDQUFDLE1BQU07QUFDN0IsVUFBSSxPQUFRLFFBQU8sY0FBYyxLQUFLLEVBQUUsV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLO0FBQUEsSUFDakYsQ0FBQztBQUVELFVBQU0sUUFBUSxLQUFLO0FBQ25CLFFBQUksUUFBUTtBQUNWLGFBQU8sY0FBYyxXQUFXLFNBQVMsR0FBRyxrQkFBa0IsS0FBSyxPQUFPO0FBQUEsSUFDNUU7QUFDQSxRQUFJLE9BQU87QUFDWCxVQUFNLFNBQVMsTUFBTSxRQUFRO0FBQUEsTUFDM0I7QUFBQSxNQUNBO0FBQUEsTUFDQSxRQUFRLFFBQVEsTUFBTSxTQUFTLFFBQVE7QUFBQSxNQUN2QyxnQkFBZ0IsQ0FBQyxHQUFHLFNBQVM7QUFDM0IsWUFBSSxDQUFDLFNBQVU7QUFDZixjQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsYUFBSyxZQUFZLEVBQUUsU0FBUyxNQUFNLE9BQU87QUFDekMsYUFBSyxjQUFjLEdBQUcsS0FBSyxHQUFHLE9BQU8sRUFBRSxDQUFDLElBQUksRUFBRSxTQUFTLE1BQU0sU0FBUyxNQUFNLElBQUksRUFBRSxNQUFNO0FBQ3hGLGlCQUFTLFlBQVksSUFBSTtBQUN6QixpQkFBUyxZQUFZLFNBQVM7QUFBQSxNQUNoQztBQUFBLElBQ0YsQ0FBQztBQUVELFFBQUksUUFBUTtBQUNWLGFBQU8sY0FBYyxTQUFTLE9BQU8sUUFBUSxNQUFNLElBQUksT0FBTyxRQUFRLEtBQUssdUJBQXVCLE9BQU8sUUFBUSxVQUFVLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDdkk7QUFDQSxVQUFNLFFBQVEsUUFBUTtBQUN0QixXQUFPO0FBQUEsRUFDVDtBQUNGOyIsCiAgIm5hbWVzIjogWyJiYXJzIiwgInMiLCAicmVuZGVyU2xpZGVUb1BuZyIsICJNT0RFTF9JTkZPIiwgInN1cnJvZ2F0ZVRva2VuaXplIiwgInMiLCAicyJdCn0K
