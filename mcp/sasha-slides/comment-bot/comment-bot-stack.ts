/**
 * Wires the comment bot for `server.ts --http`: reads `--comment-bot <file>`, builds the
 * bot's Drive over the real `fetch`, and hands back the banner lines. Without the flag (or
 * with an empty placeholder file, as the deploy bind-mounts every secret by name) the bot is
 * off and says so, like email sign-in.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { emailHint } from "../http/account-directory";
import { DRIVE_HOOK_PATH } from "../http/http-server";
import { BOT_DRIVE_TIMEOUT_MS, googleBotDrive, parseCommentBotConfig } from "./bot-drive";
import { createCommentBot, WATCH_LIFETIME_MS, type CommentBot, type CommentBotStore } from "./comment-bot";

export type CommentBotLoad =
  | Readonly<{ kind: "ok"; bot: CommentBot; banner: readonly string[] }>
  | Readonly<{ kind: "off"; banner: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string }>;

export function loadCommentBot(
  options: Readonly<{ path: string | null; publicUrl: string; store: CommentBotStore; warn: (message: string) => void }>,
): CommentBotLoad {
  const { path, warn } = options;
  if (path === null) return { kind: "off", banner: ["comment bot: off (give --comment-bot <file> to offer watch_comments)"] };
  let text: string;
  try {
    if (statSync(path).size === 0) return { kind: "off", banner: [`comment bot: off (${path} is empty)`] };
    text = readFileSync(path, "utf-8");
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "unreadable";
    return { kind: "failed", message: `--comment-bot: cannot read the file (${code})` };
  }
  const parsed = parseCommentBotConfig(text);
  if (parsed.kind === "error") return { kind: "failed", message: `--comment-bot: ${parsed.message}` };
  const now = (): Date => new Date();
  const webhookUrl = `${options.publicUrl.replace(/\/+$/, "")}${DRIVE_HOOK_PATH}`;
  const bot = createCommentBot({
    drive: googleBotDrive({ config: parsed.config, fetch, now, timeoutMs: BOT_DRIVE_TIMEOUT_MS }),
    store: options.store,
    address: parsed.config.address,
    replyPrefix: parsed.config.replyPrefix,
    webhookUrl,
    now,
    setTimer: ({ delayMs, run }) => {
      const timer = setTimeout(run, delayMs);
      // A pending sweep must not keep a shutting-down process alive.
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
    randomToken: () => randomBytes(24).toString("base64url"),
    warn,
  });
  return {
    kind: "ok",
    bot,
    banner: [
      `comment bot: on, as ${emailHint(parsed.config.address)}; Drive pushes to ${webhookUrl}`,
      `comment bot: watches last ${String(WATCH_LIFETIME_MS / 3_600_000)} h unless renewed; no watch, no Drive channel and no calls`,
    ],
  };
}
