import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WAITING_MAX_PAGES, WAITING_MAX_REQUESTS, waitingConversations } from "../waiting.js";
import type { ToolContext } from "./context.js";
import { CONTENT_NOTICE, PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerWaitingConversations(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "waiting_conversations",
    {
      title: "Conversations waiting on the team",
      description:
        "Read-only aging list: ACTIVE conversations in the Unassigned, Mine and Assigned folders (whichever this " +
        "account can see) whose last reply, or creation, is by the CUSTOMER and is older than older_than_hours " +
        "(default 24), longest wait first. One mailbox (mailbox_id) or every mailbox this account can view. " +
        "waiting_hours / waiting_hours_max are lower/upper bounds taken from FreeScout's relative 'waiting since' " +
        "label (e.g. '2 days ago' = 48..72 h; after 7 days FreeScout shows only a date, in the viewing user's " +
        "timezone, so those bounds carry +/-14 h). Rows too coarse to decide go to borderline. Pending " +
        "conversations and those last answered by a user are left out but counted. Folder pages are requested " +
        "oldest first (sorted_oldest_first: false per folder when FreeScout did not apply it or the rows were out " +
        `of order; paging then never stops early), at most max_pages (1..${WAITING_MAX_PAGES}) per folder and ` +
        `${WAITING_MAX_REQUESTS} requests per call; truncated: true means more may exist. English UI only: labels ` +
        "in another language cannot be read (counted in counts.unreadable_age, with a note). Mailboxes this " +
        "account cannot open are listed in mailboxes_skipped. " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        mailbox_id: z.number().int().positive().optional().describe("Mailbox id (list_mailboxes); omit for all viewable mailboxes."),
        older_than_hours: z.number().min(0).max(8784).default(24).describe("Minimum wait in hours (default 24)."),
        max_pages: z.number().int().min(1).max(WAITING_MAX_PAGES).default(WAITING_MAX_PAGES).describe("Pages (50 rows) per folder."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ content_notice: CONTENT_NOTICE, ...(await waitingConversations(client, args)) })),
  );
}
