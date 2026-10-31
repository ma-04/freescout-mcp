import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { customerHistory } from "../operations.js";
import type { ToolContext } from "./context.js";
import { CONTENT_NOTICE, PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerCustomerHistory(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "customer_history",
    {
      title: "Customer conversation history",
      description:
        "Read-only: a customer's profile (as get_customer) plus a compact list of their conversations (id, number, " +
        "subject, status, assignee, last activity, tags) and counts by status, from the customer page only (no extra " +
        "requests). Only conversations in mailboxes this account can view are listed; status is inferred from the " +
        "row (lock badge = closed, otherwise active/pending); counts cover the listed rows, and complete: false " +
        "means FreeScout's total is larger (use search_conversations with customer_id for the rest). Times are " +
        "display strings in the viewing user's timezone. " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        id: z.number().int().positive().optional().describe("Customer id."),
        email: z.string().trim().email().optional().describe("Customer email (used when id is not given)."),
        limit: z.number().int().min(1).max(50).default(50).describe("Max conversations to list."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ id, email, limit }) => {
      if (!id && !email) throw new Error("Pass either id or email.");
      return { content_notice: CONTENT_NOTICE, ...(await customerHistory(client, id ?? email!, limit)) };
    }),
  );
}
