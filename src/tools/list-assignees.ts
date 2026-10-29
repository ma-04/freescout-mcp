import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAssignees } from "../operations.js";
import type { ToolContext } from "./context.js";
import { PERMISSION_NOTE, run } from "./util.js";

export function registerListAssignees(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_assignees",
    {
      title: "List assignees",
      description:
        "Read-only. Users this account can pick in FreeScout's search 'Assigned' filter, as {id, name}, for the " +
        "assigned filter of search_conversations and ticket_volume (\"unassigned\" means no assignee). FreeScout " +
        "lists only users this account may see, so admins and users of other mailboxes may be missing; any numeric " +
        "user id still works in assigned filters. " +
        PERMISSION_NOTE,
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(async () => ({ ...(await listAssignees(client)) })),
  );
}
