import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { capBodies, capThreads, getConversation } from "../operations.js";
import type { ToolContext } from "./context.js";
import { CONTENT_NOTICE, PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerGetConversation(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "get_conversation",
    {
      title: "Get a conversation",
      description:
        "Read one conversation by id (the id from list/search results, not necessarily the #number): subject, " +
        "mailbox, customer, status, assignee (assignee_id -1 = unassigned), starred, and every thread oldest first. " +
        "Thread types: customer (message from the customer), message (agent reply sent to the customer), note " +
        "(internal, never sent to the customer), draft (unsent reply draft), lineitem (status/assignee change log). " +
        "Bodies are plain text converted from HTML; FreeScout does not mark quoted email history, so customer " +
        "messages may include it. current_user_id is the logged-in agent. At most max_threads threads are returned " +
        "(the newest ones, still oldest first); total_threads is the full count and threads_truncated tells if " +
        "older threads were left out. " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        id: z.number().int().positive().describe("Conversation id."),
        max_threads: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Return only the newest N threads (oldest first within them)."),
        max_body_chars: z.number().int().min(200).max(100_000).default(20_000).describe("Truncate each thread body to this many characters."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ id, max_threads, max_body_chars }) => ({
      content_notice: CONTENT_NOTICE,
      ...capThreads(capBodies(await getConversation(client, id), max_body_chars), max_threads),
    })),
  );
}
