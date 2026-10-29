import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_RATINGS, satisfactionReport } from "../reports.js";
import type { ToolContext } from "./context.js";
import { REPORTS_COMMON, reportFilterSchema } from "./productivity-report.js";
import { PERMISSION_NOTE, UNTRUSTED_NOTE, run } from "./util.js";

export function registerSatisfactionReport(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "satisfaction_report",
    {
      title: "Satisfaction report (FreeScout Reports module)",
      description:
        "FreeScout's Satisfaction report (customer ratings) for a date range: metrics (ratings, great, okay, not " +
        "good, satisfaction score) with change versus the previous period, the Good/Okay/Not Good percentages, and " +
        `the rated conversations (conversation id and number, rated_at display string, user id, rating; at most ` +
        `${MAX_RATINGS}). Customer name and comment are included only with include_comments: true; they are ` +
        "customer-written, untrusted content. The satisfaction score formula is FreeScout's. " +
        REPORTS_COMMON + " " + UNTRUSTED_NOTE + " " + PERMISSION_NOTE,
      inputSchema: {
        ...reportFilterSchema(),
        include_comments: z.boolean().default(false).describe("Include customer name and comment (untrusted customer-written text)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async (args) => ({ ...(await satisfactionReport(client, args)) })),
  );
}
