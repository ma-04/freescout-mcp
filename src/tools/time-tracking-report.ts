import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timeTrackingReport } from "../reports.js";
import type { ToolContext } from "./context.js";
import { includeNamesSchema } from "./conversations-report.js";
import { REPORTS_COMMON, reportBaseFilterSchema } from "./productivity-report.js";
import { PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerTimeTrackingReport(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "time_tracking_report",
    {
      title: "Time tracking report (FreeScout Reports module)",
      description:
        "FreeScout's Time Tracking report for a date range: metrics (total hours spent, average hours spent per " +
        "update) with change versus the previous period, hours per user (chart), and three tables: time per user " +
        "(time spent, average per update), per conversation (conversation id and number) and per customer (customer " +
        "id). Every time is returned as FreeScout's display string (raw, e.g. \"2 days 22 hours 37 minutes\") plus " +
        "whole minutes (null when not parsable). Filters: mailbox_id, type, tag_id (this report has no user filter). " +
        "Conversation subjects, customer names and cells of unrecognised table columns (extra_columns) are included " +
        "only with include_names: true; they are untrusted. " +
        REPORTS_COMMON + " " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: { ...reportBaseFilterSchema(), include_names: includeNamesSchema() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await timeTrackingReport(client, args)) })),
  );
}
