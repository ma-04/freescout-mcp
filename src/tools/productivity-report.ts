import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHART_METRICS, GROUP_BYS, MAX_REPORT_DAYS, REPORT_TYPES, productivityReport } from "../reports.js";
import type { ToolContext } from "./context.js";
import { strictDate } from "./search-conversations.js";
import { PERMISSION_NOTE, run } from "./util.js";

/** Inputs shared by productivity_report and satisfaction_report. */
export const reportFilterSchema = () => ({
  from: strictDate().describe("First day (YYYY-MM-DD, inclusive)."),
  to: strictDate().describe(`Last day (YYYY-MM-DD, inclusive; at most ${MAX_REPORT_DAYS} days from 'from').`),
  mailbox_id: z.number().int().positive().optional().describe("Only this mailbox (see list_report_users). Default: all mailboxes this account can report on."),
  user_id: z.number().int().positive().optional().describe("Only this user (see list_report_users). Default: all users."),
  type: z.enum(REPORT_TYPES).optional().describe("Conversation type. Default: all."),
  tag_id: z.number().int().positive().optional().describe("Only conversations with this tag id."),
});

export const REPORTS_COMMON =
  "Needs FreeScout's paid Reports module and an account allowed to open it; otherwise the result is " +
  "{available: false, reason: \"module_not_installed\" | \"not_available_to_this_account\"} (never zeros) and " +
  "ticket_volume is the search-derived fallback. Read-only: one GET of the report page and one report request per " +
  "call (a POST to the Reports module's ajax endpoint, which only computes the report, the same request FreeScout's " +
  "own report page sends; the session layer may retry it once after a CSRF refresh or re-login). Changes are versus " +
  "FreeScout's previous period (inferred: the same-length period before from; unverified). Metric and table keys " +
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
        "(chart_metric grouped by day/week/month, current and previous period). Chart labels are FreeScout's display " +
        "strings, passed through verbatim. If FreeScout returns a different chart grouping or metric than requested " +
        "(e.g. week on a short range), the result has mismatch and says so. " +
        REPORTS_COMMON + " " + PERMISSION_NOTE,
      inputSchema: {
        ...reportFilterSchema(),
        chart_metric: z.enum(CHART_METRICS).default("customers_helped").describe("Chart series metric."),
        group_by: z.enum(GROUP_BYS).default("day").describe("Chart grouping."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await productivityReport(client, args)) })),
  );
}
