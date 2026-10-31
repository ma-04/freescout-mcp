import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isStrictDate } from "../dates.js";
import { ATTACHMENT_NAME_MAX, SEARCH_STATES, SEARCH_STATUSES, SEARCH_TYPES, TAG_MAX, searchConversations } from "../operations.js";
import type { ToolContext } from "./context.js";
import { CONTENT_NOTICE, PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

/** Strict YYYY-MM-DD that is a real calendar date (FreeScout silently turns anything else into 1970-01-01). */
export const strictDate = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine(isStrictDate, "must be a real calendar date (YYYY-MM-DD, year 1970 or later)");

/** A user id, or "unassigned" (no assignee). */
export const assignedArg = () =>
  z
    .union([z.number().int().positive(), z.literal("unassigned")])
    .describe('User id (see list_assignees; any id works) or "unassigned".');

export function registerSearchConversations(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "search_conversations",
    {
      title: "Search conversations",
      description:
        "Search conversations with FreeScout's search (q matches subject, body, customer name/email; '#123' finds " +
        "conversation number 123; together with a filter or mailbox_id, '#123' or '123' is sent as an exact " +
        "conversation-number filter and the result notes it) and/or filters. Give q, at least one filter, or both. " +
        'Filters: assigned (user id or "unassigned"), status[] and state[] (any of the listed values), after/before ' +
        "(YYYY-MM-DD, inclusive, on the conversation's CREATED date in the FreeScout server timezone, not last " +
        "activity), customer_id, type, has_attachments, subject and body (case-insensitive substring), tag (exact tag " +
        "name, needs the Tags module), following (true = only conversations this account follows), number (exact " +
        "conversation number; a numeric q is folded into it), id (exact conversation id) and attachment_name (a " +
        "module filter some installs have). FreeScout silently ignores a filter it has no handler for (module not " +
        "installed, or following/id/number on an older FreeScout); the result then lists it in unsupported_filters " +
        "and its rows are NOT narrowed by it. Like " +
        "FreeScout's own search, deleted conversations and unsent drafts are included unless state is given (use " +
        'state ["published"] to exclude them). Only mailboxes this agent can view are searched, so a missing result ' +
        "may be in a mailbox without access. mailbox_id narrows the search; if this account cannot view that " +
        "mailbox FreeScout silently searches all viewable mailboxes instead, and the result then says " +
        "mailbox_filter_ignored: true (null = could not verify). Accounts limited to their own conversations get " +
        "the assigned filter forced by FreeScout; the result then says assigned_filter_forced. total is the full " +
        "match count; 50 results per page. Each row has tags (Tags module names, [] without the module) and " +
        "mailbox_name (from the row's [Mailbox] preview prefix, which FreeScout adds only when results span several " +
        "mailboxes; null otherwise). " +
        UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        q: z.string().trim().max(500).optional().describe("Search text (optional when a filter is given; empty = none)."),
        mailbox_id: z.number().int().positive().optional(),
        assigned: assignedArg().optional(),
        status: z.array(z.enum(SEARCH_STATUSES)).min(1).max(4).optional().describe("Current status, any of these."),
        state: z.array(z.enum(SEARCH_STATES)).min(1).max(3).optional().describe("Conversation state, any of these."),
        after: strictDate().optional().describe("Created on or after this date (YYYY-MM-DD, server timezone)."),
        before: strictDate().optional().describe("Created on or before this date (YYYY-MM-DD, inclusive, server timezone)."),
        customer_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Customer id: conversations of this customer, including ones where the customer only wrote a reply " +
              "(FreeScout matches the conversation's customer OR any thread created by that customer).",
          ),
        type: z.enum(SEARCH_TYPES).optional(),
        has_attachments: z.boolean().optional(),
        subject: z.string().trim().min(1).max(200).optional().describe("Subject contains (case-insensitive)."),
        body: z.string().trim().min(1).max(200).optional().describe("A thread body contains (case-insensitive)."),
        tag: z
          .string()
          .trim()
          .min(1)
          .max(TAG_MAX)
          .optional()
          .describe("Exact tag name (see list_tags; Tags module). Same filter a tag chip links to in FreeScout."),
        following: z.literal(true).optional().describe("true = only conversations this account follows. Omit otherwise."),
        number: z.number().int().positive().optional().describe("Exact conversation number (as shown with #)."),
        id: z.number().int().positive().optional().describe("Exact conversation id."),
        attachment_name: z
          .string()
          .trim()
          .min(1)
          .max(ATTACHMENT_NAME_MAX)
          .optional()
          .describe("Attachment file name (module filter; matching rules unverified; see unsupported_filters)."),
        page: z.number().int().positive().default(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({
      content_notice: CONTENT_NOTICE,
      ...(await searchConversations(client, args)),
    })),
  );
}
