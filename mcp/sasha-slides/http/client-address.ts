/**
 * Which network address a request came from, for rate limiting.
 *
 * In production the connector sits behind nginx on the same host, so every TCP connection
 * it sees comes from the proxy, and the browser's address arrives in `X-Real-IP` (set to
 * nginx's `$remote_addr`) and as the last `X-Forwarded-For` hop (`$proxy_add_x_forwarded_for`
 * appends `$remote_addr`).
 *
 * Attack and defence:
 *
 *  - **Header spoofing to dodge a per-client limit.** Anyone can send `X-Real-IP: <random>`.
 *    The headers are believed ONLY when the socket's own peer is a trusted proxy (loopback by
 *    default, plus `--trusted-proxy` subnets); from anyone else they are ignored and the
 *    socket address is the client. Of `X-Forwarded-For` only the LAST hop is read: earlier
 *    hops are whatever the client sent, and only the last was written by our proxy.
 *
 * Docker note: with a published port (`127.0.0.1:6100:8787`) Docker's userland proxy, not
 * nginx, opens the connection the container sees, from the bridge gateway (172.16.0.0/12),
 * so loopback alone would treat every visitor as one client. `--trusted-proxy` names that
 * subnet; `ignoredForwardedHeader` lets the caller warn when a proxy header arrives from an
 * untrusted peer, which is the symptom of exactly that misconfiguration.
 */
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";

export type TrustedProxies = Readonly<{
  trusts(address: string): boolean;
  /** For the startup banner. */
  description: string;
}>;

export type ClientAddress = Readonly<{
  address: string;
  /** True when a proxy header was present but its sender is not trusted, so it was ignored. */
  ignoredForwardedHeader: boolean;
}>;

export function clientAddress(
  options: Readonly<{
    request: Readonly<{ socket: Readonly<{ remoteAddress?: string | undefined }>; headers: IncomingHttpHeaders }>;
    trustedProxies: TrustedProxies;
  }>,
): ClientAddress {
  const { request, trustedProxies } = options;
  const realIp = singleHeader(request.headers["x-real-ip"]);
  const forwardedFor = singleHeader(request.headers["x-forwarded-for"]);
  const hasProxyHeader = realIp !== null || forwardedFor !== null;
  const remote = request.socket.remoteAddress;
  if (remote === undefined) return { address: "unknown", ignoredForwardedHeader: hasProxyHeader };
  const peer = unmapIpv4(remote);
  if (!trustedProxies.trusts(peer)) return { address: peer, ignoredForwardedHeader: hasProxyHeader };
  const fromRealIp = realIp === null ? null : validAddress(realIp);
  if (fromRealIp !== null) return { address: fromRealIp, ignoredForwardedHeader: false };
  const lastHop = forwardedFor === null ? null : validAddress(forwardedFor.split(",").at(-1) ?? "");
  return { address: lastHop ?? peer, ignoredForwardedHeader: false };
}

/** 127.0.0.0/8 and ::1. */
export const LOOPBACK_PROXIES: TrustedProxies = blockListProxies({ subnets: [], description: "loopback" });

/** Trusts nobody: every request is keyed by its socket. For tests of the spoofing defence. */
export const NO_TRUSTED_PROXIES: TrustedProxies = { trusts: () => false, description: "none" };

export type TrustedProxiesParse =
  | Readonly<{ kind: "ok"; proxies: TrustedProxies }>
  | Readonly<{ kind: "error"; message: string }>;

/** `--trusted-proxy`: comma-separated addresses or CIDR subnets, trusted in addition to loopback. */
export function parseTrustedProxies(options: Readonly<{ text: string }>): TrustedProxiesParse {
  const subnets: Subnet[] = [];
  const entries = options.text.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const subnet = parseSubnet(entry);
    if (subnet === null) {
      return { kind: "error", message: `--trusted-proxy: ${JSON.stringify(entry)} is not an IP address or CIDR subnet (e.g. 172.16.0.0/12)` };
    }
    subnets.push(subnet);
  }
  return { kind: "ok", proxies: blockListProxies({ subnets, description: `loopback, ${entries.join(", ")}` }) };
}

type Subnet = Readonly<{ network: string; prefix: number; family: "ipv4" | "ipv6" }>;

function blockListProxies(options: Readonly<{ subnets: readonly Subnet[]; description: string }>): TrustedProxies {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  for (const subnet of options.subnets) list.addSubnet(subnet.network, subnet.prefix, subnet.family);
  return {
    trusts: (address) => {
      const family = familyOf(address);
      return family !== null && list.check(address, family);
    },
    description: options.description,
  };
}

function parseSubnet(entry: string): Subnet | null {
  const [network = "", prefixText, extra] = entry.split("/");
  if (extra !== undefined) return null;
  const family = familyOf(network);
  if (family === null) return null;
  const maxPrefix = family === "ipv4" ? 32 : 128;
  if (prefixText === undefined) return { network, prefix: maxPrefix, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= maxPrefix ? { network, prefix, family } : null;
}

function familyOf(address: string): "ipv4" | "ipv6" | null {
  switch (isIP(address)) {
    case 4:
      return "ipv4";
    case 6:
      return "ipv6";
    default:
      return null;
  }
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : (value.at(-1) ?? null);
}

function validAddress(text: string): string | null {
  const candidate = unmapIpv4(text.trim());
  return familyOf(candidate) === null ? null : candidate;
}

/** `::ffff:203.0.113.9` → `203.0.113.9`, so one client has one key whichever stack it arrived on. */
function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}
