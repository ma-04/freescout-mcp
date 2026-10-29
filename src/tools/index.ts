import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddNote } from "./add-note.js";
import { registerAddTag } from "./add-tag.js";
import { registerCloseConversation } from "./close-conversation.js";
import type { ToolContext } from "./context.js";
import { registerForwardConversation } from "./forward-conversation.js";
import { registerGetConversation } from "./get-conversation.js";
import { registerGetCustomer } from "./get-customer.js";
import { registerListAssignees } from "./list-assignees.js";
import { registerListConversations } from "./list-conversations.js";
import { registerListMailboxes } from "./list-mailboxes.js";
import { registerListReportUsers } from "./list-report-users.js";
import { registerListSavedReplies } from "./list-saved-replies.js";
import { registerListTags } from "./list-tags.js";
import { registerProductivityReport } from "./productivity-report.js";
import { registerRemoveTag } from "./remove-tag.js";
import { registerSatisfactionReport } from "./satisfaction-report.js";
import { registerSaveDraft } from "./save-draft.js";
import { registerSearchConversations } from "./search-conversations.js";
import { registerTicketVolume } from "./ticket-volume.js";
import { registerWhoami } from "./whoami.js";

/**
 * Every tool lives in its own file and exports a register function; add it here.
 * Writes are limited to add_note (internal note), save_draft, discard_draft, add_tag (adds tags), remove_tag (removes
 * named tags from one conversation, one pinned form per tag), close_conversation (status -> Closed only; no reopen/pending/spam path) and, only when the
 * operator set FREESCOUT_FORWARD_ALLOW, forward_conversation (one allow-listed, non-customer recipient; pinned form).
 * list_tags, list_assignees, ticket_volume and list_report_users are read-only (GET only). productivity_report and
 * satisfaction_report are read-only but send one report request per call, POST /reports/ajax, that only computes a report (assertReportForm; the session layer may retry it once after a CSRF refresh or re-login). There is deliberately no customer reply/send tool and no assign/reopen tool.
 */
const registrars: Array<(server: McpServer, ctx: ToolContext) => void> = [
  registerWhoami,
  registerListMailboxes,
  registerListConversations,
  registerSearchConversations,
  registerGetConversation,
  registerGetCustomer,
  registerListSavedReplies,
  registerListTags,
  registerListAssignees,
  registerTicketVolume,
  registerListReportUsers,
  registerProductivityReport,
  registerSatisfactionReport,
  registerAddNote,
  registerAddTag,
  registerRemoveTag,
  registerSaveDraft,
  registerCloseConversation,
];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const r of registrars) r(server, ctx);
  // Outbound email to a third party: only when the server operator configured an allow-list.
  if (ctx.forwardAllow.length > 0) registerForwardConversation(server, ctx);
}

export type { ToolContext };
