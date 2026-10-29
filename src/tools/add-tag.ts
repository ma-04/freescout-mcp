import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addTag, MAX_TAG_LENGTH, MAX_TAGS_PER_CALL } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerAddTag(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "add_tag",
    {
      title: "Add tags to a conversation",
      description:
        "ADD tags to one conversation. It only adds: existing tags are kept and it never removes a tag (remove_tag does " +
        "that). It never " +
        "changes status, assignee or the customer's email, and sends nothing to the customer. Needs FreeScout's paid " +
        "Tags module; without it (or on an unsent draft conversation) it fails cleanly and changes nothing. Tags already " +
        "on the conversation are skipped (case-insensitive); if all are present nothing is posted. Afterwards the " +
        "conversation is re-read to confirm every earlier tag is still there and the new ones appear. Tag names: " +
        `1..${MAX_TAG_LENGTH} characters, no commas. Use list_tags with q to find existing tag names. ` +
        PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id."),
        tags: z
          .array(z.string().min(1).max(MAX_TAG_LENGTH))
          .min(1)
          .max(MAX_TAGS_PER_CALL)
          .describe(`Tag names to add (1..${MAX_TAGS_PER_CALL}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ conversation_id, tags }) => ({ ...(await addTag(client, conversation_id, tags)) })),
  );
}
