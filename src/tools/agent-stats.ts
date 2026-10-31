import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BUCKET_PERIODS, WEEK_STARTS } from "../dates.js";
import { MAX_AGENT_STATS_BUCKETS, agentStats } from "../reports.js";
import type { ToolContext } from "./context.js";
import { PREVIOUS_PERIOD_TEXT, reportFilterSchema } from "./productivity-report.js";
import { strictDate } from "./search-conversations.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerAgentStats(server: McpServer, { client, statsDelayMs }: ToolContext): void {
  server.registerTool(
    "agent_stats",
    {
      title: "Agent stats per day / week / month (FreeScout Reports module)",
      description:
        "Read-only. Daily, weekly or monthly productivity numbers per agent: for each day / week (ISO Monday-Sunday " +
        "by default, Sunday-Saturday with week_start sunday) / calendar month between from and to (first and last " +
        "bucket clipped to from/to; each bucket states its start and end), FreeScout's Productivity metrics exactly as " +
        "the Reports page shows them for that bucket's from/to (customers helped, replies sent, replies per day, " +
        "closed, resolved on first reply, with change versus FreeScout's previous period) and the per-user table " +
        "(replies sent, closed, customers helped, satisfaction score per agent; [] when the bucket has no users table). " +
        "totals (replies_sent, closed, resolved_on_first_reply) and user_totals (replies_sent, closed) are summed by " +
        "this server over the buckets; customers helped, replies per day and satisfaction score are per bucket only " +
        "(customers helped counts distinct customers, so use productivity_report on the whole range for it). Optional filters: mailbox_id, user_id " +
        "(see list_report_users), type, tag_id. Cost: one report page GET plus one report computation per bucket " +
        `(a POST that only computes the report, the same request FreeScout's own report page sends), run one after ` +
        `another with a short pause; at most ${MAX_AGENT_STATS_BUCKETS} buckets per call (checked before any request), ` +
        "so use week or month for longer ranges. requests_made shows the cost. If a request fails mid-run the result " +
        "has incomplete: true with the finished buckets and null totals/user_totals; do not retry it blindly. A dead " +
        "session or a report permission refusal is a tool error. Needs FreeScout's paid Reports " +
        'module; otherwise {available: false, reason: "module_not_installed" | "not_available_to_this_account"} ' +
        "(never zeros) and ticket_volume is the search-derived fallback. " +
        PREVIOUS_PERIOD_TEXT + " Missing numbers are null, never 0. " + PERMISSION_NOTE,
      inputSchema: {
        ...reportFilterSchema(),
        to: strictDate().describe(`Last day (YYYY-MM-DD, inclusive). The range is limited by the ${MAX_AGENT_STATS_BUCKETS}-bucket cap (e.g. 31 days by day, 31 weeks by week).`),
        period: z.enum(BUCKET_PERIODS).default("day").describe("Bucket size: day, week or calendar month."),
        week_start: z.enum(WEEK_STARTS).default("monday").describe("period week only: monday (ISO weeks) or sunday (FreeScout's Sunday-Saturday weeks)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await agentStats(client, args, { delayMs: statsDelayMs })) })),
  );
}
