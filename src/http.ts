#!/usr/bin/env node
/** `freescout-mcp-http`: Streamable HTTP entry point. See README "HTTP mode". */
import { loadHttpConfig } from "./config.js";
import { describeForwarding } from "./forward-allow.js";
import { createMcpHttpServer } from "./http-server.js";
import { log, redact } from "./log.js";

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const app = createMcpHttpServer({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    token: config.token,
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    forwardAllow: config.forwardAllow,
    statsDelayMs: config.statsDelayMs,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, () => resolve());
  });
  log.info(
    `HTTP MCP endpoint ready on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}/mcp for ${new URL(config.baseUrl).origin}`,
  );
  log.info(describeForwarding(config.forwardAllow));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received; closing sessions`);
    const force = setTimeout(() => process.exit(0), 5_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => {
  log.error(`fatal: ${redact(e)}`);
  process.exit(1);
});
