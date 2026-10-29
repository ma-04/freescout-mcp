# FreeScout cookie-session MCP — Plan

## Problem
Support agents have FreeScout web logins with limited mailbox permissions and **no API key**
(the REST API module is not available to them). We need an MCP server that lets an LLM agent
work a support inbox using only what the human agent already has: a browser session cookie
(and optionally their username/password).

## Decisions (from planning questions, 2026-10-22)
| Topic | Decision |
|---|---|
| Auth source | Both: pasted cookie string preferred, fall back to username/password login |
| Scope | Read everything the agent can see + add **internal notes** + save **reply drafts**. **No customer-facing sends.** |
| Runtime | TypeScript MCP server over **stdio**, one agent session per instance |
| Demo | FreeScout in Docker on 203.0.113.10 at https://freescout.example.com (wildcard DNS) |

Scope update (2026-10-25, user): tagging added to scope. Done: read-only `list_tags` (autocomplete when `q` is given,
page scan otherwise) and `add_tag` (adds only; guarded by `assertTagForm`; verifies the after-state). The protocol was
verified from a production install's own JS bundle and pages (docs/freescout-endpoints.md §9). Removing tags was added
2026-10-28 as `remove_tag` (pinned `action=remove` form per tag, `assertTagRemoveForm`, after-state check). The single live write test on the production install is run by the user.

Scope update (2026-10-26, user): two more writes. `close_conversation` sets status Closed via
`conversation_change_status` (status pinned to 3; no reopen/pending/spam path). `forward_conversation` forwards one
conversation to ONE recipient via `send_reply` + `subtype=1` + `to_email[]`. Forwarding is outbound email, so it is
gated: the tool is registered only when the server operator sets `FREESCOUT_FORWARD_ALLOW` (comma-separated exact
emails and `@domain` entries); the recipient must match it and must not be the conversation's customer; status and
assignee are sent unchanged; the original conversation is re-read afterwards and the call fails loudly unless the
only new thread is a forward note. Customer-facing replies remain out of scope: no reply/send tool.

Scope update (2026-10-28, user): **search filters and agent statistics**, read-only. Decisions from the planning
questions: extend this repo (no separate server); numbers come from the paid Reports module where it exists and
the account can open it, with a search-derived fallback everywhere; all four items requested (productivity by date
per agent, satisfaction by date per agent, ticket volume by date, richer search filters); Reports-module endpoints
are discovered from a browser capture the user makes on their own install (Claude never logs in to production).

### Phase A — buildable now (verified on the demo, docs/freescout-endpoints.md §10)
1. `search_conversations` gains filters: `assigned` (user id or `"unassigned"`), `status[]`, `state[]`, `after`,
   `before` (strict `YYYY-MM-DD`; FreeScout turns anything else into 1970-01-01 silently), `customer_id`, `type`,
   `has_attachments`, `subject`, `body`. `q` becomes optional (a filters-only search is a normal page). Tool text
   states that `after`/`before` filter on **created_at** in the server timezone and that a mailbox the agent cannot
   view is silently widened to all viewable mailboxes (the tool compares and reports this).
2. `list_assignees` (new, read-only): the users in the search page's `f[assigned]` dropdown plus `unassigned`
   (`-1`). The agent sees only users FreeScout lets it see; admins may be missing, so any numeric id is still
   accepted by the filters.
3. `ticket_volume` (new, read-only): conversations **created** per period (`day` | `week` | `month`) in a date
   range, with one optional breakdown (`status` | `assignee` | `mailbox` | `none`) and optional mailbox / assignee
   filters. Implementation: one filtered `GET /search` per bucket × breakdown value, page 1 only, reading the tfoot
   total. Hard caps: ≤ 31 buckets, ≤ 10 breakdown values, ≤ 64 requests per call, requests run serially and paced
   (`FREESCOUT_STATS_DELAY_MS`, default 200 ms), published conversations only (caps and pacing revised after the
   2026-10-28 red-team review, docs/REDTEAM.md). The
   description says plainly what it is: counts of conversations created in the period with their **current**
   status/assignee; no resolved-per-day, no response times, no ratings.
4. No new POST path. Red-team scan stays at two `send_reply` and one `conversation_change_status` literals.

### Phase B — Reports module (protocol captured 2026-10-28, docs/freescout-endpoints.md §11)
Captured read-only through the user's own logged-in browser (Playwright, user logged in themselves; Claude never
typed credentials). Tools, all read-only, one report request (`POST /reports/ajax`) per call (the session layer
may retry it once after a CSRF refresh or re-login):
- `productivity_report`: `from`, `to`, optional `mailbox_id`, `user_id`, `type`, `tag_id`, `chart_metric`
  (`customers_helped|replies|closed`), `group_by` (`day|week|month`). Returns metrics with change-vs-previous,
  first-response / response-time distributions with averages, per-user table, and the chart series (labels passed
  through verbatim).
- `satisfaction_report`: same filters minus chart options. Returns rating counts, score, the Good/Okay/Not Good
  percentages and the rated conversations (number, id, date, user id, rating; customer name and comment only with
  `include_comments: true`, flagged as untrusted).
- `list_report_users`: users and mailboxes from `form#rpt-filters` (GET only).
Module or permission missing → a clear "not available" result (never zeros), pointing at `ticket_volume`.

## Architecture
```
Claude / MCP client  --stdio-->  freescout-mcp (Node/TS)
                                   ├─ session.ts   cookie jar + CSRF token + relogin
                                   ├─ client.ts    fetch wrapper, HTML/AJAX endpoints
                                   ├─ parsers/     cheerio parsers -> typed JSON
                                   └─ tools/       MCP tool definitions (zod schemas)
                                          |
                                          v  HTTPS, same requests the browser makes
                                   FreeScout web UI (Laravel)
```

### Session layer
- Seed a cookie jar from `FREESCOUT_COOKIE` (raw `Cookie:` header). Laravel re-issues the
  encrypted session cookie on every response, so the jar **must** accept `Set-Cookie` updates.
- CSRF: load any authenticated page, read `<meta name="csrf-token">`, send as `_token`
  (form posts) or `X-CSRF-TOKEN` header (ajax). Ajax routes also get `X-Requested-With: XMLHttpRequest`.
- Expiry detection: a 302 to `/login` or a login form in the body.
  - If `FREESCOUT_USER`/`FREESCOUT_PASSWORD` set: GET `/login` for `_token`, POST `/login`
    with `remember=1`, retry the original request once.
  - Else: return a clear "session expired, paste a fresh cookie" error.
- Password only from env; never logged or echoed in errors.

### Tools (v1)
Read:
- `list_mailboxes` — mailboxes the session can access (parsed from dashboard; never hard-coded ids)
- `list_conversations` — mailbox + folder (unassigned/mine/starred/closed/…), pagination
- `search_conversations` — FreeScout search box (`/search?q=`), with filters where the UI exposes them
- `get_conversation` — full thread: subject, customer, status, assignee, tags, every message/note with author, time, body (HTML→text), attachments meta
- `get_customer` — profile + recent conversations
- `list_saved_replies` — only if the paid Saved Replies module is installed (absent on demo; tool reports that cleanly)
- `whoami` — current user, permission summary, session health
- `list_assignees` — users from the search page's Assigned filter (added 2026-10-28)
- `ticket_volume` — conversations created per day/week/month from filtered searches, optional breakdown (2026-10-28)
- `list_report_users`, `productivity_report`, `satisfaction_report` — the paid Reports module, one guarded
  `POST /reports/ajax` per report call that only computes a report (2026-10-28, live-verified; see Phase B above)

Write (restricted):
- `add_note` — internal note on a conversation. The note type is **pinned in code**; the same
  FreeScout endpoint emails the customer when that flag is absent, so there is no code path that omits it.
- `save_draft` — save a reply draft (FreeScout "draft" ajax action). Draft is visible in UI for the human to review and send.
- `add_tag` — add tags to one conversation (paid Tags module). Add only; never removes.
- `remove_tag` — remove named tags from one conversation (added 2026-10-28).
- `close_conversation` — status → Closed only (added 2026-10-26).
- `forward_conversation` — one allow-listed recipient, only when `FREESCOUT_FORWARD_ALLOW` is set (added 2026-10-26).
- No `reply`/`send` tool exists, registered or not.

### Discovery (done before coding tools)
Routes and ajax action names are pulled from the running container
(`routes/web.php`, `ConversationsController::ajax`) into `docs/freescout-endpoints.md`.
Payloads come from that file, not from memory.

## Demo environment
- `demo/docker-compose.yml`: `tiredofit/freescout` + MariaDB sidecar, joined to the
  `wordpress-sites` proxy network with `VIRTUAL_HOST`/`LETSENCRYPT_HOST`.
- Seed: admin, mailboxes **Support** and **Billing**, user `agent@freescout.example.com` with access to
  **Support only**, several conversations in each. The MCP is tested as the restricted agent.

## Test plan
- Unit: parsers against saved HTML fixtures from the demo.
- Integration (against demo, as restricted agent): list mailboxes shows only Support;
  get_conversation returns full thread; add_note creates a thread of type **note** and no
  outbound email is queued (check the `send_logs` table: no row addressed to the customer);
  save_draft appears as draft in UI; expired cookie → clean error; with credentials → auto relogin.

## Out of scope (v1)
Replying to customers, changing assignee, reopening or marking spam, attachments upload.
(Statistics: Phase A search-derived tools and Phase B Reports-module tools in scope since 2026-10-28, merged as PR #9 and #10; Phase B live-verified against production the same day, docs/freescout-endpoints.md §11.4a.)
(Closing and forwarding: in scope since 2026-10-26, see above.) (Adding tags: in scope since
2026-10-25, implemented as `add_tag`; see above.)
(A multi-user Streamable HTTP transport was added later: see README "HTTP mode" and `deploy/`.)

## What next
Candidate next rounds (assign/pending/reopen, more reports, Slack digests) are listed with effort and risk in
`docs/ROADMAP.md` (2026-10-28). None is started.
