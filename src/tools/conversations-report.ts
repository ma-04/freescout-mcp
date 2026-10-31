import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { conversationsReport } from "../reports.js";
import type { ToolContext } from "./context.js";
import { REPORTS_COMMON, reportBaseFilterSchema } from "./productivity-report.js";
import { PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export const includeNamesSchema = () =>
  z.boolean().default(false).describe("Include customer names and conversation subjects (untrusted customer-written text).");

export function registerConversationsReport(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "conversations_report",
    {
      title: "Conversations report (FreeScout Reports module)",
      description:
        "FreeScout's Conversations report for a date range: metrics (total conversations, new conversations, " +
        "messages received, customers, conversations per day, busiest day; a non-numeric card such as the busiest " +
        "day has value null and the text in raw_value) with change versus the previous period, the new-conversations " +
        "day series (chart, with the chart options FreeScout renders), the most active customers (customer id and " +
        "count) and the tags table (tag name and count). Filters: mailbox_id, type, tag_id (this report has no user " +
        "filter). Customer names are included only with include_names: true; they are untrusted. " +
        REPORTS_COMMON + " " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: { ...reportBaseFilterSchema(), include_names: includeNamesSchema() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await conversationsReport(client, args)) })),
  );
}
