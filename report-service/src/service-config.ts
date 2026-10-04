// CONFIGURATION, read from the environment exactly once, at the edge.
//
// Every setting has a default that is safe to run with: the service starts with no environment at
// all and listens on 127.0.0.1 with conservative caps. There is no "if unset, behave differently"
// branch anywhere below -- an absent variable produces a value, so there is one code path.
//
// A BAD VALUE IS A STARTUP FAILURE, not a silent fallback. `REPORT_MAX_TOTAL_BYTES=1e9` quietly
// parsed as NaN and then compared with `>` would disable the disk cap, which is the kind of
// mis-set variable that is only discovered when the volume is full.

/** Resolved, validated, immutable. Nothing below the composition root reads `process.env`. */
export type ServiceConfig = Readonly<{
  host: string;
  port: number;
  dataDir: string;
  maxBodyBytes: number;
  rateLimit: Readonly<{
    burstCapacity: number;
    burstRefillPerSecond: number;
    sustainedCapacity: number;
    sustainedRefillPerSecond: number;
    maxTrackedClients: number;
  }>;
  storage: Readonly<{
    maxReports: number;
    maxTotalBytes: number;
    retentionDays: number;
    sweepIntervalSeconds: number;
  }>;
  cors: Readonly<{ allowedHostPatterns: readonly string[]; allowedOrigins: readonly string[] }>;
  trustedProxyHops: number;
  ipHashSecret: string;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConnections: number;
  shutdownGraceMs: number;
}>;

export type ParsedServiceConfig =
  | Readonly<{ kind: "ok"; config: ServiceConfig }>
  | Readonly<{ kind: "invalid"; problems: readonly string[] }>;

/**
 * `defaultIpHashSecret` is injected rather than generated here so that the composition root owns
 * the entropy, and so a test can pin it. In production it is a fresh random value per process,
 * which means log labels are not correlatable across restarts unless `REPORT_IP_HASH_SECRET` is
 * set deliberately.
 */
export function parseServiceConfig(options: {
  env: Readonly<Record<string, string | undefined>>;
  defaultIpHashSecret: string;
}): ParsedServiceConfig {
  const problems: string[] = [];
  const read = numberReader({ env: options.env, problems });

  const config: ServiceConfig = {
    host: options.env["REPORT_HOST"] ?? "127.0.0.1",
    port: read({ name: "REPORT_PORT", fallback: 8787, min: 0, max: 65535 }),
    dataDir: options.env["REPORT_DATA_DIR"] ?? "./data",
    maxBodyBytes: read({ name: "REPORT_MAX_BODY_BYTES", fallback: 2 * 1024 * 1024, min: 1024, max: 64 * 1024 * 1024 }),
    rateLimit: {
      burstCapacity: read({ name: "REPORT_RATE_BURST", fallback: 10, min: 1, max: 10_000 }),
      burstRefillPerSecond: read({ name: "REPORT_RATE_BURST_REFILL_PER_SECOND", fallback: 1, min: 0.001, max: 1000 }),
      sustainedCapacity: read({ name: "REPORT_RATE_SUSTAINED", fallback: 60, min: 1, max: 100_000 }),
      sustainedRefillPerSecond: read({
        name: "REPORT_RATE_SUSTAINED_REFILL_PER_SECOND",
        fallback: 60 / 3600,
        min: 0.000_01,
        max: 1000,
      }),
      maxTrackedClients: read({ name: "REPORT_RATE_MAX_CLIENTS", fallback: 20_000, min: 16, max: 1_000_000 }),
    },
    storage: {
      maxReports: read({ name: "REPORT_MAX_REPORTS", fallback: 50_000, min: 1, max: 10_000_000 }),
      maxTotalBytes: read({
        name: "REPORT_MAX_TOTAL_BYTES",
        fallback: 1024 * 1024 * 1024,
        min: 1024,
        max: 1024 * 1024 * 1024 * 1024,
      }),
      retentionDays: read({ name: "REPORT_RETENTION_DAYS", fallback: 30, min: 1, max: 3650 }),
      sweepIntervalSeconds: read({ name: "REPORT_SWEEP_INTERVAL_SECONDS", fallback: 3600, min: 10, max: 86_400 }),
    },
    cors: {
      allowedHostPatterns: listOf(options.env["REPORT_ALLOWED_HOST_PATTERNS"] ?? "*-script.googleusercontent.com"),
      allowedOrigins: listOf(options.env["REPORT_ALLOWED_ORIGINS"] ?? ""),
    },
    trustedProxyHops: read({ name: "REPORT_TRUSTED_PROXY_HOPS", fallback: 0, min: 0, max: 8 }),
    ipHashSecret: options.env["REPORT_IP_HASH_SECRET"] ?? options.defaultIpHashSecret,
    requestTimeoutMs: read({ name: "REPORT_REQUEST_TIMEOUT_MS", fallback: 15_000, min: 1000, max: 600_000 }),
    headersTimeoutMs: read({ name: "REPORT_HEADERS_TIMEOUT_MS", fallback: 5000, min: 500, max: 600_000 }),
    keepAliveTimeoutMs: read({ name: "REPORT_KEEPALIVE_TIMEOUT_MS", fallback: 5000, min: 0, max: 600_000 }),
    maxConnections: read({ name: "REPORT_MAX_CONNECTIONS", fallback: 256, min: 1, max: 100_000 }),
    shutdownGraceMs: read({ name: "REPORT_SHUTDOWN_GRACE_MS", fallback: 10_000, min: 0, max: 120_000 }),
  };

  if (config.ipHashSecret.length < 16) {
    problems.push("REPORT_IP_HASH_SECRET must be at least 16 characters");
  }
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "ok", config };
}

/** Comma separated, trimmed, empties dropped -- so an unset variable is an empty list, not `[""]`. */
function listOf(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function numberReader(context: {
  env: Readonly<Record<string, string | undefined>>;
  problems: string[];
}): (options: Readonly<{ name: string; fallback: number; min: number; max: number }>) => number {
  return ({ name, fallback, min, max }) => {
    const raw = context.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      context.problems.push(`${name} must be a number between ${String(min)} and ${String(max)}`);
      return fallback;
    }
    return value;
  };
}
