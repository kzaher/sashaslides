/**
 * Public entry point for the structured-prompting library.
 *
 * Layout:
 *   src/api/    — wire types shared by server and browser client
 *   src/server/ — Node.js engine, HTTP server, Session API, errors, etc.
 *   src/client/ — Preact monitor UI (browser)
 *
 * User code (engine consumers) imports from this entry, which re-exports
 * the server-side surface. The path is unchanged from the pre-split
 * layout (`<library>/src/index.js`) so existing imports keep working.
 */
export * from "./api/wire.js";
export * from "../../cow-workspace/cow-workspace.js";
export * from "./server/graph.js";
export * from "./server/session.js";
export * from "./server/engine.js";
export {
  runScheduler,
  defaultKindRegistry,
  type KindHandler,
  type SchedulerCtx,
} from "./server/scheduler.js";
export * from "./server/errors.js";
export * from "./server/io.js";
export { callClaude, callClaudeFormatted } from "./server/claude-cli.js";
export { runCli, CliCommandError, type RunCliOptions } from "./server/run-cli.js";
