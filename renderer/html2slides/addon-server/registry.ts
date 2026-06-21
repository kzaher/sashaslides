/**
 * API handler registry — separated from server.ts so feature modules can register
 * routes without importing the server module (which would be a circular import
 * and deadlocks under top-level await).
 */
import type { IncomingMessage, ServerResponse } from "http";

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: () => Promise<Buffer>,
) => Promise<boolean> | boolean;

export const apiHandlers: Array<{ method: string; path: string; fn: Handler }> = [];

export function registerApi(method: string, path: string, fn: Handler) {
  apiHandlers.push({ method: method.toUpperCase(), path, fn });
}
