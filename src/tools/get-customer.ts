import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCustomer } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerGetCustomer(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "get_customer",
    {
      title: "Get a customer",
      description:
        "Customer profile (name, emails, phones, company, job title, address, notes) and their recent " +
        "conversations, by customer id (from get_conversation's customer.id) or by email address. Customer " +
        "profiles are global in FreeScout: the profile is returned even for a customer who only wrote to " +
        "mailboxes this agent cannot view, but the conversation list is filtered by permission (only " +
        "conversations in mailboxes this agent can view are listed). " + PERMISSION_NOTE,
      inputSchema: {
        id: z.number().int().positive().optional().describe("Customer id."),
        email: z.string().trim().email().optional().describe("Customer email (used when id is not given)."),
        limit: z.number().int().min(1).max(50).default(20).describe("Max conversations to return."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ id, email, limit }) => {
      if (!id && !email) throw new Error("Pass either id or email.");
      return { ...(await getCustomer(client, id ?? email!, limit)) };
    }),
  );
}
