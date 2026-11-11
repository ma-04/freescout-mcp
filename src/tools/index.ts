import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddNote } from "./add-note.js";
import { registerAddTag } from "./add-tag.js";
import { registerAgentStats } from "./agent-stats.js";
import { registerCloseConversation } from "./close-conversation.js";
import type { ToolContext } from "./context.js";
import { registerConversationsReport } from "./conversations-report.js";
import { registerCreateConversation } from "./create-conversation.js";
import { registerForwardConversation } from "./forward-conversation.js";
import { registerGetConversation } from "./get-conversation.js";
import { registerCustomerHistory } from "./customer-history.js";
import { registerGetCustomer } from "./get-customer.js";
import { registerListAssignees } from "./list-assignees.js";
import { registerListConversations } from "./list-conversations.js";
import { registerListMailboxes } from "./list-mailboxes.js";
import { registerListReportUsers } from "./list-report-users.js";
import { registerListSavedReplies } from "./list-saved-replies.js";
import { registerListTags } from "./list-tags.js";
import { registerProductivityReport } from "./productivity-report.js";
import { registerRemoveNote } from "./remove-note.js";
import { registerRemoveTag } from "./remove-tag.js";
import { registerSatisfactionReport } from "./satisfaction-report.js";
import { registerSaveDraft } from "./save-draft.js";
import { registerSearchConversations } from "./search-conversations.js";
import { registerSendReply } from "./send-reply.js";
import { registerTicketVolume } from "./ticket-volume.js";
import { registerTimeTrackingReport } from "./time-tracking-report.js";
import { registerWaitingConversations } from "./waiting-conversations.js";
import { registerWhoami } from "./whoami.js";

/**
 * Every tool lives in its own file and exports a register function; add it here.
 * Writes are limited to add_note (internal note), save_draft, discard_draft, add_tag (adds tags), remove_tag (removes
 * named tags from one conversation, one pinned form per tag), remove_note (deletes one of the agent's own plain
 * internal notes; pinned {action:'delete_thread', thread_id}), close_conversation (status -> Closed only; no reopen/pending/spam path),
 * only when the operator set FREESCOUT_FORWARD_ALLOW, forward_conversation (one allow-listed, non-customer recipient; pinned
 * form) and, only when the operator set FREESCOUT_REPLY_ENABLED=1, send_reply (emails the conversation's customer alone:
 * a new reply or one of the agent's own drafts unchanged; optional FREESCOUT_REPLY_MAILBOXES; pinned form, no recipient fields).
 * create_conversation is always registered: by default it creates a DRAFT conversation (save_draft + is_create, nothing
 * emailed); it sends (send_reply + is_create, to/cc/bcc as given) only when ctx.createSend (FREESCOUT_CREATE_SEND=1 together
 * with FREESCOUT_REPLY_ENABLED=1), otherwise send=true is refused. Both forms are pinned (assertCreateForm).
 * list_tags, list_assignees, ticket_volume, waiting_conversations, customer_history and list_report_users are read-only (GET only). productivity_report and
 * satisfaction_report, conversations_report and time_tracking_report are read-only but send one report request per call (agent_stats one per bucket, paced), POST /reports/ajax, that only computes a report (assertReportForm; the session layer may retry it once after a CSRF refresh or re-login). Without FREESCOUT_REPLY_ENABLED there is no customer reply/send tool; there is no assign tool, and no reopen tool beyond send_reply's optional status.
 */
const registrars: Array<(server: McpServer, ctx: ToolContext) => void> = [
  registerWhoami,
  registerListMailboxes,
  registerListConversations,
  registerSearchConversations,
  registerGetConversation,
  registerGetCustomer,
  registerCustomerHistory,
  registerWaitingConversations,
  registerListSavedReplies,
  registerListTags,
  registerListAssignees,
  registerTicketVolume,
  registerListReportUsers,
  registerProductivityReport,
  registerSatisfactionReport,
  registerAgentStats,
  registerConversationsReport,
  registerTimeTrackingReport,
  registerAddNote,
  registerAddTag,
  registerRemoveTag,
  registerRemoveNote,
  registerSaveDraft,
  registerCloseConversation,
  registerCreateConversation,
];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const r of registrars) r(server, ctx);
  // Outbound email to a third party: only when the server operator configured an allow-list.
  if (ctx.forwardAllow.length > 0) registerForwardConversation(server, ctx);
  // Email to the customer: only when the server operator enabled it (server environment, never a request header).
  if (ctx.reply?.enabled === true) registerSendReply(server, ctx);
}

export type { ToolContext };
