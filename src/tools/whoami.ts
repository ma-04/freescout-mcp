import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { errorResult, jsonResult } from "./util.js";

export function registerWhoami(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the FreeScout user this server is logged in as (id, name, email, role) plus session health: " +
        "whether auth came from a pasted cookie or from FREESCOUT_USER/PASSWORD login, whether auto re-login is " +
        "available, and whether the last request succeeded. Call this first to confirm the session works.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const user = await client.whoami();
        return jsonResult({ user, session: client.health });
      } catch (e) {
        const res = errorResult(e);
        res.content.push({ type: "text", text: JSON.stringify({ session: client.health }, null, 2) });
        return res;
      }
    },
  );
}
