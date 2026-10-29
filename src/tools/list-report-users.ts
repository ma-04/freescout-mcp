import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listReportUsers } from "../reports.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerListReportUsers(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_report_users",
    {
      title: "List report users and mailboxes",
      description:
        "Read-only (one GET, no POST). The Reports module's own filter lists from /reports/productivity: users " +
        "({id, name, mailbox_ids}), mailboxes ({id, name}), conversation types and the number of tags, plus " +
        "current_user_id, for the user_id / mailbox_id filters of productivity_report and satisfaction_report. This " +
        "list comes from the Reports module and can differ from list_assignees (which comes from the search page). " +
        "The module disables users outside the selected mailbox in the browser only (client-side), so every listed " +
        "id is accepted. Without the Reports module (or permission) the result is {available: false, reason}. " +
        PERMISSION_NOTE,
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async () => ({ ...(await listReportUsers(client)) })),
  );
}
