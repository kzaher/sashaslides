/**
 * The forward half of the round trip, exactly as regen-basics.sh / regen-complex.sh run it:
 * `convert-pptx.ts <fixture dir>` builds ONE combined .pptx of every fixture (one slide each, in
 * file-name order) and uploads it once, and the presentation id is read from the address it prints.
 *
 * It runs as a child process because convert-pptx.ts is a script with its own Chrome session and
 * Drive upload, not a library. The child is watched like a watchdog would: killed when it prints
 * nothing for STALL_MILLISECONDS, or when it runs past TOTAL_MILLISECONDS.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export type ForwardUpload = Readonly<{ presentationId: string; logPath: string }>;

const STALL_MILLISECONDS = 180_000;
const TOTAL_MILLISECONDS = 20 * 60_000;

export async function uploadFixturesForward(
  options: Readonly<{ converterDirectory: string; fixtureDirectory: string; title: string; pptxPath: string; logPath: string; log: (line: string) => void }>,
): Promise<ForwardUpload> {
  const log = createWriteStream(options.logPath);
  let printed = "";
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "convert-pptx.ts", options.fixtureDirectory, "--title", options.title, "--out", options.pptxPath], {
      cwd: options.converterDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stallTimer = setTimeout(() => stop("printed nothing for 180 s"), STALL_MILLISECONDS);
    const totalTimer = setTimeout(() => stop("ran past 20 minutes"), TOTAL_MILLISECONDS);
    function stop(reason: string): void {
      options.log(`  convert-pptx ${reason}; stopping it (log: ${options.logPath})`);
      child.kill("SIGTERM");
    }
    const onOutput = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      printed += text;
      log.write(text);
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stop("printed nothing for 180 s"), STALL_MILLISECONDS);
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(stallTimer);
      clearTimeout(totalTimer);
      resolve(code);
    });
  });
  await new Promise<void>((resolve) => log.end(resolve));
  const presentationId = /presentation\/d\/([A-Za-z0-9_-]+)/.exec(printed)?.[1];
  if (exitCode !== 0 || presentationId === undefined) {
    throw new Error(`convert-pptx.ts ${exitCode === 0 ? "printed no presentation address" : `exited with ${exitCode}`}; tail of ${options.logPath}:\n${printed.split("\n").slice(-8).join("\n")}`);
  }
  return { presentationId, logPath: options.logPath };
}
