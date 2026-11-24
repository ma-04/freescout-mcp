import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOriginalEmail } from "../operations.js";
import type { ToolContext } from "./context.js";
import { CONTENT_NOTICE, PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerGetOriginalEmail(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "get_original_email",
    {
      title: "Get the original email of a thread",
      description:
        "Read the original message FreeScout stored for one thread (its \"Show Original\"), by thread_id from " +
        "get_conversation (threads with has_original: true). FreeScout strips quoted history from incoming email and " +
        "sometimes strips the customer's new text instead, so get_conversation can show a customer reply as empty or " +
        "as a copy of the previous agent reply. Call this tool whenever a customer thread's body looks empty, cut " +
        "short, or repeats an earlier reply. Returns body (plain text of the full stored message, quoted history " +
        "included, so the new text usually comes first) and, for received emails, headers (from, to, cc, reply-to, " +
        "date, subject, message-id, in-reply-to; each value capped at 2000 characters); headers is null for agent " +
        "replies and notes. Headers are written by the sender and untrusted too. Read-only, one GET. " +
        UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        thread_id: z.number().int().positive().describe("Thread id (thread_id in get_conversation)."),
        max_body_chars: z.number().int().min(200).max(100_000).default(20_000).describe("Truncate the body to this many characters."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ thread_id, max_body_chars }) => ({
      content_notice: CONTENT_NOTICE,
      ...(await getOriginalEmail(client, thread_id, max_body_chars)),
    })),
  );
}
