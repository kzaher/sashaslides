/**
 * Wires the defect reports into the connector from the CLI's inputs (the same split as
 * `http/account-portal-stack.ts`), so `server.ts` stays a CLI.
 *
 * WHERE THEY LIVE. `report-service/` is the intake (schema, store, rate limits, CORS) and stays a
 * zero-dependency package that can still run on its own for development (`npm start` there). In
 * production it is MOUNTED here, in the connector, rather than run as a third process:
 *
 *   POST|GET|DELETE|OPTIONS /v1/reports[/<id>]   report-service's own handler, unchanged: the
 *                                                add-on's CORS origin, the caps, the rate limiter
 *   /account/reports/...                         the admin pages (report-admin.ts), behind the
 *                                                account portal's session and SASHA_ADMIN_EMAILS
 *
 * One process owns the store, so its single-writer rule (report-store.ts) holds, and the pages reuse
 * the portal's accounts, sign-in and CSRF token instead of a second login.
 *
 * Configuration: `--reports <directory>` turns it on (the store and `triage.jsonl` go there; `/data/
 * reports` in production). The rest is report-service's own `REPORT_*` environment (README there),
 * read by its own parser, so the caps and the proxy hop count mean the same thing in both places.
 * `REPORT_IP_HASH_SECRET` defaults to an HMAC of `SASHA_SESSION_SECRET`, so log labels correlate
 * across restarts without a third secret. `SASHA_ADMIN_EMAILS` names who may read reports.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReportRequestHandler } from "../../../report-service/src/http-service.ts";
import { tokenBucketRateLimiter } from "../../../report-service/src/rate-limiter.ts";
import { openReportStore, type ReportStore } from "../../../report-service/src/report-store.ts";
import { openTriageLog, type TriageLog } from "../../../report-service/src/report-triage.ts";
import { jsonLinesRequestLog } from "../../../report-service/src/request-log.ts";
import { parseServiceConfig, type ServiceConfig } from "../../../report-service/src/service-config.ts";
import type { SignedInPages } from "../http/account-portal";
import type { ReportIntakeRoutes } from "../http/http-server";
import { parseAdminAllowList, type AdminAllowList } from "./admin-allow-list";
import { createReportAdminPages } from "./report-admin";

export const REPORT_INTAKE_PATH = "/v1/reports";

export type ReportStack = Readonly<{
  intake: ReportIntakeRoutes;
  /** For the account portal; null when the portal is off (then nobody can read reports here). */
  pages: SignedInPages;
  banner: readonly string[];
  /** Stops the retention timer. */
  stop: () => void;
}>;

export type ReportStackLoad =
  | Readonly<{ kind: "ok"; stack: ReportStack }>
  | Readonly<{ kind: "off"; banner: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string }>;

export async function loadReportStack(
  options: Readonly<{
    /** `--reports`; null leaves reports off. */
    directory: string | null;
    env: Readonly<Record<string, string | undefined>>;
    /** `SASHA_SESSION_SECRET`, when set: the default key for the log's client labels. */
    sessionSecret: string | null;
    now: () => Date;
    warn: (message: string) => void;
  }>,
): Promise<ReportStackLoad> {
  const { directory, env, now, warn } = options;
  if (directory === null) {
    return { kind: "off", banner: ["defect reports: off (give --reports <directory> to accept them at /v1/reports)"] };
  }
  const allow = parseAdminAllowList(env["SASHA_ADMIN_EMAILS"]);
  if (allow.kind === "error") return { kind: "failed", message: allow.message };
  const parsed = parseServiceConfig({
    env: { ...definedOnly(env), REPORT_DATA_DIR: directory },
    defaultIpHashSecret:
      options.sessionSecret === null
        ? randomBytes(32).toString("hex")
        : createHmac("sha256", options.sessionSecret).update("report-ip-hash").digest("hex"),
  });
  if (parsed.kind === "invalid") return { kind: "failed", message: `defect reports: ${parsed.problems.join("; ")}` };
  const { config } = parsed;

  let store: ReportStore;
  let triage: TriageLog;
  try {
    store = await openReportStore({
      dataDir: config.dataDir,
      limits: {
        maxReports: config.storage.maxReports,
        maxTotalBytes: config.storage.maxTotalBytes,
        retentionDays: config.storage.retentionDays,
      },
      randomBytes: (size) => randomBytes(size),
    });
    triage = await openTriageLog({ dataDir: config.dataDir });
  } catch (cause) {
    return { kind: "failed", message: `defect reports: cannot open ${config.dataDir}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const log = jsonLinesRequestLog({ write: (line) => warn(`reports: ${line}`) });
  const handler = createReportRequestHandler({
    store,
    burstLimiter: tokenBucketRateLimiter({
      capacity: config.rateLimit.burstCapacity,
      refillPerSecond: config.rateLimit.burstRefillPerSecond,
      maxTrackedClients: config.rateLimit.maxTrackedClients,
    }),
    sustainedLimiter: tokenBucketRateLimiter({
      capacity: config.rateLimit.sustainedCapacity,
      refillPerSecond: config.rateLimit.sustainedRefillPerSecond,
      maxTrackedClients: config.rateLimit.maxTrackedClients,
    }),
    log,
    now,
    limits: {
      maxBodyBytes: config.maxBodyBytes,
      trustedProxyHops: config.trustedProxyHops,
      ipHashSecret: config.ipHashSecret,
      requestTimeoutMs: config.requestTimeoutMs,
      headersTimeoutMs: config.headersTimeoutMs,
      keepAliveTimeoutMs: config.keepAliveTimeoutMs,
      maxConnections: config.maxConnections,
    },
    cors: config.cors,
  });

  const sweep = async (): Promise<void> => {
    try {
      const swept = await store.sweep({ now: now() });
      const compacted = await triage.compact({ keep: (id) => store.find(id) !== null });
      warn(`reports: sweep expired=${String(swept.expired)} orphans=${String(swept.orphanFiles)} triageCompacted=${String(compacted)} held=${String(store.stats().reportCount)}`);
    } catch (cause) {
      warn(`reports: sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  await sweep();
  // `unref`: the retention timer is never the reason the process stays up.
  const timer = setInterval(() => void sweep(), config.storage.sweepIntervalSeconds * 1000);
  timer.unref();

  const intake: ReportIntakeRoutes = {
    async handleRequest({ request, response, url }: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>) {
      if (!isIntakePath(url.pathname)) return false;
      await handler(request, response);
      return true;
    },
  };
  return {
    kind: "ok",
    stack: {
      intake,
      pages: createReportAdminPages({ archive: store, triage, allowList: allow.allowList, now, warn }),
      banner: bannerOf({ config, allowList: allow.allowList, held: store.stats().reportCount }),
      stop: () => clearInterval(timer),
    },
  };
}

/** `/v1/reports` and `/v1/reports/<anything>`: report-service routes (and 404s) everything below. */
export function isIntakePath(pathname: string): boolean {
  return pathname === REPORT_INTAKE_PATH || pathname.startsWith(`${REPORT_INTAKE_PATH}/`);
}

function bannerOf(options: Readonly<{ config: ServiceConfig; allowList: AdminAllowList; held: number }>): readonly string[] {
  const { config, allowList, held } = options;
  return [
    `defect reports: accepting at ${REPORT_INTAKE_PATH} into ${config.dataDir} (${String(held)} held, kept ${String(config.storage.retentionDays)} days, proxy hops ${String(config.trustedProxyHops)})`,
    allowList.emails.size === 0
      ? "defect reports: no admin can read them yet (set SASHA_ADMIN_EMAILS)"
      : `defect reports: readable at /account/reports by ${String(allowList.emails.size)} admin address(es)`,
  ];
}

function definedOnly(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) defined[name] = value;
  return defined;
}
