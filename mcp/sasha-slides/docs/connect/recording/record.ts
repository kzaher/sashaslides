// Records a captioned, redacted walkthrough of connecting Sasha Slides to claude.ai or ChatGPT.
//
//   npx tsx mcp/sasha-slides/docs/connect/recording/record.ts start  <flow>          # begin screen capture of DISPLAY
//   npx tsx mcp/sasha-slides/docs/connect/recording/record.ts step   <flow> <n>      # caption step n of <flow>.steps.txt, now
//   npx tsx mcp/sasha-slides/docs/connect/recording/record.ts finish <flow> --url <connector> --redact <word,word,...>
//   npx tsx mcp/sasha-slides/docs/connect/recording/record.ts reredact <flow> --url <connector> --redact <...>
//                                                                   # re-run redaction on the redacted video
//   npx tsx mcp/sasha-slides/docs/connect/recording/record.ts recaption <flow> --url <connector>  # after editing a mistaken
//                                                                   # line out of recordings/.<flow>/steps.log
//
// <flow> is `claude-ai` or `chatgpt`. You perform each step in the browser yourself (or drive it over CDP) and call
// `step` just before doing it. `finish` stops the capture, builds captions and a timed step table, removes personal
// details, and writes recordings/<flow>.mp4 plus recordings/<flow>-steps.md.
//
// The videos are NEVER committed: recordings/ is git-ignored. They show a real account, so `finish` always redacts:
//   - the left 296 px from y=400 down (chat history in claude.ai and ChatGPT) and the bottom-left account badge,
//     for the whole video;
//   - every word OCR finds matching --redact (your email, name, username), 2 s either side of each sighting, because
//     1 frame-per-second OCR misses fade-ins;
//   - ChatGPT's personalised suggestions under its "Ask ChatGPT" home box (and under the "How can I help,
//     <name>?" greeting);
//   - the name in claude.ai's "Good evening, <name>" greeting.
// It then re-runs OCR on the result and refuses to finish if any --redact word is still readable.
//
// Needs ffmpeg and tesseract on PATH (`sudo apt-get install -y ffmpeg tesseract-ocr`); `start` checks.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "recordings");
const FLOWS = ["claude-ai", "chatgpt"] as const;
type Flow = (typeof FLOWS)[number];
type Box = Readonly<{ x: number; y: number; w: number; h: number }>;

const SIDEBAR: Box = { x: 0, y: 400, w: 296, h: 440 };
const BADGE: Box = { x: 0, y: 836, w: 200, h: 62 };
const SUGGESTIONS: Box = { x: 560, y: 500, w: 840, h: 170 };
const HOME_GREETING = /\bHow\b.{0,20}\bhelp,/;
// claude.ai greets by name ("Good evening, K"): the word after the time of day is the name.
const TIME_OF_DAY = /^(morning|afternoon|evening|night),?$/i;
const FRAME = { w: 1600, h: 900 };

const work = (flow: Flow): string => join(OUT, `.${flow}`);
const fail = (message: string): never => {
  process.stderr.write(`record: ${message}\n`);
  process.exit(1);
};

function parseFlow(value: string | undefined): Flow {
  const flow = FLOWS.find((f) => f === value);
  return flow ?? fail(`flow must be one of ${FLOWS.join(", ")}`);
}

function option(args: readonly string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

function requireTools(): void {
  for (const tool of ["ffmpeg", "tesseract"]) {
    try {
      execFileSync("which", [tool], { stdio: "ignore" });
    } catch {
      fail(`${tool} is missing. Install with: sudo apt-get install -y ffmpeg tesseract-ocr`);
    }
  }
}

/** The narration script: one step per non-comment line, step 0 is the START line. */
function steps(flow: Flow): string[] {
  return readFileSync(join(HERE, `${flow}.steps.txt`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

function start(flow: Flow): void {
  requireTools();
  const dir = work(flow);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const display = process.env.DISPLAY ?? ":99";
  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "12", "-video_size", `${FRAME.w}x${FRAME.h}`, "-i", display,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(dir, "raw.mp4")],
    { detached: true, stdio: "ignore" },
  );
  ffmpeg.unref();
  writeFileSync(join(dir, "ffmpeg.pid"), String(ffmpeg.pid));
  writeFileSync(join(dir, "started.ms"), String(Date.now()));
  console.log(`recording ${display} into ${dir}/raw.mp4 (pid ${String(ffmpeg.pid)}). Caption each step with: record.ts step ${flow} <n>`);
}

function step(flow: Flow, n: number): void {
  const all = steps(flow);
  if (!Number.isInteger(n) || n < 0 || n >= all.length) fail(`step must be 0..${String(all.length - 1)}`);
  appendFileSync(join(work(flow), "steps.log"), `${String(Date.now())} ${String(n)}\n`);
  console.log(`step ${String(n)}: ${all[n]}`);
}

function timestamp(ms: number, separator: "," | "."): string {
  const clamped = Math.max(0, Math.round(ms));
  const pad = (v: number, width = 2): string => String(v).padStart(width, "0");
  return `${pad(Math.floor(clamped / 3_600_000))}:${pad(Math.floor(clamped / 60_000) % 60)}:${pad(Math.floor(clamped / 1000) % 60)}${separator}${pad(clamped % 1000, 3)}`;
}

/** Captions (SRT) and the published step table, from the step log and the narration script. */
function captions(flow: Flow, url: string): void {
  const dir = work(flow);
  const startedMs = Number(readFileSync(join(dir, "started.ms"), "utf8"));
  const script = steps(flow);
  const logged = readFileSync(join(dir, "steps.log"), "utf8").trim().split("\n").map((line) => {
    const [ms, n] = line.split(" ").map(Number);
    return { at: ms - startedMs, text: script[n].replaceAll("{URL}", url) };
  });
  const srt = logged.map((entry, i) => {
    const end = i + 1 < logged.length ? logged[i + 1].at : entry.at + 8000;
    return `${String(i + 1)}\n${timestamp(entry.at, ",")} --> ${timestamp(end, ",")}\n${entry.text}\n`;
  });
  writeFileSync(join(dir, "steps.srt"), srt.join("\n"));
  const table = logged.map((entry) => `| ${timestamp(entry.at, ".").slice(3, 8)} | ${entry.text.replaceAll("|", "/")} |`);
  writeFileSync(join(OUT, `${flow}-steps.md`), `| Time | Step |\n| --- | --- |\n${table.join("\n")}\n`);
}

type Word = Readonly<{ text: string; box: Box }>;

/** OCR one frame per second of `video` into `<dir>/NNNN.png.tsv`; returns the words per second. */
function ocr(video: string, dir: string): Map<number, Word[]> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", video, "-vf", "fps=1", join(dir, "%04d.png")]);
  const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  execFileSync("sh", ["-c", `ls ${dir}/*.png | xargs -P 8 -I{} sh -c 'OMP_THREAD_LIMIT=1 tesseract {} {} --psm 11 tsv >/dev/null 2>&1'`]);
  const bySecond = new Map<number, Word[]>();
  for (const frame of frames) {
    const rows = readFileSync(join(dir, `${frame}.tsv`), "utf8").split("\n").slice(1).map((row) => row.split("\t"));
    bySecond.set(
      Number(frame.slice(0, 4)) - 1,
      rows.filter((r) => r.length >= 12 && r[11].trim() !== "").map((r) => ({
        text: r[11].trim(),
        box: { x: Number(r[6]), y: Number(r[7]), w: Number(r[8]), h: Number(r[9]) },
      })),
    );
  }
  return bySecond;
}

const matches = (text: string, redact: readonly RegExp[]): boolean => redact.some((pattern) => pattern.test(text));

/** One delogo per box and time span: the area is filled from its border, so the text is gone, not softened. */
function redactionFilter(bySecond: Map<number, Word[]>, redact: readonly RegExp[], duration: number): string {
  const seen = new Map<string, number[]>();
  const note = (box: Box, second: number): void => {
    const snap = (v: number): number => Math.floor(v / 16) * 16;
    const key = [snap(box.x), snap(box.y), Math.ceil((box.x + box.w) / 16) * 16, Math.ceil((box.y + box.h) / 16) * 16].join(",");
    seen.set(key, [...(seen.get(key) ?? []), second]);
  };
  for (const [second, words] of bySecond) {
    for (const word of words.filter((w) => matches(w.text, redact))) {
      note({ x: word.box.x - 12, y: word.box.y - 8, w: word.box.w + 24, h: word.box.h + 16 }, second);
    }
    if (HOME_GREETING.test(words.map((w) => w.text).join(" "))) note(SUGGESTIONS, second);
    // ChatGPT's home suggestions sit just under the "Ask ChatGPT" box, whatever the greeting says.
    words.forEach((word, i) => {
      const next = words[i + 1];
      if (word.text === "Ask" && next !== undefined && /^ChatGPT/.test(next.text)) {
        note({ x: word.box.x - 60, y: word.box.y + 20, w: 900, h: 150 }, second);
      }
    });
    words.forEach((word, i) => {
      const name = words[i + 1];
      if (TIME_OF_DAY.test(word.text) && name !== undefined) note({ x: name.box.x - 12, y: name.box.y - 10, w: name.box.w + 60, h: name.box.h + 20 }, second);
    });
  }
  const spans: string[] = [];
  const delogo = (box: Box, from: number, to: number): string => {
    const x = Math.max(1, box.x), y = Math.max(1, box.y);
    const w = Math.min(box.w, FRAME.w - 2 - x), h = Math.min(box.h, FRAME.h - 2 - y);
    return `delogo=x=${String(x)}:y=${String(y)}:w=${String(w)}:h=${String(h)}:enable='between(t,${String(from)},${String(to)})'`;
  };
  spans.push(delogo(SIDEBAR, 0, duration), delogo(BADGE, 0, duration));
  for (const [key, seconds] of seen) {
    const [x0, y0, x1, y1] = key.split(",").map(Number);
    const box = { x: Math.max(0, x0), y: Math.max(0, y0), w: x1 - Math.max(0, x0), h: y1 - Math.max(0, y0) };
    const sorted = [...new Set(seconds)].sort((a, b) => a - b);
    let from = sorted[0], last = sorted[0];
    for (const s of [...sorted.slice(1), Number.POSITIVE_INFINITY]) {
      if (s <= last + 2) { last = s; continue; }
      spans.push(delogo(box, Math.max(0, from - 2), last + 2.99));
      from = s; last = s;
    }
  }
  return `[0:v]${spans.join(",\n")}[clean]`;
}

/** Captions go on AFTER redaction so the wipes never cut into them; finish then checks the caption text too. */
function burnCaptions(flow: Flow): string {
  const dir = work(flow);
  const out = join(OUT, `${flow}.mp4`);
  const style = "FontSize=9,Alignment=2,BorderStyle=3,Outline=1,Shadow=0,BackColour=&H90000000,MarginV=8";
  execFileSync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-i", join(dir, "clean.mp4"), "-vf", `subtitles=${join(dir, "steps.srt")}:force_style='${style}'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
  ]);
  return out;
}

/** After fixing recordings/.<flow>/steps.log by hand (a mistaken step): rebuild captions on the redacted video. */
function recaption(flow: Flow, url: string): void {
  captions(flow, url);
  console.log(`wrote ${burnCaptions(flow)} with the corrected captions`);
}

/** Re-runs redaction (with today's rules) on the already-redacted video, e.g. after a rule was added. */
function reredact(flow: Flow, url: string, redact: readonly RegExp[]): void {
  requireTools();
  const dir = work(flow);
  execFileSync("cp", [join(dir, "clean.mp4"), join(dir, "raw.mp4")]);
  writeFileSync(join(dir, "ffmpeg.pid"), "0");
  finish(flow, url, redact);
}

function finish(flow: Flow, url: string, redact: readonly RegExp[]): void {
  requireTools();
  const dir = work(flow);
  const pid = Number(readFileSync(join(dir, "ffmpeg.pid"), "utf8"));
  if (pid > 0) {
    try {
      process.kill(pid, "SIGINT"); // lets ffmpeg write the mp4 index
    } catch {
      // already stopped
    }
    execFileSync("sh", ["-c", `for i in $(seq 50); do kill -0 ${String(pid)} 2>/dev/null || exit 0; sleep 0.1; done; exit 1`]);
  }
  captions(flow, url);
  const raw = join(dir, "raw.mp4");
  const bySecond = ocr(raw, join(dir, "ocr"));
  writeFileSync(join(dir, "redact.filter"), redactionFilter(bySecond, redact, bySecond.size));
  execFileSync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-i", raw, "-/filter_complex", join(dir, "redact.filter"),
    "-map", "[clean]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", join(dir, "clean.mp4"),
  ]);
  const out = burnCaptions(flow);
  const leftover = [...ocr(out, join(dir, "check")).entries()].flatMap(([s, words]) =>
    words.filter((w) => matches(w.text, redact)).map((w) => `${String(s)}s "${w.text}"`));
  if (leftover.length > 0) {
    rmSync(out, { force: true });
    fail(`still readable after redaction, video deleted: ${leftover.slice(0, 10).join(", ")}`);
  }
  rmSync(join(dir, "ocr"), { recursive: true, force: true });
  rmSync(join(dir, "check"), { recursive: true, force: true });
  rmSync(raw, { force: true }); // the unredacted capture never outlives a successful finish
  console.log(`wrote ${out} and ${join(OUT, `${flow}-steps.md`)}; OCR finds none of the redacted words`);
}

function main(args: readonly string[]): void {
  const [command, flowName, third] = args;
  const flow = parseFlow(flowName);
  if (command === "start") return start(flow);
  if (command === "step") return step(flow, Number(third));
  if (command === "recaption") return recaption(flow, option(args, "--url") ?? fail("recaption needs --url <connector address>"));
  if (command === "finish" || command === "reredact") {
    const url = option(args, "--url") ?? fail("finish needs --url <connector address>");
    const words = (option(args, "--redact") ?? fail("finish needs --redact <email,name,username,...>")).split(",").filter(Boolean);
    const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Each word, plus its run-together form (OCR often drops the dot in "first.last").
    const patterns = words.flatMap((w) => [new RegExp(escape(w), "i"), new RegExp(escape(w.replace(/[.@_-]/g, "")), "i")]);
    return command === "finish" ? finish(flow, url, patterns) : reredact(flow, url, patterns);
  }
  fail("usage: record.ts start|step|finish <claude-ai|chatgpt> …  (see the header of this file)");
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
main(process.argv.slice(2));
