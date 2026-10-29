import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addNote } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerAddNote(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "add_note",
    {
      title: "Add internal note",
      description:
        "Add an INTERNAL NOTE to a conversation. Notes are visible only to the support team in FreeScout and are " +
        "never emailed to the customer (teammates subscribed to notifications may get an internal email). Status " +
        "and assignee are left unchanged. Use it to record findings, summaries or hand-off context. body is plain " +
        "text (blank line = new paragraph) or simple HTML. Returns the new note's thread_id after re-reading the " +
        "conversation to confirm it was stored as a note. This server cannot send replies to customers; to " +
        "propose a customer reply use save_draft. " + PERMISSION_NOTE,
      inputSchema: {
        conversation_id: z.number().int().positive().describe("Conversation id."),
        body: z.string().min(1).max(50_000).describe("Note text (plain text or limited HTML)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async ({ conversation_id, body }) => ({ note: await addNote(client, conversation_id, body) })),
  );
}
