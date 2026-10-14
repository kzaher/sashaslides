/**
 * The hosted connector address the add-on's Setup tab prints, decided at build time.
 *
 * THE DEFAULT IS PRODUCTION. Until 2026-10-14 an unset SASHA_CONNECTOR_URL meant "not configured",
 * and every build that forgot the variable shipped a sidebar with no address to give Claude and no
 * walkthrough video. Now unset means https://sashaslides.com/mcp; a staging build passes its own
 * https address, and only the literal "none" builds the unconfigured panel. Claude will not connect
 * a remote connector over plain HTTP (CONNECT.md section B), so anything but an https URL fails the
 * build instead of shipping an address that cannot work.
 */
export const PRODUCTION_CONNECTOR_URL = "https://sashaslides.com/mcp";

export function connectorUrlOf(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return PRODUCTION_CONNECTOR_URL;
  if (trimmed === "none") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`SASHA_CONNECTOR_URL is not a URL: ${trimmed}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`SASHA_CONNECTOR_URL must be https: ${trimmed}`);
  return parsed.href;
}
