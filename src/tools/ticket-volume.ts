import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BREAKDOWNS, MAX_BREAKDOWN_VALUES, MAX_BUCKETS, MAX_REQUESTS, PERIODS, ticketVolume } from "../stats.js";
import type { ToolContext } from "./context.js";
import { assignedArg, strictDate } from "./search-conversations.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerTicketVolume(server: McpServer, { client, statsDelayMs }: ToolContext): void {
  server.registerTool(
    "ticket_volume",
    {
      title: "Ticket volume (conversations created per period)",
      description:
        "Read-only. Counts published conversations (deleted and draft excluded) CREATED in each day / ISO week " +
        "(Monday-Sunday) / calendar month between from and to (inclusive; created_at in the FreeScout server " +
        "timezone, usually UTC), optionally broken down by their CURRENT status, assignee or mailbox. It does NOT " +
        "measure conversations resolved/closed per day, response or resolution times, or satisfaction ratings. Only " +
        "mailboxes this account can view are counted; a mailbox_id this account cannot view is silently widened by " +
        "FreeScout to all viewable mailboxes (the result then says mailbox_filter_ignored: true; null = could not " +
        "verify). Assignee breakdown uses list_assignees plus unassigned; conversations of users missing from that " +
        'list are counted as "other". If FreeScout forces the assigned filter (accounts limited to their own ' +
        "conversations) the result says assigned_filter_forced. Each number is one FreeScout search (each also runs " +
        "a customer search on the server), run one after another with a short pause: at most " +
        `${MAX_BUCKETS} buckets, ${MAX_BREAKDOWN_VALUES} breakdown values and ${MAX_REQUESTS} requests per call ` +
        "(buckets x requests per bucket: 1 for none, 4 for status, values + 1 for assignee, values for mailbox; e.g. " +
        "status by day covers at most 16 days). requests_made shows the cost; for longer ranges use a coarser period. " +
        "If a request fails mid-run the result has incomplete: true with the finished buckets; do not retry it " +
        "blindly. The first and last bucket are clipped to from/to; each bucket states its start and end. " +
        PERMISSION_NOTE,
      inputSchema: {
        from: strictDate().describe("First day (YYYY-MM-DD, inclusive)."),
        to: strictDate().describe("Last day (YYYY-MM-DD, inclusive)."),
        period: z.enum(PERIODS).default("day"),
        breakdown: z.enum(BREAKDOWNS).default("none"),
        mailbox_id: z.number().int().positive().optional().describe("Only this mailbox (not with breakdown=mailbox)."),
        assigned: assignedArg().optional().describe('Only this assignee: user id or "unassigned" (not with breakdown=assignee).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await ticketVolume(client, args, { delayMs: statsDelayMs })) })),
  );
}
