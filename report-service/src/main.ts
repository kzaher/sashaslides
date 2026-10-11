// The process entry point: read the environment, start the service, and translate a signal into a
// graceful stop. Nothing else belongs here.

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { jsonLinesRequestLog } from "./request-log.ts";
import { startReportService } from "./report-service.ts";
import { parseServiceConfig } from "./service-config.ts";

async function main(): Promise<void> {
  const log = jsonLinesRequestLog({
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });

  const parsed = parseServiceConfig({
    env: process.env,
    defaultIpHashSecret: cryptoRandomBytes(32).toString("hex"),
  });
  if (parsed.kind === "invalid") {
    for (const problem of parsed.problems) {
      log.service({ at: new Date().toISOString(), event: "bad-configuration", detail: problem });
    }
    process.exitCode = 2;
    return;
  }

  const service = await startReportService({
    config: parsed.config,
    log,
    now: () => new Date(),
    randomBytes: (size) => cryptoRandomBytes(size),
  });

  log.service({
    at: new Date().toISOString(),
    event: "listening",
    detail: `${service.url} dataDir=${parsed.config.dataDir} retentionDays=${String(parsed.config.storage.retentionDays)}`,
  });

  // Both signals mean the same thing: stop taking work, finish what is in hand, exit 0. The
  // handlers are registered once and `stop` is idempotent, so a second Ctrl-C is harmless.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log.service({ at: new Date().toISOString(), event: "shutting-down", detail: signal });
      void service.stop().then(() => {
        log.service({ at: new Date().toISOString(), event: "stopped", detail: signal });
      });
    });
  }
}

await main();
