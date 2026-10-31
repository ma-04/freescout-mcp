import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WEEK_STARTS } from "../dates.js";
import { CHART_METRICS, GROUP_BYS, MAX_REPORT_DAYS, REPORT_TYPES, productivityReport } from "../reports.js";
import type { ToolContext } from "./context.js";
import { strictDate } from "./search-conversations.js";
import { PERMISSION_NOTE, run } from "./util.js";

/** Filters every report has (conversations and time tracking have no user filter). */
export const reportBaseFilterSchema = () => ({
  from: strictDate().describe("First day (YYYY-MM-DD, inclusive)."),
  to: strictDate().describe(`Last day (YYYY-MM-DD, inclusive; at most ${MAX_REPORT_DAYS} days from 'from').`),
  mailbox_id: z.number().int().positive().optional().describe("Only this mailbox (see list_report_users). Default: all mailboxes this account can report on."),
  type: z.enum(REPORT_TYPES).optional().describe("Conversation type. Default: all."),
  tag_id: z.number().int().positive().optional().describe("Only conversations with this tag id."),
});

/** Inputs shared by productivity_report and satisfaction_report. */
export const reportFilterSchema = () => ({
  ...reportBaseFilterSchema(),
  user_id: z.number().int().positive().optional().describe("Only this user (see list_report_users). Default: all users."),
});

export const PREVIOUS_PERIOD_TEXT =
  "Changes are versus FreeScout's previous period: the range shifted back by (to - from) days, so it overlaps from " +
  "by one day (for a single day every change is 0%; verified live).";

export const REPORTS_COMMON =
  "Needs FreeScout's paid Reports module and an account allowed to open it; otherwise the result is " +
  "{available: false, reason: \"module_not_installed\" | \"not_available_to_this_account\"} (never zeros) and " +
  "ticket_volume is the search-derived fallback. Read-only: one GET of the report page and one report request per " +
  "call (a POST to the Reports module's ajax endpoint, which only computes the report, the same request FreeScout's " +
  "own report page sends; the session layer may retry it once after a CSRF refresh or re-login). " +
  PREVIOUS_PERIOD_TEXT + " Metric and table keys " +
  "are slugs of the titles FreeScout renders, i.e. English titles on an English UI; another UI language gives other " +
  "keys (the note says so). Missing numbers are null, never 0.";

export function registerProductivityReport(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "productivity_report",
    {
      title: "Productivity report (FreeScout Reports module)",
      description:
        "FreeScout's Productivity report for a date range: metrics (customers helped, replies sent, replies per day, " +
        "closed, resolved on first reply) with change versus the previous period, first-response-time and " +
        "response-time distributions with averages (and resolution time / replies to resolve when FreeScout renders " +
        "them), a per-user table (replies sent, closed, customers helped, satisfaction score) and one chart series " +
        "(chart_metric per DAY, current and previous period; labels are FreeScout's display strings, verbatim). With " +
        "group_by week or month the server still requests the day series and adds chart.periods: one entry per " +
        "calendar week (ISO Monday-Sunday, or Sunday-Saturday with week_start sunday) or month, clipped to from..to, " +
        "with start, end, value (sum of the day points) and previous_value; FreeScout's own week/month chart series " +
        "are not period totals and are never used. For per-agent numbers per day/week use agent_stats. " +
        REPORTS_COMMON + " " + PERMISSION_NOTE,
      inputSchema: {
        ...reportFilterSchema(),
        chart_metric: z.enum(CHART_METRICS).default("customers_helped").describe("Chart series metric."),
        group_by: z.enum(GROUP_BYS).default("day").describe("day: the day series only; week/month: also chart.periods summed from it."),
        week_start: z.enum(WEEK_STARTS).default("monday").describe("group_by week only: monday (ISO weeks) or sunday (FreeScout's Sunday-Saturday weeks)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async ({ week_start, ...args }) => ({
      ...(await productivityReport(client, { ...args, ...(args.group_by === "week" ? { week_start } : {}) })),
    })),
  );
}
