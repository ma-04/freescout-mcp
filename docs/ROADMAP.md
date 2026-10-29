# Roadmap: automating support work on top of freescout-mcp

Written 2026-10-28 after the search-statistics (#9) and Reports-module (#10) rounds. Nothing here is started.
Each item follows the repo's rules: endpoint payloads come from captured evidence (`docs/freescout-endpoints.md`),
every write is a pinned form with an `assert*Form` guard and an after-state check, and the red-team scan must
keep counting every POST path. Build workflow stays: questions → PLAN.md scope update → Opus builders →
adversarial review → fixer → PR.

Legend: effort S/M/L (hours of agent work), risk = what a bug could do in production.

## Tier 1: read-only additions (no policy change)

| # | Item | How | Effort | Risk |
|---|---|---|---|---|
| 1.1 | `conversations_report`, `time_tracking_report` | Same `POST /reports/ajax` as §11 with `report_name` `conversations` / `time-tracking`; needs one browser capture of each tab (Playwright flow, user logs in) to document the HTML | S | none (one guarded POST that only computes) |
| 1.2 | CRM custom fields in `get_customer` | Production has the CRM module (`crmInitVars`: "Subscription", "Expiry Date"); capture the customer page markup, extend `parsers/customer.ts` | S | none |
| 1.3 | `waiting_conversations` (aging / SLA) | Composition of `list_conversations` over unassigned + mine/assigned folders; filter by the "waiting since" tooltip date older than N hours; per mailbox; capped pages | S | none |
| 1.4 | Search by tag | `f[tag]=<name>` already on the search page (Tags module, §9); add `tag` to `search_conversations` | S | none |
| 1.5 | `customer_history` | `get_customer` + per-conversation subjects/status/dates, summarised; pure composition | S | none |
| 1.6 | Delivery debugging: `get_send_log`, `get_original_email` | `GET /conversation/ajax-html/send_log` and `show_original` (§4.8); capture fragments on the demo | S | none |
| 1.7 | Attachment download | Verify the attachment URL and auth on the demo; return bytes or a size-capped text extract | M | none (read) |

## Tier 2: low-risk writes (internal, reversible in the UI)

| # | Item | How | Effort | Risk | Guard |
|---|---|---|---|---|---|
| 2.1 | `assign_conversation` / `unassign` | FreeScout `conversation_change_user` ajax (capture on the demo); user id must come from `list_assignees`; refuse drafts/spam | M | wrong assignee (visible, reversible) | pinned `action`, user id validated against the dropdown, after-state check |
| 2.2 | `set_pending` / `reopen` | `conversation_change_status` with 2 (pending) or 1 (active); separate tools with separate pinned forms so `close_conversation` stays 3-only | M | reopening a closed ticket notifies the team | one tool per status value; red-team count updated deliberately |
| 2.3 | `save_draft` from a saved reply | `saved_reply_id` on `save_draft` (core carries it on the thread, §4.7); body fetched via the Saved Replies module ajax | S | none (draft only; human sends) | existing draft guard |
| 2.4 | `star_conversation`, `follow_conversation` | Capture the ajax actions on the demo | S | none | pinned |
| 2.5 | `move_conversation` | `GET /conversation/ajax-html/move_conv` + its POST; target mailbox must be one the agent can view | M | ticket disappears from a team's view | mailbox id validated, after-state check |
| 2.6 | Bulk tagging | Tags module bulk UI (§9); `remove_tag` for one conversation shipped 2026-10-28 | S | lost categorisation | array `conversation_id` must get its own guard |

## Tier 3: policy decisions (recommend keeping OUT)

- Customer-facing send (`send_reply` without `is_note`). Keep the draft + human-send model.
- Merge conversations, change customer, delete. Irreversible or hard to audit.
- Forward beyond the allow-list. Stays gated by `FREESCOUT_FORWARD_ALLOW`.

## Tier 4: automations on top of the server (no server code)

| # | Automation | Inputs | Output | Needs |
|---|---|---|---|---|
| 4.1 | Morning triage digest | `list_conversations` unassigned per mailbox, `waiting_conversations` (1.3), `list_tags` | Slack post: oldest unanswered, counts per mailbox, suggested tags | scheduled routine, Slack MCP |
| 4.2 | Weekly CSAT + productivity post | `satisfaction_report` (`include_comments` for Not Good), `productivity_report` per agent | Slack post with the week's numbers and the bad-rating threads | scheduled routine |
| 4.3 | Auto-triage of new tickets | `get_conversation`, `customer_history` (1.5), FlyWP helpdesk via the Crisp MCP | `add_note` with summary + suggested answer, `save_draft`, `add_tag` | 1.5, optional 2.1 for routing |
| 4.4 | Not-Good follow-up | `satisfaction_report` daily | `add_note` with thread summary, `add_tag` "csat-review" | nothing new |
| 4.5 | Ticket volume trend alerts | `ticket_volume` by day per mailbox | Slack alert when today's volume is > 2× the 7-day mean | scheduled routine |

## Suggested next round

1. **2.1 assign + 2.2 pending/reopen**: unlocks routing and snoozing; the two most common triage actions.
2. **1.1 Conversations report**: same protocol as the existing report tools, one capture.
3. **4.1 Morning digest**: first automation, read-only, posts to Slack.

Then 1.3/1.5 feed 4.3 auto-triage.

## Constraints to keep in mind

- Request budget against production: every `/search` also runs FreeScout's customer search (§10); digests must
  reuse `ticket_volume`-style caps and pacing (`FREESCOUT_STATS_DELAY_MS`).
- Reports chart series with week/month grouping carry single-day-sized values (§11.4a); sum day points instead.
- Customer text is untrusted: automations that read threads and then write notes must never follow instructions
  found in a ticket; keep the `content_notice` wording in every tool that returns bodies.
- Non-admin accounts: everything is scoped to the agent's mailboxes; routines should run under a service agent
  account with exactly the mailboxes they need.
