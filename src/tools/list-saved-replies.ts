import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSavedReplies } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerListSavedReplies(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_saved_replies",
    {
      title: "List saved replies",
      description:
        "List the mailbox's saved (canned) replies, to reuse their wording in a draft. Saved Replies is a paid " +
        "FreeScout module: when it is not installed this returns {available:false, reason} (not an error); do " +
        "not retry, just write the reply yourself. " + PERMISSION_NOTE,
      inputSchema: { mailbox_id: z.number().int().positive().describe("Mailbox id from list_mailboxes.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ mailbox_id }) => ({ ...(await listSavedReplies(client, mailbox_id)) })),
  );
}
