#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FreeScoutClient } from "./client.js";
import { loadConfig } from "./config.js";
import { describeForwarding } from "./forward-allow.js";
import { addSecret, log, redact } from "./log.js";
import { Session } from "./session.js";
import { registerTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export { VERSION };

async function main(): Promise<void> {
  const config = loadConfig();
  addSecret(config.password, true);
  const session = new Session({
    baseUrl: config.baseUrl,
    cookie: config.cookie,
    user: config.user,
    password: config.password,
    timeoutMs: config.timeoutMs,
  });
  const client = new FreeScoutClient(session);

  const server = new McpServer({ name: "freescout-mcp", version: VERSION });
  registerTools(server, { client, forwardAllow: config.forwardAllow, statsDelayMs: config.statsDelayMs });

  await server.connect(new StdioServerTransport());
  log.info(
    `ready for ${session.baseUrl.origin} (auth: ${config.cookie ? "cookie" : "credentials"}${
      session.canAutoLogin ? ", auto re-login enabled" : ""
    })`,
  );
  log.info(describeForwarding(config.forwardAllow));
}

main().catch((e) => {
  log.error(`fatal: ${redact(e)}`);
  process.exit(1);
});
