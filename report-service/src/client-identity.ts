// WHO IS CALLING, for the two purposes that need an answer: which rate-limit bucket to charge, and
// what to write in the log.
//
// THE LOG NEVER GETS AN ADDRESS. It gets `ip:` plus the first 12 hex characters of an HMAC of the
// address under a per-deployment secret. That is enough to say "these forty requests came from one
// place" when reading an abuse incident, and not enough to recover the address from the log file.
// The secret defaults to a value generated at startup, so by default the labels are not even
// correlatable across restarts; set `REPORT_IP_HASH_SECRET` when you want them to be.
//
// IPv6 IS CUT TO A /64. A single residential IPv6 allocation is typically a /64 or shorter, so
// bucketing per full address would let one subscriber rotate through 18 quintillion free buckets.

import { createHmac } from "node:crypto";

export type ClientIdentity = Readonly<{
  /** The rate-limit bucket key. Derived from the address; never logged, never stored. */
  key: string;
  /** The pseudonym written to logs. Stable for as long as the hash secret is. */
  logLabel: string;
}>;

/**
 * `trustedProxyHops` is the number of proxies you operate between the internet and this process.
 * The client's address is then the entry that many positions from the RIGHT of `X-Forwarded-For`,
 * because the rightmost entries are the ones your own infrastructure appended and are the only
 * ones a caller cannot forge. At 0 the header is ignored entirely.
 */
export function clientIdentityOf(options: {
  socketAddress: string | null;
  forwardedFor: string | null;
  trustedProxyHops: number;
  hashSecret: string;
}): ClientIdentity {
  const address = addressFor(options);
  const key = bucketKeyFor(address);
  return { key, logLabel: `ip:${createHmac("sha256", options.hashSecret).update(key).digest("hex").slice(0, 12)}` };
}

function addressFor(
  options: Readonly<{ socketAddress: string | null; forwardedFor: string | null; trustedProxyHops: number }>,
): string {
  if (options.trustedProxyHops <= 0 || options.forwardedFor === null) return options.socketAddress ?? "unknown";
  const hops = options.forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const index = hops.length - options.trustedProxyHops;
  const candidate = index >= 0 && index < hops.length ? hops[index] : undefined;
  // A header short enough that the configured hop is missing means the request did not come
  // through the expected proxy chain; the socket address is the only thing left worth trusting.
  return candidate ?? options.socketAddress ?? "unknown";
}

/** `::ffff:1.2.3.4` and `1.2.3.4` must land in the same bucket, or one client gets two. */
function bucketKeyFor(address: string): string {
  const withoutPort = address.replace(/^\[|\]$/g, "");
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutPort);
  const unmapped = mappedIpv4?.[1] ?? withoutPort;
  if (!unmapped.includes(":")) return unmapped;
  const groups = unmapped.split(":").slice(0, 4);
  return `${groups.join(":")}::/64`;
}
