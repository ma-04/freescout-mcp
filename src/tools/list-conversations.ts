import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConversations } from "../operations.js";
import { FOLDER_TYPES, type FolderType } from "../parsers/mailbox.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerListConversations(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_conversations",
    {
      title: "List conversations in a folder",
      description:
        "List conversations in one folder of a mailbox, 50 per page (FreeScout's page size). folder is a folder " +
        "name (unassigned, mine, starred, assigned, closed, drafts, spam, deleted) resolved from the mailbox's " +
        "sidebar, or a numeric folder id from list_mailboxes. Rows: id (use with get_conversation), number, " +
        "subject, customer, preview, inferred status, assignee (when shown), last activity, thread count, starred, " +
        "tags (tag names from the Tags module, [] without it; never part of subject). " +
        "Use has_next_page/page to paginate. " + PERMISSION_NOTE,
      inputSchema: {
        mailbox_id: z.number().int().positive().describe("Mailbox id from list_mailboxes."),
        folder: z
          .union([z.enum(FOLDER_TYPES as [FolderType, ...FolderType[]]), z.number().int().positive()])
          .default("unassigned")
          .describe("Folder name or numeric folder id."),
        page: z.number().int().positive().default(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ mailbox_id, folder, page }) => ({ ...(await listConversations(client, mailbox_id, folder, page)) })),
  );
}
