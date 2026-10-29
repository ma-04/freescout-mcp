import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { discardDraft, saveDraft } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerSaveDraft(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "save_draft",
    {
      title: "Save reply draft",
      description:
        "Save a REPLY DRAFT on a conversation for a human to review. The draft appears in the FreeScout UI on the " +
        "conversation (and in the mailbox's Drafts folder) where the human agent can edit and send it. This MCP " +
        "server never sends it and has no send tool. Recipient defaults to the conversation's customer. To revise " +
        "your draft pass the thread_id returned by the previous call; without thread_id a second, separate draft " +
        "is created. FreeScout lets anyone who can view the conversation edit any draft on it, so a thread_id " +
        "may also be a teammate's draft: only pass a thread_id you created or were asked to edit. Refuses unsent " +
        "draft conversations. body is plain text (blank line = new paragraph) or simple HTML. " + PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id."),
        body: z.string().min(1).max(50_000).describe("Reply text."),
        thread_id: z.number().int().positive().optional().describe("Existing draft thread id to update instead of creating a new draft."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ conversation_id, body, thread_id }) => ({ draft: await saveDraft(client, conversation_id, body, thread_id) })),
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard reply draft",
      description:
        "Delete a reply draft (only a thread of type draft on the given conversation; anything else is refused). " +
        "Use it to clean up drafts you created that should not be sent. Nothing is sent. FreeScout lets anyone " +
        "who can view the conversation discard any draft on it, including a teammate's: only discard drafts you " +
        "created or were explicitly asked to remove. " + PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation the draft belongs to (checked before deleting)."),
        thread_id: z.number().int().positive().describe("Draft thread id (from save_draft or get_conversation)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ conversation_id, thread_id }) => ({ ...(await discardDraft(client, conversation_id, thread_id)) })),
  );
}
