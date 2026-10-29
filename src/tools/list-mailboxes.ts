import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMailboxes } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerListMailboxes(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_mailboxes",
    {
      title: "List mailboxes",
      description:
        "List the FreeScout mailboxes this agent can access (read from the dashboard, never guessed), with each " +
        "mailbox's folders (id, name, type such as unassigned/mine/starred/assigned/closed/spam, active count). " +
        "Use it first to get mailbox_id and folder ids for list_conversations. Mailboxes missing here are not " +
        "accessible to this account. " + PERMISSION_NOTE,
      inputSchema: {
        include_folders: z
          .boolean()
          .default(true)
          .describe("Also open each mailbox page to list all folders incl. Closed/Spam (one extra request per mailbox)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ include_folders }) => ({ mailboxes: await listMailboxes(client, include_folders) })),
  );
}
