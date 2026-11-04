import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { removeNote } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerRemoveNote(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "remove_note",
    {
      title: "Remove one of your own internal notes",
      description:
        "DELETE one INTERNAL NOTE that the logged-in agent wrote, permanently (FreeScout keeps no copy; the result " +
        "returns the deleted body). It only ever deletes that one note: it never deletes customer messages, replies " +
        "sent to the customer, drafts (use discard_draft), status/assignee log lines, forward notes, notes written by " +
        "other users or the first thread of a conversation, and it refuses those before sending anything. It never " +
        "changes status or assignee and sends nothing to the customer. Use get_conversation to find the thread: " +
        "type 'note', author.is_current_user true, no is_forward, and can_delete true. Afterwards the conversation is " +
        "re-read to confirm the note is gone and every other thread is still there. Calling it again for a note that " +
        "is already gone fails with 'not on conversation' and changes nothing. " +
        PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id the note belongs to."),
        thread_id: z.number().int().positive().describe("Thread id of the note (from get_conversation)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ conversation_id, thread_id }) => ({ ...(await removeNote(client, conversation_id, thread_id)) })),
  );
}
