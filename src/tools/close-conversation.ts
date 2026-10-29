import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeConversation } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerCloseConversation(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "close_conversation",
    {
      title: "Close a conversation",
      description:
        "Set one conversation's status to Closed. It only closes: it never reopens a conversation or sets Active, " +
        "Pending or Spam, and the assignee is left unchanged. It never emails the customer (teammates subscribed to " +
        "notifications may get an internal email). If the conversation is already closed nothing is posted and " +
        "already_closed is true. Refuses unsent draft conversations and Spam conversations (closing would un-spam them). Afterwards the conversation is re-read to " +
        "confirm it is closed, the assignee is unchanged and only a status line was added. Returns previous_status. " +
        PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ conversation_id }) => ({ ...(await closeConversation(client, conversation_id)) })),
  );
}
