# Red-team review — freescout-mcp-with-cookies

Scope: adversarial review of the MCP server's core safety promise — it may read, add internal
notes, save/discard its own reply drafts and (since 2026-10-25) add tags (since 2026-10-28 also remove them), but must **never** send email to a customer, change
status, assign, forward, or delete anything except its own drafts.

Method: attacks driven through the real MCP operations against the live demo
(`https://freescout.example.com`) as the **restricted agent** (`agent@…`, Support mailbox only),
with before/after inspection of the `conversations`, `threads`, `send_logs` and `jobs` tables over
ssh; plus offline attacks on the guard functions and the session/cookie layer with a fake fetch.

Date: 2026-10-22. Reviewer scripts: `test/redteam/live-exploit.ts` (live) and the two
`test/redteam/*.redteam.test.ts` regression suites (offline, 13 tests, all passing).

## Verdict

**No exploitable finding.** Every attempt to send a customer email, change state/assignee, cross
the mailbox permission boundary, escape the draft confinement, or leak the session cookie/password
was **blocked**. The write path is defended in depth: Zod schemas reject malformed arguments at the
tool boundary; bodies are carried as a single URL-encoded form field (no field injection); the note
form is a fixed whitelist with `is_note:"1"` pinned last and an `assertNoteForm` hard-guard; drafts
are confined to real draft threads on the same conversation; and the session layer refuses
cross-origin requests/redirects and redacts secrets from every surfaced error.

The items below are ranked; all are **blocked** or **informational** (by-design) — none are
exploitable. Live DB evidence is summarised after the table.

## Findings

> Status after the follow-up fixes: I3 is addressed (plain `http://` to a non-local host is refused unless
> `FREESCOUT_ALLOW_INSECURE=1`; `user:pass@` is stripped), I4 results now carry a `content_notice` and the tool
> descriptions flag customer text as untrusted, and I5 is bounded by `get_conversation`'s `max_threads` (default 50).
> Write tools also refuse unsent draft conversations. The red-team suites run in the default `npm test`.

### Informational / low (by-design, worth noting)

| # | Area | Observation | Severity | Verdict |
|---|---|---|---|---|
| I1 | add_note → teammate email | A note on a conversation that a **teammate** is subscribed to (e.g. conv 6, assigned to admin) fires an internal `UserAddedNote` notification, which FreeScout attempts to email to that teammate. Confirmed: `send_logs` gained exactly one row to `admin@freescout.example.com` (mail_type 2, status 2 = failed, outgoing mail disabled). **Never addressed to a customer.** This is documented in `docs/freescout-endpoints.md §5.1` and is inherent to FreeScout's note feature. | Info | By design |
| I2 | get_customer PII | The agent can read the **profile** (name, email, company) of a customer whose only conversations are in Billing (`get_customer(10)` / by email). Their Billing conversations are correctly hidden (empty list). FreeScout customer records are global unless `limit_user_customer_visibility` is set; documented in `§4.4`. Minor cross-mailbox PII disclosure. | Low | By design (note it) |
| I3 | http:// base URL | `config.ts` accepts an `http://` `FREESCOUT_URL`; the cookie is then seeded without `Secure` (`session.ts seedCookies`) and sent in cleartext. Operator-controlled, not attacker-controlled, but a hardening opportunity (reject/ warn on non-TLS when a cookie is configured). | Low | Hardening |
| I4 | Untrusted content passthrough | `get_conversation` returns injected subject/body (prompt-injection strings, `[system]` blocks, zero-width/BOM chars) verbatim **as data**. `<script>/<style>/<iframe>` are stripped by `htmlToText`; `javascript:`/`onclick` are flattened to text. Nothing is executed. Output does **not** demarcate where untrusted content begins (acceptable per brief; an LLM consumer should still treat thread bodies as untrusted). | Info | Acceptable |
| I5 | Thread-count flooding | `get_conversation` caps each body via `max_body_chars` (honored: cap 50 → body length 52 incl " …", `body_truncated:true`) but does not cap the **number** of threads returned. Bounded by how many messages a conversation actually has; not a practical DoS. | Info | Acceptable |

### Blocked attacks (attempted, defense held)

Send / state-change vectors:
- **Body field-injection** — `add_note` body `RT…&is_note=0&subtype=1&thread_id=99&to=victim@evil.example`, and CRLF/null-byte variants. Blocked: body is one `URLSearchParams` field, fully percent-encoded; DB shows threads 26–28 all `type=3` (note), `subtype=NULL`. No send.
- **subtype/thread_id/to smuggling into the note form** — impossible: `buildNoteForm` emits a fixed 7-key set with `is_note:"1"` last; `assertNoteForm` throws on `is_note!="1"`, any `subtype`/`thread_id`/`to`/`cc`/`is_create`, or any unexpected key.
- **Malformed conversation_id** (string/float/negative/array/object/`__proto__`) — rejected by `z.number().int().positive()` before any operation runs.
- **add_note changing status/assignee** — `add_note` re-reads the page and sends the current `status`/`user_id` verbatim. Confirmed live on conv 6 (assigned admin, active), conv 3 (pending, assigned agent), conv 7 (pending, unassigned): `conversations.status` and `user_id` unchanged after the note in every case.
- **save_draft publishing / sending** — `save_draft` never sends; `buildDraftForm` never emits `is_note`/`subtype`/`is_create`.
- **discard_draft deleting a whole conversation** — refused unless the conversation has published threads; the agent cannot create a draft-conversation (no `is_create` path).

Permission boundary (restricted agent, Billing = mailbox 2, convs 10–12):
- `get_conversation(10/11)` → `PermissionError` (403). `list_conversations(mailbox 2, …)` → 403.
- `list_conversations(mailbox 1, Billing folder id 9/10)` → refused (FreeScout silently falls back to Unassigned; the code detects `li.active` ≠ requested id and throws).
- `search_conversations('invoice', mailbox_id=2)`, `'VAT'`, `'#10'` → empty (no Billing leakage).

Draft confinement:
- `discard_draft(conv=9, thread=<draft on conv 1>)` and `save_draft(conv=9, update=<draft on conv 1>)` → `Thread … is not on conversation 9`.
- `save_draft(conv=1, update=<note thread 26>)` → `… is a note thread, not a draft; refusing`.
- `discard_draft(conv=1, thread=<customer thread 1>)` → `… is a customer thread, not a draft; refusing`.

Session / secrets (offline, fake fetch):
- **Cross-origin redirect** (302 → `https://evil.com`) is not followed; cookie never sent to the other origin; final URL stays on the FreeScout origin.
- **resolve()** throws `Refusing cross-origin URL` for an absolute off-origin path.
- **Cross-domain `Set-Cookie`** (`Domain=evil.com` / `attacker.net`) is dropped by the tough-cookie jar.
- **Non-JSON ajax reply** that echoes the cookie → clean `did not return JSON` error, secret not present.
- **Redaction** masks the seeded cookie value and the `Cookie:`/`Set-Cookie:`/`_token=` patterns; debug-level stderr logs only `METHOD /path` (no query strings, cookies, or tokens). The agent password never appeared in stdout/stderr.

## Tags (2026-10-25)

Protocol verified from a production install's JS bundle and pages (docs/freescout-endpoints.md §9).

- **`add_tag` guard.** The only tag write is `POST tags/ajax` with `{action:"add", tag_names:[…], conversation_id}`.
  `assertTagForm` runs right before the POST and throws unless the keys are exactly those three, `action` is `add`,
  `conversation_id` is a single positive-integer **string** (an array is refused by type, not just by pattern), and
  `tag_names` is 1 to 10 trimmed names of 1 to 50 characters with no commas, control characters or case-insensitive
  duplicates. The Zod schema already rejects arrays/strings for `conversation_id` and bad tag lists at the tool
  boundary. Names are posted only after dropping those already on the conversation.
- **Why the guard matters (residual risk).** To send `tag_names[]`, `Session.ajaxPost` now serialises array values as
  repeated `key[]` pairs. The same endpoint treats an array `conversation_id` as **bulk tagging** of every listed
  conversation, and `action=remove` removes a tag. If the guard were bypassed (a new caller posting to `tags/ajax`
  without `assertTagForm`), an array id could tag many conversations at once. The only other array in
  `src/` is the forward form's `to_email` (added 2026-10-26, exactly one element, pinned by `assertForwardForm`);
  `buildNoteForm`/`buildDraftForm` stay `Record<string,string>`; the remaining risk
  is a future code change, covered by the `assertTagForm` tests and the HTTP test that asserts the exact wire form.
- **Additive, verified after.** `add` never resends or removes existing tags. After posting, the conversation is
  re-read; a previous tag that vanished raises a `DANGER` error, a requested tag that does not appear raises an error
  with the before/after lists (server-side `Tag::normalizeName` is compared trimmed and case-insensitively).
- **No other state.** `add_tag` sends no status, assignee, customer or thread field, and refuses unsent draft
  conversations and pages without the module's markup (demo: refused with no POST).
- **`remove_tag` (2026-10-28).** Posts `{action:"remove", tag_name, conversation_id}` once per tag, only for names
  currently shown on the conversation (sent exactly as shown). `assertTagRemoveForm` runs before each POST: exact keys,
  `action` is `remove`, a single string `tag_name` (an array is refused) and a single positive-integer string id (no
  bulk form). After the POSTs the conversation is re-read: a removed tag still shown is an error, and any other tag
  that vanished raises `DANGER`. A source-scan red-team test pins `action: "remove"` to one builder and its POST.
- **`list_tags`** is read-only: GETs, plus the `autocomplete` action when `q` is given. Tag names are agent-chosen
  labels, returned as data.

## Close & forward (2026-10-26)

Scope change: two writes added. `close_conversation` (status → Closed) is always registered; `forward_conversation`
(outbound email to a third party) is registered only when the operator sets `FREESCOUT_FORWARD_ALLOW`. The
"never change status / never forward" promise above is replaced by: never reopen, set pending/spam or reassign;
forward only to an operator allow-list, never to the customer. Protocol read from the FreeScout source
(`ConversationsController::ajax`, `Conversation::changeStatus/sanitizeEmails`), docs/freescout-endpoints.md §5.4/§5.5.

Attack surface:
- **Status value.** `conversation_change_status` accepts any status (1 active = reopen, 2 pending, 4 spam,
  `not_spam`). Guard: `buildStatusForm` only produces `status:'3'`; `assertStatusForm` (right before the POST) throws
  on any other status, any extra key (`user_id`, `x_embed`), any other action and an array/non-integer id. No other
  code in `src/` names `conversation_change_status`; a source-scan test pins that (`send-boundary.redteam.test.ts`).
- **Assignee change on close.** `changeStatus` does not touch `user_id`; the form has no `user_id`. Post-read checks
  the assignee anyway (`DANGER` on change) and that only a lineitem (or inbound customer thread) appeared.
- **Forward recipient injection.** `to_email[]` goes through `Conversation::sanitizeEmails()`, which turns
  `Name <email>` / `Name email` into a Customer with that name, and `MailHelper::sanitizeEmails` splits lists.
  Guard: the recipient is trimmed/lowercased, refused if it has whitespace, control characters, `<>`, `,`, `;`, `"`,
  more than one `@` or fails a strict single-address regex; `assertForwardForm` re-checks that `to_email` is an array
  of exactly ONE such string. All refusals happen before any network request.
- **Allow-list bypass.** `FREESCOUT_FORWARD_ALLOW` comes from the server environment only (stdio and HTTP; no header,
  no tool argument). Entries are validated at startup (malformed or `*` → refuse to start). `@domain` matches the exact
  domain after the last `@` (`x@notteam.example`, `x@team.example.evil.net`, `x@sub.team.example` are refused).
  The allow-list check runs before the page is read, so a prompt-injected request costs zero requests.
- **Forwarding to the customer.** An allow-listed address could still be the customer (e.g. `@company` domain shared
  with a client). Guard: refused when it equals the conversation's customer email or any To/Cc on customer messages,
  replies or drafts (notes are skipped, they hold internal recipients).
- **Degrading into a customer reply.** `send_reply` without `is_note` and without `subtype` is a customer reply.
  Guard: the forward form pins BOTH `is_note:'1'` and `subtype:'1'`; dropping `subtype` would yield a plain internal
  note (server: `if ($is_note || $is_forward) type = NOTE`; events check `is_forward` before `is_note`), never a reply.
  `assertNoteForm` still rejects `subtype`, so the note path cannot become a forward. Every `send_reply` on the wire
  is either the note shape or the forward shape (wire-level test through the MCP tools).
- **Side channels in the form.** `cc[]`/`bcc[]` would be copied onto the forwarded conversation, `thread_id` publishes
  a draft, `is_create`/`multiple_conversations` create new conversations: all rejected as unexpected fields.
  Bodies travel as one URL-encoded field (smuggling test with `&subtype=&to_email[]=…&cc[]=…` in the body).
- **State drift.** `status` and `user_id` are the conversation's current values; the post-read requires both
  unchanged and exactly one new note; any new `message`/`draft` thread → `DANGER` (FreeScout's 15 s undo window is
  the only remedy, named in the error).
- **Residual risks (by design).** A forward is irreversible after ~15 s; it creates a Customer record for the
  recipient; FreeScout may include conversation history per the mailbox default (`conv_history` is not sent); an
  over-broad `@domain` entry is the operator's choice. The forward-note markup (`.thread-badge`, child `#number`) has
  not been captured from a live page yet; detection is best-effort and only produces a warning when missing.
- **Untested live.** Whether `is_note=1` together with `subtype=1` still creates the forwarded conversation on a real
  install is to be verified on the demo (the source says yes).

### Red-team review of close & forward (2026-10-26)

Scope: the uncommitted diff on `feat/close-and-forward` (`src/forward-allow.ts`, `src/tools/{close,forward}-conversation.ts`,
`closeConversation`/`forwardConversation` in `src/operations.ts`, `forwardInfo` in `src/parsers/conversation.ts`,
config/HTTP wiring, tests). Method: FreeScout source read (`ConversationsController::ajax` 649-1330,
`Conversation::sanitizeEmails/changeStatus`, `Thread::getCleanBody`), throwaway `tsx` scripts in `/tmp/rt/` driving the
real `Session` + `FreeScoutClient` against `test/fake-freescout.ts` (with a wrapping port to simulate a teammate acting
mid-call, a failed re-read, or FreeScout ignoring `subtype`), and mutation testing of the guards in a scratch copy.
`npm run build` and `npx vitest run` are green (183 passed, 15 skipped).

**Verdict: no way found to email anyone outside the allow-list, reopen/spam/reassign via `close_conversation`, or
degrade a forward into a customer reply.** Four real weaknesses, all in the post-verification and customer-side
layers, plus test gaps.

| # | Area | Finding and reproduction | Severity | Minimal fix |
|---|---|---|---|---|
| F1 | forward: stale status/assignee | `forwardConversation` posts the **pre-read** `status`/`user_id`. If a teammate changes them between the page GET and the POST, FreeScout applies ours (`$conversation->status = $request_status ?: …`; `user_id == -1` → `user_id = null`; else reassign if different), firing `ConversationStatusChanged`/`UserChanged`. The post-read compares to the same stale pre-read, so it sees "unchanged" and reports **success**. Repro (`/tmp/rt/race.mts`, port wrapper mutates the fake before `ajaxPost`): conv 9 active → teammate closes → forward returns success with `status:"active"`, conversation reopened. Unassigned conv → teammate assigns user 8 → wire `user_id=-1` → conversation silently unassigned, success. `add_note` has the identical pattern (pre-existing). | Medium | Count `lineitem` threads before/after (they have no thread id, so `known` cannot see them). A forward never creates one, so `after.lineitems > before.lineitems` means someone else changed status/assignee and our values may have overwritten theirs: return an error/`warning` telling the human to re-check status and assignee. Same for `add_note`. |
| F2 | forward: customer check fails open | `customerSideEmails` adds `conv.customer?.email` only if the snippet parsed; `requireWritable` does not require it. With the customer snippet absent (layout change, theme/module, phone/custom conversation), an allow-listed customer address passes. Repro (`/tmp/rt/verify.mts` (a)): `addConv(9,{customer_email:"buyer@team.example"})`, port strips `#conv-layout-customer`; `forwardConversation(…, "buyer@team.example", …, ["@team.example"])` → **forwarded**, `fs.forwards=[{conversation_id:9,to:["buyer@team.example"]}]`. Also: the snippet shows only the customer's main email, so a conversation whose `customer_email` is a secondary address is only caught if an agent reply's `To:` shows it (not demonstrated live; no multi-email fixture). | Medium | In `forwardConversation`, throw when `before.customer?.email` is null (fail closed; exempt custom-type conversations explicitly by `conv.type` if needed). Optionally also refuse when the conversation has no agent reply yet and the customer email cannot be confirmed. |
| F3 | forward: retry after a failed re-read | If the POST succeeded but the post-read throws (HTTP 502, timeout), the tool error is just `Error: FreeScout /conversation/9 returned HTTP 502`, with nothing saying the forward was probably sent. An LLM will retry and send a second email and a second "Fwd:" conversation. Repro (`/tmp/rt/postread.mts`): second `getHtml` throws → tool text `"Error: FreeScout /conversation/9 returned HTTP 502"`, `fs.forwards` already has the send. A POST that times out after FreeScout processed it behaves the same. (Session itself only re-sends after 419/logged-out, where FreeScout did not process the request; blocked.) | Medium | Wrap the `ajaxPost` and post-read in `forwardConversation` (and `closeConversation`) in try/catch and rethrow as `FreeScoutError("The forward may already have been sent to <to>; do NOT retry. Check conversation N in FreeScout. (<cause>)")`. |
| F4 | forward marker spoofable from the body | `forwardInfo` searches `.thread-badge` anywhere in the thread, including `.thread-body`; `sanitizeHtml` keeps `class`/`title` (HTMLPurifier does too). The marker's only job is to warn when FreeScout stored a plain note instead of forwarding. Repro (`/tmp/rt/verify.mts` (b), port drops `subtype`/`to_email` so the fake stores a plain note): body `fyi` → `forward_marker_seen:false`, warning; body `<p>fyi <span class="thread-badge" title="Forward">.</span></p>` → `forward_marker_seen:true`, **no warning**. Requires a hostile body from the LLM plus a server that ignores `subtype`, so impact is a misleading result, not a send. | Low | Filter badges with `!x.closest(".thread-body").length` (as is already done for the `#N` link), and test the header-text fallback the same way. |
| F5 | tests: post-verification checks untested | Mutation testing (scratch copy, full `vitest run`): these edits leave **all tests passing**: M1 `"Status already set"` race branch in `closeConversation` → `false`; M4 `forwardInfo` body-link exclusion removed; M7 close post-read `status_value !== STATUS_CLOSED` check removed; M8 forward `status` DANGER removed; M9 close `assignee` DANGER removed. (Killed: customer email / thread To-Cc in `customerSideEmails`, "no forward note" check.) | Low | Add fake `misbehave` switches: `statusNoop` (accept but do not change status) for M7; `statusReassigns` for M9; `forwardChangesStatus` for M8; a test that sets the status to 3 before the POST (port wrapper or `misbehave.closedMeanwhile`) for M1; a forward note whose body contains `<a href="/conversation/99">#99</a>` for M4; plus F1-F4 regression tests. |

**Fixes (2026-10-26)** (regression tests in `test/status-forward.test.ts`, fake switches in `test/fake-freescout.ts`):
- **F1:** `lineitem` threads are counted before/after. `forwardConversation` and `addNote`: any new one → success with
  `concurrent_change_detected: true` and a `warning` to re-check status and assignee (no error: the forward/note is
  stored and an error would invite a retry). `closeConversation`: more than one new status line → same flag/warning.
- **F2:** `forwardConversation` refuses before the POST when the page shows no customer email (fail closed).
- **F3:** after the forward POST is dispatched, a throwing `ajaxPost` (network/timeout/HTTP/non-JSON), an envelope
  that is not a clean `status:"error"` with a message, or a failed re-read is rethrown as
  `POSSIBLY SENT: the forward to <to> on conversation N may already have gone out. Do NOT retry …`.
  `PermissionError`/`AuthError` (middleware answers, request not processed) and FreeScout's own error envelope keep
  their normal errors. The post-read `DANGER`/"no forward note" errors now also say not to retry. Not applied to
  `closeConversation` (idempotent: a retry hits the already-closed path).
- **F4:** `forwardInfo` ignores `.thread-badge` and header-like elements inside `.thread-body`.
- **F5:** tests added for M1 (`misbehave.teammate` closes before the POST), M4 (`forwardHidesChildLink` + `#99` body
  link), M7 (`statusNoop`), M8 (`forwardChangesStatus`), M9 (`statusReassigns`), plus F1–F4 and the items below.
  Each was checked by deleting its guard: the M1, M4, M7, M8, M9, F1 (forward), F2, F3 (re-read wrap) and F4 (badge filter) tests then fail. The F4 header-text filter is defensive only (the real header precedes the body).
- **Info → fixes:** Spam (status 4) conversations are refused by `close_conversation` before any POST. The recipient
  local part is now `[a-z0-9._+-]` only (no leading/trailing/consecutive dots), so `victim%evil.example@…` and
  `evil.example!victim@…` are refused. `parseForwardAllow` refuses `@domain` entries for well-known free-mail
  providers and a small list of public suffixes (`@co.uk`, `@com.au`, …); exact addresses there remain allowed.
  Still by design: the English-only "Status already set" match, the close-race `DANGER` false alarm on a teammate
  reassign, the allow-list in the tool description.

Informational (tested, by design or operator choice):
- **Spam → Closed.** `closeConversation` closes any status other than 3, including Spam (4), which moves a spam conversation
  back into the mailbox as Closed (un-spam). Not reopening, no email; refuse `status_value === 4` if that is unwanted.
- **Local-part routing characters.** With an `@team.example` entry, `victim%evil.example@team.example` and
  `evil.example!victim@team.example` (also `a/b=c?d@…`, `-@…`) are accepted. Only dangerous if team.example's MTA honours
  `%`/bang relaying (rare today). Tightening `LOCAL` to `[a-z0-9._+-]` costs nothing.
- **Over-broad domains accepted.** `parseForwardAllow("@gmail.com")` and `"@co.uk"` succeed; an operator who allow-lists a
  free-mail or public-suffix domain lets the LLM forward to anyone there. Consider refusing a small built-in list of
  free-mail domains and public suffixes, or warning at startup.
- **Locale.** The `"Status already set"` match is English-only; on a translated UI the race returns a plain error (fail-safe).
- **Close race false alarm.** A teammate reassigning between pre-read and post-read makes `close_conversation` report
  `DANGER … Closing never reassigns` although the close did not cause it (fails loud; no harm).
- **Allow-list in the description.** `forward_conversation`'s description lists the allow-list entries (and the startup log
  line does too). That is configuration, visible to anyone holding the bearer token; nothing else (no cookie/token/body).
- **Logging.** New error strings contain the normalised recipient, conversation id, thread ids, statuses and assignee ids;
  never the body, cookie or CSRF token. `normalizeRecipient` refuses control characters before any message echoes `to`, so
  no log-line injection.

Blocked (attempted, defence held):
- **close_conversation arguments** (MCP client against the tool): `"9"`, `[9]`, `9.5`, `-9`, `0`, `true`, `1e20`, `1e21`,
  `2^53+1` → Zod `-32602`, **0 requests**. Extra args `{conversation_id:9,status:1,user_id:8}` are stripped; the only wire
  form ever posted was `[["action","conversation_change_status"],["conversation_id","9"],["status","3"]]`
  (`assertStatusForm`: exact key set, `status === "3"`, `/^[1-9]\d*$/` id).
- **Other conversation.** `loadConversation` refuses a page whose `data-conversation_id` differs or that ended on a
  non-`/conversation/N` path (login redirect); 403 → `PermissionError`. All fail closed before the POST.
- **Recipient shapes** (all refused before any request by `normalizeRecipient`/`isStrictRecipient`): `Name <a@b>`,
  `Name a@b`, lists with `,`/`;`/space/newline, `"q"@…`, NUL, ZWSP, `%0a`, `x[]@…`, `x&cc[]=y@…`, raw IDN (`tеam` with
  Cyrillic е), trailing dot `x@team.example.`, `.x@`/`x.@`, IP literals, `a@b@c`. Uppercase is lowercased; `+tag` against an
  exact entry is refused (`ops+x@internal.example`); `x@sub.team.example` and `x@team.example.evil.net` are refused for
  `@team.example` (exact domain compare); punycode only matches a punycode entry.
- **Forward extra args / body smuggling.** `forward_conversation` with `cc`, `bcc`, `thread_id`, `subtype:0`, `is_note:0`
  → stripped by Zod; body `a&b=c%26[]=\u0000\n… to_email[]=v@evil.example` travels as one encoded `body` field; wire was
  exactly `action, conversation_id, mailbox_id, body, user_id, status, is_note=1, subtype=1, to_email[]=lead@team.example`.
- **Dropped `is_note`/`subtype`, two recipients, cc/bcc/thread_id/is_create/multiple_conversations** in the form →
  `assertForwardForm` throws (exact key set, `Array.isArray(to_email) && length === 1`, every other value a string).
- **FREESCOUT_FORWARD_ALLOW parsing.** `*`, `@`, `@.com`, `@com`, `a@b@c`, `x;y` entries throw at startup; empty/`" , ,"`
  → `[]` (tool unregistered); BOM, tabs, CRLF and newline separators parse to the intended entries.
- **HTTP mode.** The allow-list is `Object.freeze`d once from the server env (`http-server.ts`) and shared read-only; no
  header (`X-FreeScout-Forward-Allow`, `X-Forward-Allow`) or initialize param reaches it (http.test). With an empty list
  `forward_conversation` is absent from `tools/list` in both transports and calling it by name returns a clean MCP error with
  no POST.
- **Prompt injection asking for a forward** to an off-list address: refused with **zero** requests (allow-list checked
  before the page read).
- **Customer HTML faking threads/status.** Thread parsing takes only direct children of `#conv-layout-main`, and status /
  assignee come from the first `#conv-status`/`#conv-assignee` in document order (toolbar precedes threads). A raw,
  unbalanced `</div>…<div class="thread thread-type-message">` breakout (only possible if FreeScout did not purify; it does,
  `Thread::getCleanBody` → `Helper::purifyHtml`) produced a `DANGER` false alarm, never a false success.
- **Re-send by the session layer.** `Session.send` only repeats a request after a logged-out answer or a 419, i.e. when
  FreeScout did not process it; there is no network-error retry, so a forward POST is never sent twice by the client.

## Live DB evidence (abridged)

Baseline before attacks: `send_logs` = 0 rows, `jobs` = 0, conv 1 `user_id=NULL status=1`, conv 6 `user_id=1 status=1`.

After the full attack run (notes 26–29, draft 30, notes 32–33):
```
threads 26..29  -> type=3 (NOTE), state=2, subtype=NULL      (thread 30 = draft: type=2,state=1)
conversations   -> conv 1 user_id=NULL status=1 (unchanged); conv 6 user_id=1 status=1 (unchanged);
                   conv 3 status=2 user_id=2 (unchanged);     conv 7 status=2 user_id=NULL (unchanged)
send_logs       -> 1 row: admin@freescout.example.com, mail_type=2, status=2 (failed), thread_id=29
                   (internal teammate notification for the note on admin-assigned conv 6; NOT a customer)
send_logs to customer (.example) addresses -> 0 rows
```

## Reproduce

- Offline regression suites (no creds): `npx vitest run test/redteam/`
- Live attack driver (writes to the demo; reset afterwards):
  `FREESCOUT_URL=… FREESCOUT_USER=agent@… FREESCOUT_PASSWORD=… npx tsx test/redteam/live-exploit.ts`
- Prompt-injection output-safety check: seed malicious subject/body into a Support conversation via
  the demo DB, then `get_conversation` it and confirm the content returns as inert data.
- Reset the demo when done: `demo/reset.sh`.

## 2026-10-28 — search filters, list_assignees, ticket_volume, HAR sanitizer

Scope: branch `feat/search-stats` (read-only search filters, `list_assignees`, `ticket_volume`, the Phase B HAR
sanitizer). Method: static reading, stub ports and crafted HARs, the FreeScout 1.8.248 source in the demo container
(read only), and read-only `GET /search` probes on the demo as the agent. Production was not touched. No new
POST path: `ticket_volume` hands the search code a port whose `ajaxPost` always rejects; the source scan still finds
exactly two `action: "send_reply",` and one `action: "conversation_change_status",` literals.

| # | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| H1 | High | `q:"#N"` with any filter (or `mailbox_id`) makes FreeScout answer HTTP 500 (number shortcut + `->links()` on an array); after a session expiry the 500 on the intended URL is reported as a failed login and counts toward the lockout | `q` matching `^#?\d+$` with any filter or `mailbox_id` is sent as `f[number]=N` (never as `q`), result notes "searched by conversation number"; without filters the redirect path is kept. The fake answers 500 to the bad shape; unit, fake and live tests | Fixed |
| H2 | High | Every `/search` also runs FreeScout's customer search (`LIKE '%%'` over the customers table); 124 back-to-back requests per call is real production load | Cap lowered to 64 requests per call; pause between consecutive requests, `FREESCOUT_STATS_DELAY_MS` (default 200 ms, 0 allowed); cost documented in §10.1, README and the tool description | Fixed |
| H3 | High | `ticket_volume` counted deleted conversations and unsent drafts (no default state in `Conversation::search`) | Every `ticket_volume` request sends `f[state][]=2`, recorded as `filters.state: ["published"]`, stated in note and description. `search_conversations` keeps UI parity; its description says deleted/drafts are included unless `state` is given | Fixed |
| M1 | Medium | A 200 page that is not a search result (dashboard, module, maintenance page) was counted as 0 | After every search GET the final path must end in `/search` (base sub-path allowed) and the page must have `table.table-conversations` or `.empty-content`; otherwise `FreeScoutError("unexpected page …")`. Applied to search_conversations, list_assignees, ticket_volume | Fixed |
| M2 | Medium | A server-forced `assigned` (agents limited to their own conversations) silently corrupted assigned filters and the assignee breakdown (`Math.max` hid a negative "other") | The `selected` option of `f[assigned]` is compared with the request; a differing non-empty value returns `assigned_filter_forced` plus a note in both tools. Assignee buckets whose sum exceeds the total get `inconsistent: true` and a note, and no `other` (never clamped) | Fixed |
| M3 | Medium | A failure mid-run threw away all finished buckets, so a retry doubled the load | Errors inside the bucket loop return the finished buckets with `incomplete: true`, `error` (class + redacted message) and `requests_made`; the note says not to retry blindly. Pre-loop failures (validation, discovery) still throw | Fixed |
| M4 | Medium | The HAR sanitizer leaked secrets: multipart bodies, HTML inside JSON strings, nested/suffixed keys (`user[password]`, `password_confirmation`, `csrf_token`, `X-CSRF-TOKEN`), blobs in HTML attributes, `text/plain` `_token=` bodies | Fail-closed rewrite: name-pattern blanking at any depth (token, password, passwd, secret, csrf, xsrf, api_key/apikey, auth, cookie, remember, session), multipart parsed by boundary (no boundary = body removed), HTML scrubbed inside JSON and text bodies, blobs (80+ chars) removed everywhere, every secret value seen is removed wherever else it appears and the script refuses to write if one survives; refuses output == input; binary bodies dropped. Regression tests use the reviewer's shapes with a distinct secret per shape | Fixed |
| L1 | Low | `q: ""` was a zod error instead of "absent" | Schema allows empty `q`; `buildSearchParams` drops it (q-or-filter rule unchanged) | Fixed |
| L2 | Low | A missing mailbox dropdown was reported as "filter applied" | `mailbox_filter_ignored: null` plus a "could not verify" note, in both tools | Fixed |
| L3 | Low | §10 said "no tfoot → 0"; the code counts rows (or throws with a next page) | Sentence corrected in §10 "What the MCP does" | Fixed |
| L4 | Low | The 6-value cap made `breakdown=assignee` fail on most real teams | Value cap raised to 10 (the 64-request cap still bounds it); the cap error spells out the formula (`buckets x (values + 1) must be <= 64` for assignee) and suggests a coarser period or an `assigned`/`mailbox_id` filter | Fixed |
| L5 | Low | `customer_id` description incomplete | Says it also matches conversations where the customer only replied | Fixed |
| I1 | Info | Years 0000-0099 rejected (`Date.UTC` two-digit-year quirk) | `setUTCFullYear` | Fixed |
| I2 | Info | search_conversations includes other agents' drafts and deleted conversations | Documented in the description and README (see H3) | Fixed (documented) |
| I3 | Info | Sanitizer output outside `captures/` is not git-ignored; same in/out path overwrote the raw HAR | Same path refused (resolved and real paths); a note on stderr when the output is outside `captures/`. Whole-file `readFileSync` kept (a normal capture is small) | Fixed / accepted |
| I4 | Info | Base64 binary bodies decoded as UTF-8 garbage | Non-text MIME bodies replaced by `[binary body removed: <mime>]` | Fixed |
| I5 | Info | A 500 on the post-login intended URL is reported as "login failed" and counts toward the lockout (pre-existing in `session.ts`) | H1 removes the trigger this branch added; the session behaviour itself is unchanged | Open |

Verified held (reviewer): no POST path added, registry name check exact, strict dates across timezones, caps checked
before requests, serial requests, exact wire forms, empty-page fixture, dropped-mailbox detection, fake changes
additive, reports-capture.md states nothing about the Reports module as fact.

Live re-check after the fixes (demo, as the agent): `ticket_volume` 2026-10-23..26 by day = 1, 1, 1, 4 (all demo
rows are published); by assignee on 10-26 = agent 1, unassigned 2, other 1; `search_conversations {q:"#9",
status:["active"]}` → [9] via `f[number]`, `{q:"#9", status:["closed"]}` → 0.

## 2026-10-28 — Phase B: Reports module (productivity_report, satisfaction_report, list_report_users)

Scope: branch `feat/reports-module`. Method: static reading and offline tests (stub ports, the fake FreeScout serving
the scrubbed §11 fixtures). No live test: the demo has no Reports module, and production was not contacted.

**This phase deliberately adds one POST site.** Phase A's rule was "no new POST path"; the Reports module cannot be
read without `POST /reports/ajax`, the request FreeScout's own report page sends. That POST only computes a report
(no state change in FreeScout). The boundary is:
- one `/reports/ajax` literal in `src/` (`REPORTS_AJAX`, `src/reports.ts`) and one `ajaxPost` call site using it;
- `assertReportForm`, run when the form is built and again right before the POST, allows exactly
  `{action:"report", report_name: productivity|satisfaction, filters:{type: ''|1|2|3, mailbox: ''|positive int,
  [user: positive int, absent for all users], tag: ''|positive int, period:"custom", from, to}, [chart:{group_by:
  d|w|m, type: customers_helped|replies|closed}]}`. `action` is pinned to `report`; `period` to `custom`; `from`/`to`
  are strict real dates, `from <= to`, at most 366 days; `chart` is refused on satisfaction; any other key, nested
  key, value or type throws before any request;
- `list_report_users` sends no POST; an unavailable module never reaches the POST.

Regression tests (`test/redteam/send-boundary.redteam.test.ts`, "the one Reports POST"): the source scan finds one
`/reports/ajax` literal, two `REPORTS_AJAX` references (definition + call), one `action: "report",`, and the
pre-existing two `action: "send_reply",` and one `action: "conversation_change_status",` literals unchanged;
`assertReportForm` refuses other actions (`export`, `delete`, `send_reply`, …), extra keys (`_token`, `status`,
`filters[user]` flattened, `filters.export`), other report names (`conversations`, `time-tracking`, …) and `chart` on
satisfaction; through the MCP tools every POST goes to `/reports/ajax` with `action=report`, `period=custom` and only
the pinned keys, and nothing reaches `/conversation/ajax` or `tags/ajax`.

Other points: an unavailable module (404 / 403 / redirect / no filter form) is a success-shaped `{available:false}`
with a pointer to `ticket_volume`, never zeros; envelope errors are tool errors with FreeScout's redacted `msg`;
customer names and rating comments are returned only with `include_comments: true` and labelled untrusted. Open: no
live verification of the guard's accepted shapes against a real install beyond the captured bodies (§11.2), and the
behaviour for a non-admin without report permission is still unobserved (handled as "not available" or AuthError).

**Fixes after review (2026-10-28).** An independent review of the branch found no Critical or High issue (the
one-POST boundary held). Every finding was fixed; tests in `test/reports.test.ts` ("review fixes") and the red-team
file. The red-team scan is now stronger: every `ajaxPost` call site in `src/` is counted (8) and must pass one of the
three path constants (`AJAX` = `/conversation/ajax` ×5, `TAGS_AJAX` = `tags/ajax` ×2, `REPORTS_AJAX` =
`/reports/ajax` ×1), besides the three definitions and the one client pass-through; the earlier counts are kept.

| Id | Severity | Finding (one line) | Fix | Status |
|---|---|---|---|---|
| M1 | Medium | Null/empty chart points and pie percentages became a silent 0 | Points are a finite number or a plain-number string, else `null` (series typed `(number\|null)[]`); pie percentages `null` when missing; a note when any point is null | Fixed |
| L1 | Low | `mismatch` raised on a matching chart when `group_bys` was absent | `available_group_bys: null` plus a note; mismatch only when `type`/`group_by` differ, or `group_bys` is present and lacks the group | Fixed |
| L2 | Low | Missing users table or non-English tables failed silently | `users: null` with a note; a note when the time tables are missing, saying the UI seems non-English when other tables exist; descriptions and `REPORT_NOTE` say keys come from the rendered (English) titles | Fixed |
| L3 | Low | Customer name dropped when the cell had no link | Name from the cell text, `id: null` | Fixed |
| L4 | Low | Users table mixed header matching with a positional fallback | Header match only; unknown headers kept verbatim under `extra_columns` (keyed by slug) with a note | Fixed |
| L5 | Low | A satisfaction 404 blamed only the Reports module | "Reports module not installed, or the Satisfaction Ratings module it needs is missing" | Fixed |
| L6 | Low | Final-path check used `endsWith` | Exact `<FREESCOUT_URL path>/reports/<name>` (port exposes `baseUrl`); tests for a satisfaction page redirected to `/reports/productivity`, a sub-path install redirected to the root, and a prefixed path | Fixed |
| L7 | Low | Five §11 doc statements disagreed with the code | Non-JSON ajax = tool error; previous period inferred; no pacing pause; raw captures deleted after scrubbing; the page's own `from` default explained (the MCP always sends both dates) | Fixed |
| L8 | Low | Untested branches; unused fake option | Tests: 500-rating cap (501 generated rows through the fake's `reports.answer`), no chart, label/series length mismatch, `filter_warnings` for user and tag, empty report, redirected satisfaction page | Fixed |
| I1 | Info | Chart keys sent on the default request, unlike the module's first request | No chart keys for the default (customers_helped by day): byte-identical to §11.2 bodies 1 and 4; both shapes asserted | Fixed (superseded 2026-10-31: chart keys are now always sent, see the review fixes below) |
| I2 | Info | "ONE POST" could be two (CSRF/session retry) | Wording: one report request per call; the session layer may retry it once after a CSRF refresh or re-login | Fixed |
| I3 | Info | A 403 on the report POST spoke of mailboxes/conversations | Reworded as a Reports module / report permission tool error (still not zeros) | Fixed |
| I4 | Info | Red-team scan did not whitelist every POST path | All `ajaxPost` call sites counted and checked against the three constants (see above) | Fixed |
| I5 | Info | Null-prototype and symbol-keyed objects passed `assertReportForm` | Exactly `Object.prototype` and no symbol keys, at every level | Fixed |
| I6 | Info | Year `0000` passed `parseStrictDate` | Shared `src/dates.ts` requires year ≥ 1970 (FreeScout's own fallback date); affects search, ticket_volume and reports alike; the old "years 0000-0099 are real dates" test now asserts refusal | Fixed |
| I7 | Info | Non-plain user-table values (e.g. "50%") lost their text | Metrics already keep `raw_value` (tested for the satisfaction score); users-table rows get `raw_values` when a cell is not a plain number, with a note | Fixed |

## 2026-10-31 — Phase C: agent_stats, conversations / time tracking reports (guard widened, no new POST path)

No new POST path or call site: the source scan still finds one `/reports/ajax` literal, two `REPORTS_AJAX` references,
one `action: "report",` and the unchanged `send_reply` / `conversation_change_status` / `tags/ajax` counts.
`assertReportForm` was **deliberately widened** and tightened at the same time:
- `report_name` may now also be `conversations` or `time` (the wire name of `/reports/time-tracking`; the slug
  `time-tracking` stays refused), both read-only reports FreeScout's own pages request the same way (§11.2 body 6);
- the filter keys are an exact per-report whitelist: `user` only for productivity and satisfaction; conversations and
  time refuse `filters.user` and any `chart`;
- `chart.group_by` is pinned to `d` (week/month series are no longer requested; periods are summed client-side).
`agent_stats` sends up to 31 report requests per call (one per bucket), all built and asserted before the first
request, serial and paced by `FREESCOUT_STATS_DELAY_MS`; it does not wrap the port (no extra `ajaxPost` occurrence).
Customer names and conversation subjects of the two new reports are returned only with `include_names: true` and
labelled untrusted; unrecognised tables are reported by shape only. Regression tests: the red-team file ("the one
Reports POST": refused names, per-report key whitelist, chart pinned to `d`, MCP calls of all report tools including
`agent_stats` with only pinned keys) and `test/agent-stats.test.ts`, `test/reports-conversations-time.test.ts`.

### Review fixes (2026-10-31, reports / agent_stats)
No new POST path or call site; the source scan now also pins the total `port.ajaxPost(` call sites in `src/` (9:
eight in `src/operations.ts`, `fetchReport` in `src/reports.ts`) besides the per-constant counts.

| # | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| 1 | Medium | `include_names: false` left unrecognised time-table columns (`extra_columns`, possibly customer-written) in the output | `extra_columns` dropped from time users / conversations / customers rows unless `include_names: true`; note and notice say so; test with injected Customer/Email columns. Conversations-report rows have no `extra_columns` | Fixed |
| 2 | Medium | With the default metric no chart keys were sent, so the series granularity was FreeScout's choice | Productivity requests always send `chart[group_by]=d&chart[type]=<metric>` (the browser's body 7 shape); guard still pins `d` | Fixed |
| 3 | Medium | `agent_stats` mid-run failure kept partial sums in `totals`/`user_totals`; session errors became success-shaped | Incomplete runs: `totals: null`, `user_totals: null` (buckets keep their data); `AuthError` and report 403s are rethrown as tool errors | Fixed |
| 4 | Low | `customers_helped` (distinct customers) summed across buckets | Dropped from `totals` and `user_totals`; per bucket only | Fixed |
| 5 | Low | The no-periods warning blamed length/grouping for a metric-only mismatch | Branched wording | Fixed |
| 6 | Low | §11.4c duration grammar narrower than the parser | Doc lists every accepted unit token | Fixed |
| 7 | Low | Reports scan counted only the `/reports/ajax` literal and its call | Total `port.ajaxPost(` call sites pinned (9) with a listing comment | Fixed |
| 8 | Info | Production conversation numbers / customer ids in report fixtures | Rewritten to synthetic ids (conversations 1001+, customers 501+) in fixtures and tests | Fixed |
| 9 | Info | PLAN Phase C item 2 still described `chart.raw` | Reworded to what was built | Fixed |
| 10 | New | `agent_stats` bucket `users: null` when a report has no users table (seen live for today) | `users: []` with a note | Fixed |
| 11 | Leftover | `FREESCOUT_STATS_DELAY_MS` comments named only `ticket_volume` | Mention `agent_stats` | Fixed |
