import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_TAG_LENGTH, MAX_TAGS_PER_CALL, removeTag } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerRemoveTag(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "remove_tag",
    {
      title: "Remove tags from a conversation",
      description:
        "REMOVE tags from one conversation. Only the named tags are removed from this one conversation; other tags " +
        "stay, and the tag itself still exists in FreeScout for other conversations. It never changes status, assignee " +
        "or the customer's email, and sends nothing to the customer. Needs FreeScout's paid Tags module; without it (or " +
        "on an unsent draft conversation) it fails cleanly and changes nothing. Names are matched case-insensitively " +
        "against the tags shown on the conversation; names not on it are reported in not_present and nothing is posted " +
        "for them. Afterwards the conversation is re-read to confirm the removed tags are gone and every other tag is " +
        `still there. Tag names: 1..${MAX_TAG_LENGTH} characters, no commas. Use get_conversation to see current tags. ` +
        PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id."),
        tags: z
          .array(z.string().min(1).max(MAX_TAG_LENGTH))
          .min(1)
          .max(MAX_TAGS_PER_CALL)
          .describe(`Tag names to remove (1..${MAX_TAGS_PER_CALL}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ conversation_id, tags }) => ({ ...(await removeTag(client, conversation_id, tags)) })),
  );
}
