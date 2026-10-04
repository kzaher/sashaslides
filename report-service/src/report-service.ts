// THE COMPOSITION ROOT. The only place that builds the store, the limiters and the server and
// wires them together, and the only place that owns their lifetimes.
//
// `startReportService` is what both `main.ts` and the tests call, so the tests exercise the real
// service -- real sockets, real filesystem, real limiter -- with nothing substituted except the
// three things a test legitimately needs to control: the clock, the entropy source and the log
// sink. There is no mock of the service anywhere in this package.

import type { Server } from "node:http";
import { createReportServer, type ReportServiceDependencies } from "./http-service.ts";
import { openReportStore, type ReportStore } from "./report-store.ts";
import { tokenBucketRateLimiter } from "./rate-limiter.ts";
import type { RandomBytes } from "./report-id.ts";
import type { RequestLog } from "./request-log.ts";
import type { ServiceConfig } from "./service-config.ts";

export type RunningReportService = Readonly<{
  /** Where it actually listens. With `port: 0` this is the only way to learn the real port. */
  url: string;
  port: number;
  store: ReportStore;
  /** Idempotent. Resolves once every in-flight request has been answered or the grace has run out. */
  stop: () => Promise<void>;
}>;

export async function startReportService(options: {
  config: ServiceConfig;
  log: RequestLog;
  now: () => Date;
  randomBytes: RandomBytes;
}): Promise<RunningReportService> {
  const { config } = options;
  const store = await openReportStore({
    dataDir: config.dataDir,
    limits: {
      maxReports: config.storage.maxReports,
      maxTotalBytes: config.storage.maxTotalBytes,
      retentionDays: config.storage.retentionDays,
    },
    randomBytes: options.randomBytes,
  });

  const dependencies: ReportServiceDependencies = {
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
    log: options.log,
    now: options.now,
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
  };

  const server = createReportServer(dependencies);
  const address = await listen({ server, host: config.host, port: config.port });

  // `unref` so a forgotten sweep timer can never be the reason the process will not exit. The
  // sweep is also run once at startup, which is what makes retention hold across a service that
  // restarts more often than its sweep interval.
  const sweepTimer = setInterval(() => {
    void runSweep({ store, log: options.log, now: options.now });
  }, config.storage.sweepIntervalSeconds * 1000);
  sweepTimer.unref();
  await runSweep({ store, log: options.log, now: options.now });

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= shutDown({ server, sweepTimer, graceMs: config.shutdownGraceMs });
    return stopping;
  };

  return Object.freeze({
    url: `http://${address.host}:${String(address.port)}`,
    port: address.port,
    store,
    stop,
  });
}

async function listen(options: {
  server: Server;
  host: string;
  port: number;
}): Promise<Readonly<{ host: string; port: number }>> {
  return new Promise((resolve, reject) => {
    options.server.once("error", reject);
    options.server.listen(options.port, options.host, () => {
      const address = options.server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      options.server.removeListener("error", reject);
      // `::` and `0.0.0.0` are not addresses a client can connect to; name the loopback instead.
      const host = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
      resolve({ host: host.includes(":") ? `[${host}]` : host, port: address.port });
    });
  });
}

/**
 * Stop accepting, let what is in flight finish, then insist.
 *
 * `closeIdleConnections` is the part that matters: `server.close()` alone waits for keep-alive
 * sockets that are sitting there holding nothing, so a service with any traffic at all would hang
 * until each one timed out. Connections still carrying a request are left alone until the grace
 * expires, at which point `closeAllConnections` takes them -- a request that has had ten seconds
 * and is still going is not going to finish.
 */
async function shutDown(options: {
  server: Server;
  sweepTimer: NodeJS.Timeout;
  graceMs: number;
}): Promise<void> {
  clearInterval(options.sweepTimer);
  const closed = new Promise<void>((resolve) => {
    options.server.close(() => resolve());
  });
  options.server.closeIdleConnections();
  const forceTimer = setTimeout(() => options.server.closeAllConnections(), options.graceMs);
  forceTimer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(forceTimer);
  }
}

async function runSweep(options: {
  store: ReportStore;
  log: RequestLog;
  now: () => Date;
}): Promise<void> {
  try {
    const swept = await options.store.sweep({ now: options.now() });
    const stats = options.store.stats();
    options.log.service({
      at: options.now().toISOString(),
      event: "sweep",
      detail: `expired=${String(swept.expired)} orphans=${String(swept.orphanFiles)} compacted=${String(swept.compacted)} reports=${String(stats.reportCount)} bytes=${String(stats.totalBytes)} unreadableIndexLines=${String(stats.unreadableIndexLines)}`,
    });
  } catch (caught) {
    options.log.service({
      at: options.now().toISOString(),
      event: "sweep-failed",
      detail: caught instanceof Error ? caught.message : "unknown error",
    });
  }
}
