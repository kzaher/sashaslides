/**
 * push-slides.ts
 *
 * Reads slides.md, parses it into individual slides, and pushes them
 * to a Google Slides presentation via Chrome DevTools Protocol.
 *
 * Uses the logged-in Chrome session to make authenticated Slides API calls.
 *
 * Usage: npx tsx presentations/scripts/push-slides.ts <slides.md> <presentation-url>
 */

import { readFileSync } from "node:fs";
import CDP from "chrome-remote-interface";

// ── Types ──────────────────────────────────────────────────────────────────

type ParsedSlide = Readonly<{
  title: string;
  body: string[];
  isSectionHeader: boolean;
  isTitle: boolean;
  speakerNotes: string;
  table: Readonly<{ headers: string[]; rows: string[][] }> | null;
}>;

// ── Markdown Parsing ───────────────────────────────────────────────────────

function parseSlidesMd(markdown: string): ParsedSlide[] {
  const raw = markdown.split(/\n---\n/);
  const slides: ParsedSlide[] = [];

  for (const block of raw) {
    const lines = block.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    let title = "";
    const body: string[] = [];
    const notes: string[] = [];
    let isSectionHeader = false;
    let isTitle = false;
    let table: ParsedSlide["table"] = null;

    // Detect if this is a section header (# PART N followed by # Title)
    const headings = lines.filter((l) => /^#{1,2}\s/.test(l));

    for (const line of lines) {
      // Speaker notes
      if (line.startsWith(">")) {
        notes.push(line.replace(/^>\s*/, ""));
        continue;
      }

      // Table detection
      if (line.includes("|") && !line.startsWith("#")) {
        if (!table) {
          const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
          // Check if next line is separator
          const lineIdx = lines.indexOf(line);
          const nextLine = lines[lineIdx + 1];
          if (nextLine && /^[\s|:-]+$/.test(nextLine)) {
            table = { headers: cells, rows: [] };
            continue;
          } else if (table) {
            table = { ...table, rows: [...table.rows, cells] };
            continue;
          }
        } else if (/^[\s|:-]+$/.test(line)) {
          continue; // separator
        } else {
          const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
          table = { ...table, rows: [...table.rows, cells] };
          continue;
        }
      }

      // Headings
      if (line.startsWith("# ") && !line.startsWith("## ")) {
        const text = line.replace(/^#\s+/, "").replace(/\*\*/g, "");
        if (text.startsWith("PART ")) {
          isSectionHeader = true;
          continue;
        }
        title = text;
        if (headings.length === 1 && lines.length <= 3) isTitle = true;
        if (isSectionHeader) isTitle = false;
        continue;
      }
      if (line.startsWith("## ")) {
        title = line.replace(/^##\s+/, "").replace(/\*\*/g, "");
        continue;
      }

      // Body lines — clean up markdown formatting
      const cleaned = line
        .replace(/^\*\*(.+?)\*\*$/, "$1")  // bold-only lines → plain
        .replace(/\*\*/g, "")              // remaining bold markers
        .replace(/^- /, "• ");             // bullets
      body.push(cleaned);
    }

    slides.push({
      title,
      body,
      isSectionHeader: isSectionHeader && title !== "",
      isTitle,
      speakerNotes: notes.join("\n"),
      table,
    });
  }

  return slides;
}

// ── Google Slides API via Chrome ───────────────────────────────────────────

function extractPresentationId(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`Bad presentation URL: ${url}`);
  return match[1];
}

/**
 * Get the SAPISID cookie and generate a SAPISIDHASH authorization header.
 * This is how Google cross-origin API calls are authenticated from logged-in sessions.
 * Hash = SHA-1(timestamp + " " + SAPISID + " " + origin)
 */
async function getSapisidHash(client: CDP.Client, origin: string): Promise<string> {
  const { Network } = client;
  await Network.enable();
  const { cookies } = await Network.getCookies({
    urls: ["https://docs.google.com"],
  });
  const sapisid = cookies.find((c) => c.name === "SAPISID")?.value;
  const sid3p = cookies.find((c) => c.name === "__Secure-3PAPISID")?.value;
  const token = sapisid || sid3p;
  if (!token) throw new Error("No SAPISID cookie found — are you logged in?");

  const { Runtime } = client;
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${token} ${origin}`;

  const hashResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const encoder = new TextEncoder();
        const data = encoder.encode(${JSON.stringify(input)});
        const hashBuffer = await crypto.subtle.digest('SHA-1', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  });

  const hash = hashResult.result.value as string;
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

async function slidesApiFetch(
  client: CDP.Client,
  presentationId: string,
  path: string,
  method: string,
  body?: unknown
): Promise<unknown> {
  const origin = "https://docs.google.com";
  const authHeader = await getSapisidHash(client, origin);
  const url = `https://slides.googleapis.com/v1/presentations/${presentationId}${path}`;

  const fetchCode = `
    (async () => {
      const resp = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: {
          "Content-Type": "application/json",
          "Authorization": ${JSON.stringify(authHeader)},
          "X-Goog-AuthUser": "0",
          "Origin": ${JSON.stringify(origin)},
        },
        credentials: "include",
        ${body ? `body: JSON.stringify(${JSON.stringify(body)}),` : ""}
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error("Slides API " + resp.status + ": " + text);
      }
      return await resp.json();
    })()
  `;

  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: fetchCode,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(
      `Slides API call failed: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`
    );
  }
  return result.result.value;
}

// ── Build Slides API Requests ──────────────────────────────────────────────

type SlidesRequest = Record<string, unknown>;

function buildCreateSlideRequest(slideIndex: number, parsed: ParsedSlide): SlidesRequest[] {
  const requests: SlidesRequest[] = [];
  const slideId = `slide_${slideIndex}`;
  const titleId = `title_${slideIndex}`;
  const bodyId = `body_${slideIndex}`;

  // Pick layout
  let layout: string;
  if (parsed.isSectionHeader) {
    layout = "SECTION_HEADER";
  } else if (parsed.isTitle) {
    layout = "TITLE";
  } else if (parsed.table && parsed.body.length === 0) {
    layout = "TITLE_ONLY";
  } else if (parsed.body.length > 0 || parsed.table) {
    layout = "TITLE_AND_BODY";
  } else {
    layout = "TITLE_ONLY";
  }

  requests.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: slideIndex,
      slideLayoutReference: { predefinedLayout: layout },
      placeholderIdMappings: [
        {
          layoutPlaceholder: { type: "TITLE", index: 0 },
          objectId: titleId,
        },
        ...(layout === "TITLE_AND_BODY" || layout === "SECTION_HEADER"
          ? [
              {
                layoutPlaceholder: { type: "BODY", index: 0 },
                objectId: bodyId,
              },
            ]
          : []),
        ...(layout === "TITLE"
          ? [
              {
                layoutPlaceholder: { type: "SUBTITLE", index: 0 },
                objectId: bodyId,
              },
            ]
          : []),
      ],
    },
  });

  // Insert title text
  if (parsed.title) {
    requests.push({
      insertText: {
        objectId: titleId,
        text: parsed.title,
        insertionIndex: 0,
      },
    });
  }

  // Build body text
  const bodyParts: string[] = [];
  for (const line of parsed.body) {
    bodyParts.push(line);
  }

  // Add table as text (Google Slides tables via API are complex — use formatted text for now)
  if (parsed.table) {
    if (bodyParts.length > 0) bodyParts.push("");
    bodyParts.push(parsed.table.headers.join("  |  "));
    for (const row of parsed.table.rows) {
      bodyParts.push(row.join("  |  "));
    }
  }

  const bodyText = bodyParts.join("\n");
  if (bodyText && (layout === "TITLE_AND_BODY" || layout === "SECTION_HEADER" || layout === "TITLE")) {
    requests.push({
      insertText: {
        objectId: bodyId,
        text: bodyText,
        insertionIndex: 0,
      },
    });
  }

  // Speaker notes
  if (parsed.speakerNotes) {
    requests.push({
      insertText: {
        objectId: `${slideId}_notes`,
        text: parsed.speakerNotes,
        insertionIndex: 0,
      },
    });
  }

  return requests;
}

function buildDeleteAllSlidesRequests(existingSlideIds: string[]): SlidesRequest[] {
  // Keep the first slide (can't delete all), delete rest, then we'll overwrite the first
  return existingSlideIds.slice(1).map((id) => ({
    deleteObject: { objectId: id },
  }));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx push-slides.ts <slides.md> <presentation-url>");
    process.exit(1);
  }

  const [slidesPath, presentationUrl] = args;
  const presentationId = extractPresentationId(presentationUrl);

  console.log(`Reading ${slidesPath}...`);
  const markdown = readFileSync(slidesPath, "utf-8");
  const parsedSlides = parseSlidesMd(markdown);
  console.log(`Parsed ${parsedSlides.length} slides`);

  for (let i = 0; i < parsedSlides.length; i++) {
    const s = parsedSlides[i];
    console.log(`  [${i}] ${s.isSectionHeader ? "SECTION: " : ""}${s.title || "(no title)"} — ${s.body.length} lines${s.table ? " + table" : ""}`);
  }

  console.log(`\nConnecting to Chrome on port 9222...`);
  const targets = await CDP.List({ port: 9222 });
  // Find a Google Slides tab, or use the first tab
  const slidesTab = targets.find((t: { url: string }) =>
    t.url.includes("docs.google.com/presentation")
  ) || targets[0];

  if (!slidesTab) {
    console.error("No Chrome tabs found. Is Chrome running?");
    process.exit(1);
  }

  console.log(`Using tab: ${slidesTab.url}`);
  const client = await CDP({ target: slidesTab });
  const { Runtime } = client;

  // First, read the current presentation to get existing slide IDs
  console.log(`\nReading presentation ${presentationId}...`);
  const presentation = (await slidesApiFetch(
    client,
    presentationId,
    "",
    "GET"
  )) as { slides?: { objectId: string }[]; title?: string };

  console.log(`Title: "${presentation.title}"`);
  const existingIds = (presentation.slides ?? []).map((s) => s.objectId);
  console.log(`Existing slides: ${existingIds.length}`);

  // Build all requests
  const allRequests: SlidesRequest[] = [];

  // Delete existing slides (except first — API requires at least 1)
  if (existingIds.length > 1) {
    allRequests.push(...buildDeleteAllSlidesRequests(existingIds));
  }

  // Create new slides (starting at index 1, we'll delete the original slide 0 after)
  for (let i = 0; i < parsedSlides.length; i++) {
    allRequests.push(...buildCreateSlideRequest(i + 1, parsedSlides[i]));
  }

  // Delete the original first slide (now we have new slides to keep)
  if (existingIds.length > 0) {
    allRequests.push({
      deleteObject: { objectId: existingIds[0] },
    });
  }

  console.log(`\nSending ${allRequests.length} API requests...`);

  // Filter out speaker notes requests (need special handling — notes page IDs differ)
  const mainRequests = allRequests.filter(
    (r) => !(r.insertText && (r.insertText as { objectId: string }).objectId.endsWith("_notes"))
  );

  try {
    await slidesApiFetch(client, presentationId, ":batchUpdate", "POST", {
      requests: mainRequests,
    });
    console.log("Presentation updated successfully!");
  } catch (err) {
    console.error("Failed to update presentation:", err);
    // Try sending in smaller batches
    console.log("\nRetrying in smaller batches...");
    const batchSize = 20;
    for (let i = 0; i < mainRequests.length; i += batchSize) {
      const batch = mainRequests.slice(i, i + batchSize);
      console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} requests`);
      try {
        await slidesApiFetch(client, presentationId, ":batchUpdate", "POST", {
          requests: batch,
        });
      } catch (batchErr) {
        console.error(`  Batch failed:`, batchErr);
      }
    }
  }

  await client.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
