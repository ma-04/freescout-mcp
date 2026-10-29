# FreeScout web/ajax endpoint reference

Source: the running demo container (`nfrastack/freescout`, FreeScout **1.8.248**, Laravel 5.5), files under
`/www/html`: `routes/web.php`, `app/Http/Controllers/{ConversationsController,MailboxesController,CustomersController,UsersController,SecureController}.php`,
`app/Http/Controllers/Auth/LoginController.php`, `config/session.php`, `app/Http/Kernel.php`,
`resources/views/**`, `public/js/main.js`. Every "Observed" line was checked with curl against
https://freescout.example.com on 2026-10-22 while logged in as the restricted agent (Support mailbox only).

Fixtures (agent session; CSRF and clone-ticket tokens replaced with `*_REDACTED`. The `nonce=` attribute of
inline scripts was also replaced, but the CSP nonce in the `Content-Security-Policy` meta tag was not; it is a
per-response value with no use outside that page, so it does not need redacting):
- `docs/fixtures/mailbox-folder-mine.html`: `GET /mailbox/1/17` (Support / Mine, 3 rows)
- `docs/fixtures/conversation-9.html`: `GET /conversation/9?folder_id=17` (customer msg + note + reply)

All URLs are absolute against `APP_URL` (`https://freescout.example.com`). HTTP gets 301'd to HTTPS.

---

## 1. Constants (copied from source)

| Thing | Constant | Value |
|---|---|---|
| Thread type | `Thread::TYPE_CUSTOMER` / `TYPE_MESSAGE` / `TYPE_NOTE` / `TYPE_LINEITEM` / `TYPE_CHAT` | 1 / 2 / 3 / 4 / 8 |
| Thread type name (CSS `thread-type-*`) | `customer`, `message`, `note`, `lineitem`, `chat` | |
| Thread subtype | `Thread::SUBTYPE_FORWARD` / `SUBTYPE_PHONE` | 1 / 2 |
| Thread state | `Thread::STATE_DRAFT` / `STATE_PUBLISHED` / `STATE_HIDDEN` / `STATE_REVIEW` | 1 / 2 / 3 / 4 |
| Conversation status | `Conversation::STATUS_ACTIVE` / `PENDING` / `CLOSED` / `SPAM` | 1 / 2 / 3 / 4 |
| Conversation state | `Conversation::STATE_DRAFT` / `STATE_PUBLISHED` / `STATE_DELETED` | 1 / 2 / 3 |
| Conversation type | `TYPE_EMAIL` / `TYPE_PHONE` / `TYPE_CHAT` / `TYPE_CUSTOM` | 1 / 2 / 3 / 4 |
| Folder type | `UNASSIGNED` 1, `MINE` 20, `STARRED` 25, `DRAFTS` 30, `ASSIGNED` 40, `CLOSED` 60, `DELETED` 70, `SPAM` 80 | |
| User role | `User::ROLE_USER` / `ROLE_ADMIN` | 1 / 2 |
| Page size | `Conversation::DEFAULT_LIST_SIZE` | 50 |

Folder ids are per mailbox (and per user for Mine/Starred). Never hard-code them; read them from the sidebar
(`#folders li[data-folder_id]`) or dashboard links.

---

## 2. Login / session

### Routes
`Auth::routes()` plus explicit `GET|POST /login` (`config('app.login_path')` = `login`). Logout is `POST /logout` (`_token` required).

### GET /login
- Form: `<form class="form-horizontal margin-top" method="POST" action="https://…/login">`
- Fields (from `resources/views/auth/login.blade.php`):
  - `_token` (hidden, from `{{ csrf_field() }}`); same value is in `<meta name="csrf-token" content="…">`
  - `email` (`type="email"`)
  - `password`
  - `remember` (checkbox; any non-empty value enables remember-me)
- Observed: response sets `laravel_session` only.

### POST /login
`application/x-www-form-urlencoded`: `_token`, `email`, `password`, `remember=on`. Must send the `laravel_session`
cookie received with the GET (the token is bound to that session).

| Case | Observed response |
|---|---|
| Success | `302 Location: https://…/home` (then `/home` → `302` to `APP_URL` = dashboard). Sets new `laravel_session` + `remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d` (Max-Age 157680000 = 5 years). |
| Wrong password | `302 Location: https://…/login`; the next `GET /login` contains `<span class="help-block"><strong>These credentials do not match our records.</strong>` |
| Missing/stale `_token` | `419` HTML "Page Expired" |
| Throttle | `LoginController::$decayMinutes = 10`, Laravel default `maxAttempts` 5 → lockout message on the login form |

### Cookies
| Cookie | Notes |
|---|---|
| `laravel_session` | Name = `str_slug(env('APP_NAME','laravel'),'_').'_session'`; APP_NAME not set in env, so `laravel_session`. `secure; httponly; path=/`, `Max-Age=7200`. |
| `remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d` | Only when `remember` was posted. Lets the server silently re-authenticate after the session dies. |
| `XSRF-TOKEN` | **Not set** by this install (observed on login, GET pages and ajax). Use the meta tag instead. |

### Session behaviour (`config/session.php`)
- `driver` `file`, `lifetime` `env('SESSION_LIFETIME', 120)` → **120 minutes idle**, `expire_on_close` false,
  `secure` true (`SESSION_SECURE_COOKIE=true`), `http_only` true, `same_site` null.
- **Every** response (HTML, JSON, 302, 401, 419) carries a fresh `Set-Cookie: laravel_session=…` with a new
  encrypted value and expiry. The jar must store it each time (the decrypted session id stays the same, so a
  stale value still works while the session lives, but always prefer the newest).
- CSRF token = session token. It stays constant for the life of a session and changes when a new session is
  created (login, or remember-cookie re-auth).

### Expired / missing session (observed)
| Request | Response |
|---|---|
| `GET /mailbox/1`, no cookie or garbage `laravel_session` | `302 Location: https://…/login` (HTML body is a meta-refresh page) |
| Same with `X-Requested-With: XMLHttpRequest` (with or without `Accept: application/json`) | `401` `{"message":"Unauthenticated."}` |
| `POST /conversation/ajax` with no/expired session (any headers) | **`419`** `{"message": ""}` (JSON) because `VerifyCsrfToken` runs before `auth`. Never 401/302. |
| `POST /conversation/ajax`, valid session, wrong or missing token | `419` `{"message": ""}` |
| Non-ajax POST with bad token | `419` HTML, `<title>Page Expired</title>` |
| Only `remember_web_*` cookie (session gone) on a GET | `200`, user re-authenticated, new `laravel_session`, **new csrf token**. An ajax POST with the old token → `419`. |

So a 419 is ambiguous (stale token vs dead session). Recovery: GET any page (e.g. `/`); if it 302s to
`/login` → re-login (or report expiry); otherwise read the new `<meta name="csrf-token">` and retry once.

### Login quirk in this demo
None for the MCP. (Unrelated: `FREESCOUT_APP_PROXY=https` in compose ends up as `APP_PROXY=https`, which FreeScout
uses as an *outbound HTTP proxy*, so module-directory fetches fail in `laravel.log`. Harmless for us.)

---

## 3. Request conventions

- Middleware group `web` (`app/Http/Kernel.php`): EncryptCookies → AddQueuedCookiesToResponse → StartSession →
  TokenAuth → ShareErrorsFromSession → **VerifyCsrfToken** → … ; controllers add `auth`.
- CSRF for ajax: header `X-CSRF-TOKEN: <meta csrf-token>` (what `main.js` `ajaxSetup()` sends). `_token=<token>` in
  the form body also works (observed).
- Ajax header: `X-Requested-With: XMLHttpRequest`. Body: `application/x-www-form-urlencoded` (jQuery
  `form.serialize()`); arrays as `cc[]=…`.
- `main.js fsAjax()` also appends `?folder_id=<current folder>` to `/conversation/*` ajax URLs. Optional; it only
  affects `redirect_url` in the response.
- Generic JSON envelope from `ConversationsController::ajax`: starts as `{"status":"error","msg":""}`;
  success sets `status:"success"`. Permission failures return **HTTP 200** with
  `{"status":"error","msg":"Not enough permissions"}`. Always check `status`, and also `msg` (see
  `conversations_pagination` below, which says `success` with a permission `msg`).
- Uncaught exceptions → `500 {"message":"Server Error"}` (APP_DEBUG=false).

---

## 4. Read pages

All GET, HTML, `auth` required. Common to every authenticated page:
- `<meta name="csrf-token" content="…">`
- `<body … data-auth_user_id="2">` (current user id). Admins also get class `user-is-admin` on `<body>`.
- Navbar account menu: `.dropdown-toggle-account .nav-user` = first name; `a[href$="/users/profile/{id}"]` "Your Profile".

### 4.1 Dashboard (mailbox list): `GET /`
Route `dashboard` → `SecureController@dashboard`. Shows only mailboxes the user can view (agent sees Support only).
- `.dash-cards .dash-card[data-mailbox-id]` per mailbox (class `dash-card-inactive` when fetching isn't configured; ignore)
- `.dash-card h3 a.mailbox-name` → name; `href` `/mailbox/{id}`
- `.dash-card-link a.help-link` → mailbox email
- `.dash-card-list a.dash-card-list-item` → folder links `/mailbox/{mailbox_id}/{folder_id}`; text = folder name,
  `strong` = active count, `.waiting-since` optional. Empty folders get `dash-card-item-empty`.
- `GET /mailboxes` also exists (200 for the agent) but is the settings list; prefer the dashboard.

### 4.2 Folder listing: `GET /mailbox/{mailbox_id}` and `GET /mailbox/{mailbox_id}/{folder_id}?page=N`
`MailboxesController@view`. Without `folder_id` (or unknown id) shows the **Unassigned** folder.
`authorize('viewCached', $mailbox)` then `authorize('view', $folder)`. 50 per page, `?page=N`.

Sidebar (folders of this mailbox visible to the user):
- `.sidebar-title-real.mailbox-name` (mailbox name), `.sidebar-title-email`
- `ul#folders > li[data-folder_id][data-active-count]`; class `active` marks the current folder;
  `.folder-name` text; `a[href]` = `/mailbox/{mid}/{fid}`. Icon class on `li` hints type: `folder-open`
  (Unassigned), `hand-right` (Mine), `star` (Starred), `user` (Assigned), `lock` (Closed), `ban-circle` (Spam),
  Drafts/Deleted appear only when non-empty.

Conversation table (`resources/views/conversations/conversations_table.blade.php`):
- `table.table-conversations[data-page]` (+ `data-sorting_sort_by`, `data-sorting_order`, `data-param_*`, `data-filter_*`)
- Row: `tbody tr.conv-row[data-conversation_id]`; class `conv-active` iff status Active, `conv-spam` iff spam.
  **No explicit status column**: Pending vs Closed is only implied by the folder, or by the badge
  `i.glyphicon-lock[title=Closed]` inside `.conv-subject p` when a closed conversation is shown outside Closed.
- `td.conv-customer a` (`title` = customer email) → `.conv-customer-name` (name, trailing `&nbsp;`),
  `.conv-counter` (threads_count, only if >1), `.conv-owner-mobile` (assignee full name, only if assigned),
  `.conv-email`.
- `td.conv-owner` (assignee name) is only rendered on some views (search, customer page), not on folder pages.
- `i.conv-star` has `glyphicon-star` (starred by me) or `glyphicon-star-empty`.
- `i.glyphicon-paperclip` in `td.conv-attachment` → has attachments.
- `td.conv-subject a` (`href` = `/conversation/{id}?folder_id={fid}`) → first `p` = subject (may start with badges),
  `p.conv-preview` = preview text.
- `td.conv-number a` → `#<number>` (number, not id; equal in this demo but don't assume).
- `td.conv-date a` → relative text; `title`/`aria-description` = `Last reply by Customer|User<br/>Oct 22, 2026 06:42`
  (not present in Closed/Drafts/Deleted folders).
- Footer `tfoot td.conv-totals`: `<strong>N</strong> conversations | <strong>A</strong> active | <strong>from</strong>-<strong>to</strong>`
- Pagination (`conversations_pagination.blade.php`, only if >1 page): `a.pager-nav.pager-first|pager-prev|pager-next|pager-last[data-page]`,
  `disabled` class when not applicable. The links are JS-driven (`href="#"`); use `?page=N` on the GET instead.
- Empty folder: `<div class="empty-content">…<p>There are no conversations here</p>`.

Ajax alternative: `POST /conversation/ajax` `action=conversations_pagination`, `mailbox_id`, `folder_id`, `page`
→ `{"status":"success","msg":"","html":"<table…>"}`. For a forbidden folder it returns
`{"status":"success","msg":"Not enough permissions","html":"<div class=\"empty-content\">…"}` (observed).

### 4.3 Conversation view: `GET /conversation/{id}?folder_id={fid}`
`{id}` is the conversation **id** (not number). `authorize('viewCached', $conversation)`.
- Without `folder_id` (or a folder the conversation can't be in) → **302** to `/conversation/{id}?folder_id=…`
  (Mine folder if assigned to me). Follow redirects.
- Missing id → 404. No mailbox access → 403 (see §7).
- Viewing marks related notifications read (side effect, harmless).

DOM (`resources/views/conversations/view.blade.php`, `partials/thread.blade.php`):
- `<body data-mailbox_id data-conversation_id data-auth_user_id>`; `#conv-layout` has class `conv-type-email|phone|…`.
- Subject: `#conv-subject .conv-subjtext > span` (also `input#conv-subj-value[value]`).
- Number: `#conv-subject .conv-numnav strong`. Star: `.conv-numnav i.conv-star.glyphicon-star`.
- Assignee: `#conv-assignee .conv-info-val span` (text: `Me`, a full name, or `Anyone`);
  machine value `#conv-assignee ul.conv-user li.active a[data-user_id]` (`-1` = unassigned). The list also gives
  all assignable users (`data-user_id` + name).
- Status: `#conv-status .conv-info-val span` text; value `#conv-status ul.conv-status li.active a[data-status]`.
- Reply-form status defaults: `select[name=status][data-reply-status][data-note-status]` (note default = current status).
- Customer sidebar `#conv-layout-customer .customer-snippet`: `a.customer-name` (`href=/customers/{id}/edit`),
  `.customer-contacts .customer-email a.contact-main` (email), `.customer-extra` (company etc.).
- Hidden reply form `form.form-reply` (inside `.conv-reply-block.hidden`): `_token`, `conversation_id`,
  `mailbox_id`, `saved_reply_id`, `thread_id`, `is_note`, `subtype`, `conv_history`, `to` (select),
  `cc[]`, `bcc[]`, `body` (textarea), `status`, `user_id`, `after_send`.
- Threads: `#conv-layout-main > div.thread`, **newest first**.
  - `div.thread.thread-type-{customer|message|note|lineitem|chat}#thread-{id}[data-thread_id]`
    (`lineitem` = status/assignee change log line; it has no `data-thread_id`, and its text is in `.thread-title`).
  - Draft reply: `div.thread.thread-type-draft#thread-{id}[data-thread_id]`; `.thread-person` = `you&nbsp;[Draft]`
    or author name; `.draft-actions .edit-draft-trigger/.discard-draft-trigger`; body directly in `.thread-body`
    (no `.thread-content`). Drafts are `TYPE_MESSAGE` + `STATE_DRAFT`; there are no note drafts.
  - Author: `.thread-person strong a` → `href=/users/profile/{id}` (user; text is `you` for the current user)
    or `href=/customers/{id}/edit` (customer).
  - Recipients: `.thread-recipients` (`To:` / `Cc:` lines; empty for notes).
  - Date: `a.thread-date` text = relative, `title` = absolute `Oct 22, 2026 08:52` (user timezone, UTC here).
  - `.thread-status`: assignee/status snapshot text on some threads (e.g. `Demo Agent, Active`).
  - Body: `.thread-body .thread-content` (HTML). Attachments: rendered by `partials/thread_attachments.blade.php` within the thread (none in the demo data).
  - Badges: `.thread-badge` (forwarded, phone).

### 4.4 Customer: `GET /customers/{id}/` (also `/customers/{id}`)
`CustomersController@conversations`. Lists only conversations in mailboxes the user can view
(`whereIn('mailbox_id', mailboxesIdsCanView())`).
- `.customer-snippet` same as conversation sidebar (`a.customer-name`, `.customer-email a.contact-main`, `.customer-extra`).
- Conversations: same `table.table-conversations` (`data-filter_customer_id`, `data-param_no_customer="1"`),
  with `td.conv-owner` (assignee) column and no customer column.
- Profile fields: `GET /customers/{id}/edit` (inputs `first_name`, `last_name`, `company`, `job_title`, `emails[]`, `websites[]`, `address`, `city`, `state`, `zip`, `country`, `notes`, `photo_url`).
- Observed: the agent can open the profile page of a customer whose only conversation is in Billing (200,
  empty table). Customer records are global unless `limit_user_customer_visibility` is enabled.
- `GET /customers/ajax-search?q=…` (select2 JSON: `{"results":[{"id":"email","text":"Name <email>"}],"pagination":{"more":false}}`).

### 4.5 Search: `GET /search?q=…`
`ConversationsController@search`.
- Params: `q`; `mode=conversations` (default) or `mode=customers`; filters as `f[<name>]`, with names from
  `Conversation::$search_filters`: `assigned`, `customer`, `mailbox`, `status` (array: `f[status][]=1`), `state`
  (array), `subject`, `attachments`, `type`, `body`, `number`, `following`, `id`, `after`, `before` (dates).
  Customer mode adds `f[company]` etc. `page=N` (50/page).
- `q` starting with `#` or equal to a number: if exactly one match and no filters → **302 straight to the conversation**.
- Results reuse `table.table-conversations` (`data-param_show_mailbox`, `td.conv-owner` present). Restricted to
  mailboxes the user can view (observed: `q=invoice` returns nothing for the agent).

### 4.6 Current user: `GET /users/profile/{id}`
`id` from `body[data-auth_user_id]`. Inputs: `first_name`, `last_name`, `email` (`readonly` for non-admins),
`job_title`, `phone`, timezone/time format selects. No role field for non-admins. Other users' profiles → 403.
`GET /users` → 403 for non-admins.

### 4.7 Saved replies
**Not available on the demo.** Saved Replies is a paid module; `/www/html/Modules` (→ `/data/Modules`) is empty and
the `modules` table has no rows. There is no saved-replies route in core. Core only carries `saved_reply_id` on
`send_reply` (stored on the thread). Same for Tags (module, absent; see §9).

### 4.8 Other read ajax (reference)
- `POST /conversation/ajax` `action=load_customer_info`, `action=conv_list` (side list), `action=merge_search`.
- `GET /conversation/ajax-html/{action}`: `send_log`, `show_original` (`thread_id`), `change_customer`,
  `move_conv`, `merge_conv`, `assignee_filter`, `default_redirect`. Return HTML fragments.

---

## 5. Write endpoints: `POST /conversation/ajax`

Headers: `X-CSRF-TOKEN`, `X-Requested-With: XMLHttpRequest`, cookie jar. Body form-encoded. Field `action` selects
the case in `ConversationsController::ajax()`.

### 5.1 Add internal note: `action=send_reply` + `is_note=1`
There is no separate note action. Notes and customer replies both use `send_reply`; **`is_note` is the only switch**:

```php
$is_note = false;
if (!empty($request->is_note)) { $is_note = true; }
...
if ($is_note || $is_forward) { $thread->type = Thread::TYPE_NOTE; } else { $thread->type = Thread::TYPE_MESSAGE; }
...
} elseif ($is_note) { event(new UserAddedNote($conversation, $thread)); }   // no customer email
} else { event(new UserReplied($conversation, $thread)); ... }                 // emails the customer
```

Fields to send for a note (MCP should pin all of these):

| Field | Value | Why |
|---|---|---|
| `action` | `send_reply` | |
| `conversation_id` | conversation id | must be viewable, else `Not enough permissions` |
| `mailbox_id` | the conversation's mailbox (`body[data-mailbox_id]`) | `Mailbox::findOrFail` + `can('view')` |
| `is_note` | `1` | **must be non-empty**; empty/absent ⇒ customer reply is emailed |
| `body` | HTML | required (`'body' => 'required|string'`) |
| `status` | current status (`select[name=status][data-note-status]`, or `#conv-status li.active a[data-status]`) | `$request_status ?: $conversation->status` keeps it if 0, but `thread->status` becomes 0 if omitted; send it |
| `user_id` | current assignee id, or `-1` if unassigned (`#conv-assignee li.active a[data-user_id]`, which is what `main.js getConvData('user_id')` sends) | see quirk below |

Must **not** be sent: `subtype` (`subtype=1` turns it into a *forward* (§5.5), which creates a new conversation and emails
the `to_email[]` recipient even with `is_note=1`), `to`, `to_email[]`, `cc[]`, `bcc[]`, `thread_id` (ignored for
notes anyway), `is_create`, `type`, `multiple_conversations`.

`user_id` quirk (observed):
- `user_id=-1` ⇒ conversation is **unassigned** (`$conversation->user_id = null`).
- `user_id` omitted on an *assigned* conversation ⇒ `(int)null = 0` ⇒ `$mailbox->userHasAccess(0)` ⇒
  `User::find(0)` null ⇒ **HTTP 500 `{"message":"Server Error"}`** (nothing saved).
- `user_id=<current assignee>` ⇒ unchanged. On an unassigned conversation send `-1`.

Response (observed): `{"status":"success","msg":"","redirect_url":"https://…/mailbox/1/3"}`
(`redirect_url` depends on the user's "after send" setting). Error: `{"status":"error","msg":"Not enough permissions"}`
or validation text (e.g. `The body field is required. `). The created thread id is not returned; re-fetch the page.

Side effects: `UserAddedNote` notifies subscribed users by email (through the mailbox's outgoing settings).
Notes do not change `last_reply_at`/folders (except phone conversations) and do not count in `threads_count`.

### 5.2 Save draft: `action=save_draft`
Creates/updates a **reply draft** (`TYPE_MESSAGE`, `STATE_DRAFT`), rendered on the conversation page as
`div.thread.thread-type-draft` (observed as the author; visibility to other users not tested). The conversation is added to the Drafts folder. Nothing is sent.

| Field | Value |
|---|---|
| `action` | `save_draft` |
| `conversation_id` | existing conversation id (must be viewable) |
| `mailbox_id` | its mailbox |
| `thread_id` | empty to create; the returned `thread_id` to update the same draft |
| `body` | HTML (not validated; the UI skips autosave when empty) |
| (optional) `to`, `cc[]`, `bcc[]` | defaults to `conversation.customer_email` |

Do **not** send `is_create` (that path creates a brand-new draft conversation, and rejects existing published ones with
"Message has been already sent…"), `subtype`, or `is_note` (only honoured with `is_create`; drafts on existing
conversations are always replies).

Response (observed): `{"status":"success","msg":"","conversation_id":2,"customer_id":4,"thread_id":28,"number":2}`.
Errors (HTTP 200, `status:"error"`): `Not enough permissions`, `Incorrect thread` (thread not in that conversation),
`Message has been already sent. Please discard this draft.` (thread already published),
`You've already sent this message just recently.` (body identical to the last message/note by this user).
Calling without `thread_id` again creates a **second** draft (observed); keep the returned id.

Load: `action=load_draft`, `thread_id` →
`{"status":"success","msg":"","data":{"thread_id":28,"from_alias":null,"to":"devops@acme-retail.example","cc":[],"bcc":[],"body":"<p>…</p>","is_forward":0,"attachments":[]}}`;
errors `Thread not found`, `Thread is not in a draft state`, `Not enough permissions`.

Discard: `action=discard_draft`, `thread_id` → `{"status":"success","msg":""}` (deletes the draft thread; if the whole
conversation is a draft it deletes the conversation and returns `redirect_url`). Unknown `thread_id` also returns success.

### 5.3 NEVER send (reference only)
- `action=send_reply` **without** `is_note` (or `is_note=` / `0`… note: `"0"` is `empty()` in PHP, so `is_note=0`
  is also a customer reply): creates `TYPE_MESSAGE`, fires `UserReplied` → email to customer after the undo window.
- `action=send_reply` with `thread_id=<draft id>` (no `is_note`): publishes the draft = sends it.
- `action=send_reply` with `is_create=1` / no `conversation_id` (new outbound conversation).
- `action=send_reply` with `subtype=1` from anything but the pinned forward form of §5.5 (allow-listed recipient,
  `is_note=1`, exactly one `to_email[]`, no `to`/`cc`/`bcc`/`thread_id`). The note form (§5.1) never carries `subtype`.
- `action=conversation_change_status` with any status other than `3` (closed), see §5.4: no reopen, pending, spam or
  `not_spam`.
- `GET /conversation/undo-reply/{thread_id}/{token}` reverts a just-sent reply to a draft (only within the undo timeout).
- Also out of scope: `conversation_change_user`, `star_conversation`,
  `delete_conversation*`, `restore_conversation`, `save_edit_thread`, `delete_thread`, `bulk_*`, `empty_folder`,
  `conversation_move`, `conversation_merge`, `conversation_change_customer`, `update_subject`, `follow`/`unfollow`,
  `retry_send`, `save_after_send`.

Full list of `ajax()` actions: `conversation_change_user`, `conversation_change_status`, `send_reply`, `save_draft`,
`discard_draft`, `load_draft`, `load_attachments`, `save_after_send`, `conversations_pagination`,
`conversation_change_customer`, `star_conversation`, `delete_conversation`, `delete_conversation_forever`,
`restore_conversation`, `load_edit_thread`, `save_edit_thread`, `delete_thread`, `bulk_conversation_change_user`,
`bulk_conversation_change_status`, `bulk_delete_conversation`, `empty_folder`, `conversation_move`,
`conversation_merge`, `follow`, `unfollow`, `update_subject`, `merge_search`, `chats_load_more`, `conv_list`,
`retry_send`, `load_customer_info`. Unknown action → `{"status":"error","msg":"Unknown action"}`; an error with empty msg becomes `Unknown error occurred`.

### 5.4 Close a conversation: `action=conversation_change_status` (status pinned to 3)
Source: `ConversationsController::ajax()` case `conversation_change_status`, `Conversation::changeStatus()` (read from
the FreeScout source, 2026-10-26; not yet exercised live by this MCP).

| Field | Value |
|---|---|
| `action` | `conversation_change_status` |
| `conversation_id` | one conversation id |
| `status` | `3` (`Conversation::STATUS_CLOSED`). The MCP never sends anything else (`assertStatusForm`) |

Server checks, in order (each answers HTTP 200 `{"status":"error","msg":…}`): `Conversation not found`;
`Status already set` when the conversation already has that status (so the MCP returns `already_closed` without
posting); `Not enough permissions` (`can('update')`); `Incorrect status`. `status=not_spam` restores the previous
status from the thread log; the MCP never sends it.

Success: `{"status":"success","msg":"Status updated","redirect_url":"…"}`. Note the **non-empty** `msg`;
`checkAjax` only throws on permission wording or `status != success`, so this passes.

Side effects: `changeStatus()` saves the status (and `closed_by_user_id`/`closed_at`), adds one `lineitem` thread
(`ACTION_TYPE_STATUS_CHANGED`, rendered without `data-thread_id`) and fires `ConversationStatusChanged`, which
notifies **users** only; the customer is never emailed. The assignee is not touched.

MCP verification: re-read the page; `#conv-status li.active a[data-status]` must be `3`, the assignee unchanged, and
no new `note`/`message`/`draft` thread (a new `customer` thread is inbound mail).

### 5.5 Forward: `action=send_reply` + `subtype=1` + `to_email[]`
Source: `ConversationsController::ajax()` case `send_reply` (read from the FreeScout source, 2026-10-26).
`$is_forward = !empty(subtype) && (int)subtype == Thread::SUBTYPE_FORWARD (1)`.

Fields the MCP sends (pinned, `assertForwardForm`):

| Field | Value | Why |
|---|---|---|
| `action` | `send_reply` | |
| `conversation_id`, `mailbox_id` | the conversation and its mailbox | as for notes |
| `body` | HTML | required (`'body' => 'required|string'`) |
| `user_id` | current assignee id, or `-1` when unassigned | same quirk as notes (§5.1): omitting it 500s on assigned conversations |
| `status` | current status | `$conversation->status = (int)status ?: current`; sending the current value changes nothing |
| `is_note` | `1` | failsafe. The UI sends `is_note=''` for a forward, but the server does `if ($is_note || $is_forward) type = NOTE` and the event chain checks `is_create`, then `is_forward`, then `is_note`; so with `subtype=1` the forward branch still runs, and if `subtype` were ever lost the request degrades to an internal note instead of a customer reply |
| `subtype` | `1` | forward |
| `to_email[]` | exactly one bare lowercase address | `Conversation::sanitizeEmails()` parses `Name <email>` / `Name email` (splits on whitespace) and creates a Customer with that name, so no whitespace, `<>`, quotes, commas or semicolons |

Never sent: `to` (customer reply recipient), `cc[]`/`bcc[]` (copied onto the forwarded conversation), `thread_id`
(publishes a draft), `is_create`, `multiple_conversations`, `attachments[]`/`embeds[]`, `conv_history` (omitted →
mailbox default), `type`, `subject`.

Server behaviour: empty `to_email[0]` → `Please specify a recipient.` For **each** recipient it replicates the
conversation into a NEW email conversation (`subject = "Fwd: " + subject`, `customer_email = recipient`,
`Customer::create(recipient)` so the recipient becomes a customer record, `cc`/`bcc` from the request) and a
`TYPE_MESSAGE` thread on it; on the original conversation it stores one `TYPE_NOTE` thread with
`subtype = SUBTYPE_FORWARD` and meta `fw_ccn`/`fw_cci` (child conversation number/id). Events: `UserAddedNote` on the
original, `UserReplied` on the forwarded conversation, which **emails the recipient** after
`Conversation::UNDO_TIMOUT` = 15 seconds (`conversation.user_forwarded` background action). Status/assignee follow
the `status`/`user_id` fields like any `send_reply`.

Response: `{"status":"success","msg":"","redirect_url":"…"}`; the thread id and the child conversation are not
returned. Re-read the page: the forward note is a `thread-type-note` with a `.thread-badge` (forwarded); the exact
markup of the badge and of the child-conversation link has **not been captured yet**, so the parser's
`is_forward`/`forwarded_conversation_number` are best-effort and the MCP only warns (does not fail) when the marker
is missing.

MCP gates (see README "Security model"): tool registered only when `FREESCOUT_FORWARD_ALLOW` is set; recipient must
match it and must not be the conversation's customer or on the customer side of it; post-read requires unchanged
status/assignee and exactly one new note (any new `message`/`draft` → `DANGER`). The page is refused before the POST
when it shows no customer email. Any failure after the POST that does not prove a refusal (network, timeout,
non-envelope answer, failed re-read) is reported as `POSSIBLY SENT:` (do not retry).

Concurrent-change heuristic: status/assignee log lines (`thread-type-lineitem`) render **without** a
`data-thread_id`, so thread-id diffs cannot see them; the MCP counts them before and after. A forward or note never
adds one, and a close adds exactly one, so any extra means a teammate changed status/assignee between our page read
and our POST, and the stale `status`/`user_id` we sent may have overwritten it (FreeScout applies them
unconditionally). The call then succeeds with `concurrent_change_detected: true` and a `warning` (same for
`add_note` and `close_conversation`). Heuristic only: a change made after our re-read is not seen.

---

## 6. Permission model for a limited user (observed as agent, Support only)

| Request | Result |
|---|---|
| `GET /conversation/10?folder_id=9` (Billing) | `403`, small HTML page "Access denied" (no redirect) |
| `GET /conversation/10` (no folder) | `403` |
| `GET /mailbox/2`, `/mailbox/2/9` | `403` |
| `GET /conversation/999` | `404` |
| `GET /users`, `/users/profile/1` | `403` |
| `GET /customers/10/` (Billing-only customer) | `200`, profile visible, conversation table empty |
| `GET /search?q=invoice` | `200`, no Billing results |
| Dashboard | only the Support card |
| `send_reply` note on conv 10 (`mailbox_id=2` or spoofed `1`) | `200 {"status":"error","msg":"Not enough permissions"}` |
| `save_draft` on conv 10 | `200 {"status":"error","msg":"Not enough permissions"}` |
| `conversations_pagination` for Billing folder 9 | `200 {"status":"success","msg":"Not enough permissions","html":"…no conversations…"}` |

Mailbox-level permission flag `Mailbox::ACCESS_PERM_ASSIGNED` (`asg`) would restrict a user to conversations
assigned to them (`canSeeOnlyAssignedConversations()`); not set for the demo agent.

---

## 8. Corrections and additions found while implementing the tools (2026-10-22, live as the agent)

- **Last-activity tooltip** (`td.conv-date a[title]`): besides `Last reply by Customer|User<br/>…` it can be
  `Created by Customer<br/>…` (conversation with only the customer's first message, e.g. conv 1).
- **Dashboard card folders**: only Unassigned, Mine, Starred, Drafts (even at 0) and Assigned. Closed/Spam are
  only in the mailbox sidebar.
- **Sidebar visibility** (`mailboxes/partials/folders.blade.php`): Drafts is listed when non-empty *or* current;
  Deleted only when it is current, or when it is non-empty **and** the current folder is Closed. So a missing Deleted
  folder in `/mailbox/{id}` does not mean "empty"; look at `/mailbox/{id}/{closed_id}`. Icon classes come from
  `Folder::$type_icons`: `folder-open`, `hand-right`, `duplicate` (Drafts), `user`, `lock`, `ban-circle`, `trash` (Deleted), `star`.
- **Unknown folder id** in `/mailbox/{mid}/{fid}` (e.g. Billing folder 9 under mailbox 1) silently renders Unassigned
  (`li.active` is folder 1). Check `li.active[data-folder_id]` against the requested id.
- **Customer page table** (`/customers/{id}/`): there *is* a `td.conv-customer` cell, but with class
  `conv-owner-mobile` and it only holds the assignee (`<small><i class="glyphicon-user"></i> Name</small>`).
  `td.conv-owner` is also present. No `.conv-counter` there, so no thread count.
- **Status badges** in list rows (`conversations/partials/badges.blade.php`): `i.glyphicon-lock` (closed),
  `i.glyphicon-ban-circle` (spam), `i.glyphicon-trash` (deleted), `i.glyphicon-duplicate` (draft conversation), each
  rendered only outside the matching folder. Not active + no badge = pending, except in the Closed/Spam folders.
- **Search for a customer by email**: `/search?q=<email>&mode=customers` → `.table-customers a.card[href=/customers/{id}/edit]`
  with `h4` name and `p small` email (cards view, the default). `customers/ajax-search` returns the email as `id`.
- **`/search?q=%239`** (single match) does 302 to `/conversation/9?folder_id=…`, as documented.
- **Draft thread author**: `.thread-person strong` contains plain `you` (no link) for your own draft.
- **Lineitem** threads: `div.thread.thread-type-lineitem.thread-state-…#thread-{id}` (id only in the `id` attribute).
- **Notes are not de-duplicated**: posting the same note body twice in a row is accepted (two notes). The
  "already sent this message just recently" check applies to drafts/replies, not notes.
- **Note notifications** (`app/Subscription.php`): a note fires `EVENT_FOLLOWED_CONVERSATION_UPDATED` (13) plus
  `EVENT_USER_REPLIED_TO_MY`/`…_TO_ASSIGNED` when the previous thread was by a user, else `EVENT_USER_REPLIED_TO_UNASSIGNED` (8).
  The author is never notified. In the demo, nobody subscribes to 8, so the agent's notes on conversation 1 (unassigned)
  and 9 (assigned to the agent) produced **no** `send_logs` rows and no `jobs`. A note on a conversation assigned to the
  admin would notify the admin (event 5); with outgoing mail disabled, that attempt is logged with status 2 (failure).
  Either way, nothing is ever addressed to the customer.
- **`discard_draft` on a draft *conversation*** (`conversations.state = 1`, a new conversation still being composed)
  deletes the whole conversation. On a published conversation it deletes only a thread in `STATE_DRAFT` and ignores
  any other thread. The MCP checks first that the thread is a draft on a conversation with published threads.
- **Saved Replies**: the module's routes could not be checked (it is not installed). `list_saved_replies` looks
  for a `saved-replies` link on the mailbox page and probes `/mailbox/saved-replies/{mailbox_id}`. On the demo both are absent (404).
- **Draft conversation page** (`conversations.state = 1`, e.g. created by `save_draft` with `is_create=1`):
  `GET /conversation/{id}` renders `conversations/create` instead of `view`: `#conv-layout.conv-new`,
  `#conv-layout-main.conv-new-form`, `form#form-create` with `input[name=is_create]=1` and the draft's
  `input[name=thread_id]`, no `#conv-status`/`#conv-assignee` menus and no `div.thread`. `send_reply` there
  publishes the conversation, so `add_note`, `save_draft` and `discard_draft` refuse such conversations
  (fixture: `docs/fixtures/conversation-13-new-draft.html`, agent view of an admin's new-conversation draft).

---

## 9. Tags module (VERIFIED from a production install's own JS bundle and pages, 2026-10-25)

The Tags module (https://freescout.net/module/tags/, paid, no public repository) is **not** installed on the demo.
Everything below was read from a production FreeScout that runs it: its minified `/js/builds/*.js` bundle (the
module's laroute entry and its `addTag()` / remove / select2 code, sent through core `fsAjax`) and its conversation
page markup. Only GET requests and the read-only `autocomplete` action were
made there while building this. No production content is reproduced here or in the repo; fixtures are synthetic.

Earlier second-hand evidence (altmenorg/freescout-refresh v1.8.0, commit `0dd1ce4`, `RefreshServiceProvider.php`
2379-2417) matches what the bundle shows.

Forward-note markup (captured live, FreeScout 1.8.248, 2026-10-27): the note on the original conversation is
`div.thread.thread-type-note` with `.thread-message > .thread-badge > i.glyphicon-arrow-right` (no text, no title) before
`.thread-header`; `.thread-recipients` shows `To: <recipient>`; and `.thread-body` starts with FreeScout's own chrome
`div.alert.alert-note` = "You forwarded this conversation. Forwarded conversation: <a href=".../conversation/{id}">#{number}</a>"
followed by `.thread-content` (the agent-written body). The parser reads the badge and the `#N` link only outside
`.thread-content`.

### Route
laroute entry `{"uri":"tags\/ajax","name":"tags.ajax"}`: **`POST <base>/tags/ajax`** (built relative to
`FREESCOUT_URL`, so sub-path installs work). Standard FreeScout ajax: `application/x-www-form-urlencoded`, `_token`,
`X-Requested-With: XMLHttpRequest`, `X-CSRF-TOKEN` (exactly what `Session.ajaxPost` sends). Without the module the
path 404s.

### Actions
| Action | Form | Answer |
|---|---|---|
| add | `action=add&tag_names[]=a&tag_names[]=b&conversation_id=N` | `{status:"success", tags:[{name, url, …}]}`: the conversation's resulting tag list (the UI re-renders chips from it) |
| remove | `action=remove&tag_name=a&conversation_id=N` | `{status:"success"}` |
| autocomplete | `action=autocomplete&q=…&page=N` (select2) | `{results:[{id, text}], pagination:{more}}`; `id` is the tag name; 20 results per page |

- **Add is additive.** The client strips names already shown in `#conv_tags .tag-name` before sending, and sends only
  the new names; existing tags are neither resent nor removed. Removing is the separate `remove` action.
- **Bulk form.** Outside a conversation page the same client sends `conversation_id = getSelectedConversations()`,
  an **array** (`conversation_id[]=…`), to tag many conversations at once. The MCP never sends that (see below).
- **Remove** takes one `tag_name` per request; `remove_tag` sends one POST per tag, with the name as shown on the page.
- Names are normalised server-side (`Tag::normalizeName`); compare trimmed and case-insensitively. Commas separate
  tokens in the UI's tag input. Tags are global (not per mailbox).
- Errors follow the usual envelope (`status:"error", msg`); "Not enough permissions" / HTTP 403 mean no access.

### Conversation page markup (shape observed; names here are placeholders)
```html
<div id="conv_tags"> <span class="tag tag-c-0"><a class="tag-name" href="<base>/search?f%5Btag%5D=NAME" target="_blank">NAME</a>
  <a class="tag-remove" href="#" title="Remove Tag">×</a></span> </div>
<span class="conv-add-tags conv-action glyphicon glyphicon-tag" …></span>
<ul class="dropdown-menu" id="add-tag-wrap">… <select class="form-control tag-input" multiple/> …</ul>
```
Chips carry a colour class `tag-c-N` and no tag id. Module present on a conversation page ⇔ `#conv_tags` or
`.conv-add-tags` exists. On the conversation list the chips are inside `.conv-tags` without links.

### What the MCP does with this
- `list_tags`: with `q`, the `autocomplete` action (up to 5 pages); if that fails (404 without the module, non-JSON,
  refused) and without `q`, the page scan (first page of each mailbox's default folder, then one conversation).
- `add_tag`: GET the conversation (fresh CSRF, current tags; refuse if the module markup is absent or it is an unsent
  draft conversation), drop names already present, then `assertTagForm` and one POST. `assertTagForm` allows exactly
  `{action:"add", conversation_id: /^[1-9]\d*$/ string, tag_names: 1..10 strings, trimmed, 1..50 chars, no commas,
  no control characters, no case-insensitive duplicates}`; arrays are serialised as `key[]` pairs only for
  `tag_names`. Then the conversation is re-read: every earlier tag must still be there (a loss is a loud `DANGER`
  error) and every requested tag must appear.
- No remove code path exists in `src/`. The fake FreeScout (`test/fake-freescout.ts`) implements add, remove and
  autocomplete for tests.

---

## 10. Search filters and search-derived statistics (VERIFIED on the demo container source + live as the agent, 2026-10-28)

Source: `app/Conversation.php` (`$search_filters` line 176, `search()` line 2549, `addStatusCondition()` line 857,
`getDateTitle()` line 555), `app/Http/Controllers/ConversationsController.php` (`search()` line 3015,
`searchQuery()` 3140, `getSearchFilters()` 3173), `resources/views/conversations/search.blade.php`. FreeScout 1.8.248.

### 10.1 Filter semantics (`GET /search?f[<name>]=…`)
| Filter | Wire form | Server behaviour |
|---|---|---|
| `after` | `f[after]=YYYY-MM-DD` | `conversations.created_at >= 'YYYY-MM-DD 00:00:00'` |
| `before` | `f[before]=YYYY-MM-DD` | `conversations.created_at <= 'YYYY-MM-DD 23:59:59'` (inclusive) |
| `assigned` | `f[assigned]=<user_id>` or `-1` | `conversations.user_id = <id>`; `-1` (`Conversation::USER_UNASSIGNED`) → `user_id IS NULL`. Any user id is accepted, not only those in the dropdown (verified: `f[assigned]=1` as the agent filtered on admin's conversations) |
| `status` | `f[status][]=N` (repeatable; MUST be an array, scalar is dropped) | `status IN (…)`; 1 active, 2 pending, 3 closed, 4 spam |
| `state` | `f[state][]=N` (array) | 1 draft, 2 published, 3 deleted |
| `mailbox` | `f[mailbox]=<id>` | if the user lacks access the filter is **silently dropped** and all viewable mailboxes are searched (verified: `f[mailbox]=2` as the agent returned the 9 Support rows) |
| `customer` | `f[customer]=<customer_id>` | `customer_id = id OR threads.created_by_customer_id = id` |
| `type` | `f[type]=N` | 1 email, 2 phone, 3 chat |
| `attachments` | `yes`/`no` | `has_attachments` |
| `subject`, `body` | text | `LIKE %…%` (case-insensitive) on subject / thread body |
| `number`, `id` | integer | exact |
| `following` | `yes` | conversations the user follows |

- **Dates**: parsed server-side with `strtotime` then `date('Y-m-d')`. Any unparsable value (e.g. `notadate`) becomes
  `1970-01-01` and matches everything, silently. US `10/26/2026` is accepted. The MCP therefore validates
  `YYYY-MM-DD` strictly client-side (a real calendar date, year 1970 or later) and never forwards anything else.
- **Timezone**: boundaries are evaluated in the app timezone (`APP_TIMEZONE`, `UTC` on the demo and by FreeScout
  default); `created_at` is stored in that timezone too. Verified: per-day search counts for 2026-10-12/23/25/26 equal
  `SELECT COUNT(*) … GROUP BY DATE(created_at)` (1/1/1/4). The column is **created_at**, never last-reply/closed date.
- **No `q` needed**: `GET /search` with filters only (or with nothing) returns the normal `table.table-conversations`
  with the tfoot totals (`N conversations | from-to`). The number → conversation 302 only happens when `$filters`
  is empty, so any filter disables the redirect.
- **`q=#N` plus any filter is HTTP 500** (verified live 2026-10-28: `?q=%239&f[status][]=3`, `?q=%239&f[after]=…`,
  `?q=%239&f[mailbox]=1` all 500; `?q=%239` alone 302s to the conversation; `?q=9&f[after]=…` is a normal text
  search). Cause (`ConversationsController::search` ~3050): for `#N` that exists and is viewable `$conversations`
  becomes a plain array and `searchQuery()` is skipped; with `$filters` non-empty there is no redirect, and the view
  calls `->links()` on the array. Use the exact `f[number]=N` filter instead. A 500 on the post-login intended URL is
  reported by the session as a failed login, so this shape must never be sent. Agents limited to assigned
  conversations always have a filter (forced `assigned`), so `q=#N` alone hits the same 500 for them.
- **Every `/search` also runs the customer search** (`searchCustomers()`): with an empty `q` that is `LIKE '%%'` over
  about a dozen customer columns plus `emails.email`, a LEFT JOIN, `GROUP BY customers.id` and `paginate(50)`, i.e. a
  full count over the customers table per request, on top of the conversation query (inner join on `threads`,
  grouped for the paginator count). Free on the demo, potentially hundreds of ms of DB time per request on a large
  production install.
- **No default state**: `Conversation::search()` has no state condition and no global scope, so deleted (`state=3`)
  conversations and unsent drafts (`state=1`) match every search unless `f[state][]` is given.
- Users who may only see assigned conversations (`canSeeOnlyAssignedConversations`) get `assigned` forced to
  themselves server-side; the tool cannot override it. The dropdown then shows their id `selected` (FreeScout marks
  the effective value: `docs/fixtures/search-assigned-unassigned.html` has `<option value="-1" selected="selected">`).
- Pagination: 50 per page (`Conversation::DEFAULT_LIST_SIZE`), `page=N`. Totals come from the tfoot
  (`parseConversationTable` already reads `total`, `range`, `has_next_page`, `last_page`).

### 10.2 Assignee list for a non-admin
`GET /users` is 403. The search page itself renders `<select name="f[assigned]">` with `<option value="">`,
`<option value="-1">Unassigned</option>` and one `<option value="{id}">{Full name}</option>` per user from
`$user->whichUsersCanView($mailboxes)` (cached 5 min per user). On the demo the agent sees only itself
(`2` Demo Agent); the admin (id 1) is NOT listed although conversations are assigned to them, so the list can be
incomplete. The select is rendered `disabled` when no assigned filter is active; the options are still there.
Fixture: `docs/fixtures/search-filters-only.html`.

### 10.3 Date column on list pages
`td.conv-date a` shows "waiting since" relative text; its `title`/`aria-description` is `getDateTitle()`:
`Created by <Customer|User><br/>M j, Y H:i` when `threads_count == 1`, otherwise `Last reply by …<br/>…` with
`last_reply_at`. So list rows do NOT expose `created_at` for multi-thread conversations; per-period counts must come
from `after`/`before` filtered searches, not from row dates.

### 10.4 Fixtures captured 2026-10-28 (as the agent, Support only)
- `search-filters-only.html`: `f[after]=2026-10-01&f[before]=2026-10-31`, 9 rows, totals "9 conversations | 1-9".
- `search-day-2026-10-26.html`: `f[after]=2026-10-26&f[before]=2026-10-26`, 4 rows (ids 1, 4, 6, 9).
- `search-empty-result.html`: `f[after]=2026-10-27`, 0 rows, `.empty-content` present, no tfoot.
- `search-assigned-unassigned.html`: `f[assigned]=-1`, 3 rows (ids 1, 4, 7).
Demo `conversations` (mailbox 1) for cross-checks: id→created_at(UTC)/status/user_id: 1 10-26 17:12 /1/NULL,
2 10-25 19:12 /1/2, 3 10-23 20:32 /2/2, 4 10-26 10:12 /1/NULL, 5 10-19 19:52 /3/2, 6 10-26 05:12 /1/1,
7 10-24 19:52 /2/NULL, 8 10-12 22:52 /3/1, 9 10-26 15:12 /1/2.

### 10.5 Reports module
Paid module, NOT on the demo. Protocol captured 2026-10-28 from a real install's browser session: see §11.

### What the MCP does with this
- **Dates** (`src/dates.ts`): `after`/`before`/`from`/`to` must match `^\d{4}-\d{2}-\d{2}$` AND round-trip as a real
  calendar date (UTC arithmetic, so `2026-02-30` is refused rather than rolled to March 2). Anything else, and
  `after > before` / `from > to`, is an error before any request: FreeScout would turn it into 1970-01-01.
- **`search_conversations`** (`buildSearchParams` in `src/operations.ts`): `assigned` id or `"unassigned"` → `-1`;
  `status`/`state` → repeated `f[status][]` / `f[state][]` (always the array form); `type` → 1..3;
  `has_attachments` → `f[attachments]=yes|no`; `customer_id` → `f[customer]`; `subject`/`body` trimmed text. `q` is
  optional (`""` counts as absent), but `q` or one filter is required (`mailbox_id` alone does not count; an empty
  search lists everything). No default `state` (parity with FreeScout's UI; the description says deleted and drafts
  are included unless `state` is given).
- **Number search**: when `q` matches `^#?\d+$` and any filter or `mailbox_id` is present, `q` is NOT sent;
  `f[number]=N` is sent instead (after the other filters) and the result notes "searched by conversation number".
  Without filters `q=#N` is kept and the single-match redirect branch handles the 302.
- **Page check**: after every search GET (search_conversations, list_assignees, ticket_volume) the final URL path must
  end in `/search` (any base sub-path is fine) and the page must contain `table.table-conversations` or
  `.empty-content`; anything else throws `FreeScoutError("unexpected page …")`, never a count of 0.
- **Dropped mailbox filter**: after each search with `mailbox_id`, the page's `<select name="f[mailbox]">` options
  are read (`src/parsers/search-filters.ts`); if the requested id is not among them the result gets
  `mailbox_filter_ignored: true` and a note that all viewable mailboxes were searched; if the select is missing it
  gets `mailbox_filter_ignored: null` and a "could not verify" note. `ticket_volume` does the same.
- **Forced assignee**: the `selected` option of `<select name="f[assigned]">` is compared with what was sent (nothing,
  `-1` or an id). If a non-empty selected value differs, both tools return `assigned_filter_forced: <id>` and a note.
  Nothing selected (e.g. an id missing from the dropdown) is never reported as forced.
- **`list_assignees`**: `GET /search` without parameters, `f[assigned]` options without `""` and `-1`.
- **`ticket_volume`** (`src/stats.ts`): buckets are days, ISO weeks (Monday-Sunday) or calendar months, first/last
  clipped to `from`/`to`. One `GET /search?f[state][]=2&f[after]=start&f[before]=end[&breakdown filter]` per bucket ×
  value, always published only (`f[state][]=2`, recorded in `filters.state`), page 1 only. The count is the tfoot
  total; a results table without a tfoot counts its rows (and throws if there is a next page); `.empty-content`
  counts 0. Requests are **serial** (one in flight; each response re-issues the session cookie) and **paced**: a
  pause of `FREESCOUT_STATS_DELAY_MS` (default 200 ms, 0 allowed) before every request after the first, because
  each search also runs the customer search above. Caps: ≤ 31 buckets (checked before any request), ≤ 10 breakdown
  values, ≤ 64 requests per call including discovery (buckets × requests per bucket: 1 for none, 4 for status,
  values + 1 for assignee, values for mailbox plus the `GET /`). `status` = 4 requests per bucket, total = sum.
  `assignee` = dropdown users + unassigned, plus one unfiltered total per bucket so conversations of unlisted users
  (e.g. admins) show as `other`; if the per-assignee sum exceeds the total (forced assignee) the bucket gets
  `inconsistent: true` and a note and no `other` (never clamped). The first bucket's total request doubles as
  dropdown discovery, so the value/request caps are checked after that one request. `mailbox` =
  `listMailboxes(port, false)` (`GET /`), total = sum. `breakdown=assignee` with `assigned`, and
  `breakdown=mailbox` with `mailbox_id`, are refused. A failure after the bucket loop has started does not throw:
  the result has the finished buckets, `incomplete: true`, `error` (class name + redacted message) and
  `requests_made`, and its note says not to retry blindly. `requests_made` reports the cost.
- Live check (2026-10-28, as the agent): `ticket_volume` 2026-10-23..26 by day = 1, 1, 1, 4 (conversation 7 was
  created 2026-10-24); by assignee on 10-26 = agent 1, unassigned 2, other 1; `{q:"#9", status:["active"]}` → [9]
  via `f[number]`. Re-checked after the review fixes (published-only, paced): unchanged.
- No POST path was added: `ticket_volume` hands the search code a port whose `ajaxPost` always rejects.


---

## 11. Reports module (VERIFIED 2026-10-28 from a production install, read-only, via the user's own browser session)

Source of truth: the module's JS (`initReports`, `rptRefresh`, `rptOnFilterChange`, `rptUpdateDateRange` in the
site's `js/builds/*.js`), the rendered `/reports/productivity` and `/reports/satisfaction` pages, and six captured
`POST /reports/ajax` request/response pairs. Install: a current FreeScout with the Reports module (version not checked) (and the Satisfaction
Ratings module). Scrubbed copies are in `docs/fixtures/reports-*` (names → `User <id>` / `Mailbox <id>` /
`tag-<id>` / `Customer <id>`, comments → "Comment text", CSRF → `CSRFTOKEN`, host → support.example.com).
The raw captures were deleted after scrubbing; only the scrubbed fixtures remain.

### 11.1 Routes
| Route | Notes |
|---|---|
| `GET /reports/conversations`, `/reports/productivity`, `/reports/satisfaction`, `/reports/time-tracking` | Report pages. Each renders `form#rpt-filters` and `div#rpt-report[data-report-name=<name>]` (satisfaction also `data-chart-type="pie"`), plus the inline `initReports()`. The page itself contains no numbers: the JS immediately POSTs the ajax below. Nav links to all four pages are in the page |
| `POST /reports/ajax` (laroute name `reports.ajax`) | Sent by `fsAjax`, i.e. the same conventions as `POST /conversation/ajax` (§3: `X-CSRF-TOKEN` header from `<meta name="csrf-token">`, `X-Requested-With: XMLHttpRequest`, urlencoded body, JSON answer). Read-only: it only computes a report |

Not verified: what a non-admin without report permission gets (403, redirect, or the module's own message). The MCP
treats a 403 on the page, a redirect away from `/reports/<name>`, or a page without `#rpt-filters` as "reports not
available to this account" and says so, never as zeros. A non-JSON (or error-envelope) ajax answer after the page
opened is a tool error, also never zeros. A `404` on `GET /reports/productivity` means the module is not installed
(for satisfaction: the Reports module, or the Satisfaction Ratings module it needs, is missing).

### 11.2 Request body (urlencoded; exactly what `rptRefresh()` serialises)
```
action=report
report_name=productivity | satisfaction           (from #rpt-report[data-report-name])
filters[type]=                                     '' | 1 email | 2 phone | 3 chat
filters[mailbox]=15                                '' = all mailboxes the user can see
filters[user]=50                                   OMITTED entirely when no user is selected ("All Users")
filters[tag]=                                      '' | tag id
filters[period]=custom                             custom|today|yesterday|last_7|last_week|this_month|last_month|last_12_months|this_year
filters[from]=2026-10-21                           YYYY-MM-DD
filters[to]=2026-10-30                             YYYY-MM-DD (inclusive)
chart[group_by]=d                                  d | w | m   (only after the report rendered once; see 11.4)
chart[type]=replies                                productivity: customers_helped | replies | closed
```
Observed bodies (verbatim, decoded):
1. first load of `/reports/productivity?period=custom&to=2026-10-30&user=50&mailbox=15`:
   `action=report&report_name=productivity&filters[type]=&filters[mailbox]=15&filters[user]=50&filters[tag]=&filters[period]=custom&filters[from]=2026-10-21&filters[to]=2026-10-30`
   (no `chart[...]` keys: `#rpt-chart-type`/`#rpt-group-by` do not exist before the first answer; the URL had no
   `from`, so the page pre-filled `from` from its own default. Where that default comes from was not checked; it does
   not matter to the MCP, which always sends both `from` and `to`).
2. after changing the chart type: same + `&chart[group_by]=d&chart[type]=replies`.
3. `period=last_12_months`: `filters[period]=last_12_months&filters[from]=2025-10-01&filters[to]=2026-09-30&chart[group_by]=d&chart[type]=replies`
   — the named periods are resolved **client-side** (`rptUpdateDateRange`) and `from`/`to` are always sent, so
   the MCP always sends `period=custom` with explicit dates.
4. all users, 2026-10-01..28, mailbox 15: no `filters[user]` key at all.
5. satisfaction, mailbox 15, 2026-10-01..28:
   `action=report&report_name=satisfaction&filters[type]=&filters[mailbox]=15&filters[tag]=&filters[period]=custom&filters[from]=2026-10-01&filters[to]=2026-10-28`
   (no chart keys ever: the satisfaction report has no chart options).
The URL query (`?period=&from=&to=&user=&mailbox=&type=&tag=`) only pre-fills the form (`rptUpdateFromUrl`).

### 11.3 Response
```json
{"status":"success","msg":"","report":"<html fragment>","chart":{...}}
```
Failures go through `showAjaxResult(response)`, i.e. the usual `{status:"error", msg:"..."}` envelope (not
captured). Productivity `chart`: `{type, group_bys:["d","w","m"], group_by, labels:[...], datasets:[{label:"Current",
data:[...]}, {label:"Previous", data:[...]}]}`. `group_bys` lists what the range allows: 10 and 28 days → `["d"]`
/ `["d","w"]`, 12 months → `["d","w","m"]`. `labels` are display strings in the user's locale: `"Oct 21"` for
days, `"Oct 2, 2025" … "Mar 30, 2026"` for months (FreeScout's own month boundaries are not the 1st; pass labels
through unchanged, never re-derive dates from them). `Previous` is FreeScout's previous period, **inferred** (not
verified) to be the same-length period right before `from`; the MCP says so in every result.
Satisfaction `chart`: `{labels:["Good","Okay","Not Good"], datasets:[{data:[50,0,50], backgroundColor:[...]}]}`
— percentages, no `type`/`group_by`.

### 11.4 `report` HTML fragment (fixtures: `reports-productivity-ajax*.json`, `reports-satisfaction-ajax.json`)
Common: `div.rpt-metrics > div.rpt-metric` each with `.rpt-metric-title` (text node, optionally followed by an
`<i data-toggle="tooltip" title="…">` explaining the metric) and `.rpt-metric-value` (the number as the first text
node, then `span.rpt-metric-change` with class `text-success` / `text-danger` / `text-help` and text like `+24%`,
`-65%`, `0%`: change versus the previous period).

Productivity metrics (in order): Customers Helped, Replies Sent, Replies per Day, Closed, Resolved On First Reply.
Then `#rpt-chart-container > #rpt-options` with `select#rpt-chart-type` (`customers_helped` | `replies` |
`closed`, one `selected`) and `#rpt-group-by button[value=d|w|m]` (`.active` marks the current one; only the
allowed group-bys are rendered). Then `#rpt-tables`:
- two `table.table-striped` with header `First Response Time | % | Δ` and `Response Time | % | Δ`; rows are
  `(bucket label, percent, change span)` with bucket labels such as `< 15 min`, `15-30 min`, `30-60 min`,
  `1-2 hours`, `2-3 hours`, `3-6 hours`, `6-12 hours`, `12-24 hours`, `1-2 days`, `> 2 days` (only non-empty
  buckets are rendered); the last row is `<td><i>Avg.</i></td><td colspan="2"><i>3 h 27 min</i></td>`;
- (added 2026-10-28 from the fixtures while implementing) the all-users fixture `reports-productivity-ajax.json` also
  renders a second row of the same kind of tables: `Resolution Time | % | Δ` (time buckets, `Avg.` `11 h 23 min`) and
  `Replies To Resolve | % | Δ` (bucket labels `1`, `2`, `4`, `Avg.` `1.33`). The one-user and 12-month fixtures do
  not have them; when FreeScout renders them is not known;
- a users table with header `User | Replies Sent | Closed | Customers Helped | Satisfaction Score`; one row per
  user, the name inside `button.rpt-user-btn[data-uid=<user id>]` (clicking it sets `filters[user]`). With a
  user filter the table has one row. Values are plain integers.

Satisfaction metrics: Ratings, Great, Okay, Not Good, Satisfaction Score (no tooltips). No chart options.
`#rpt-tables` has one table with header `# | Customer | User | Rating | Comment`; per row: `<a href="…/conversation/<id>">#<number></a><br/><small class="text-help">Oct 11, 2026 10:04pm</small>`,
`<a href="…/customers/<id>/edit">Customer name</a>`, the `button.rpt-user-btn[data-uid]`, a
`span.text-success|text-help|text-danger` with `Great` / `Okay` / `Not Good`, and the free-text comment (may be
empty). **Customer names and comments are customer-written, untrusted content.**

### 11.4a Live verification (2026-10-28, hosted MCP as user 50, read-only)
Every metric, users-table value, satisfaction count and pie percentage matched the Reports page captured earlier the
same day or drifted upward by a few units (the day was still running). `resolution_time` and `replies_to_resolve`
tables were rendered for the 28-day all-users range but not for the 10-day single-user or 12-month ranges. Week
labels observed: `"Oct 7", "Oct 14", "Oct 21", "Oct 28"` for 2026-10-01..28 (4 points). **Caveat:** with `w`/`m`
grouping the chart `data` carried single-day-sized values (week series `[6,8,10,6]` = the daily series at indices
0, 7, 14, 21; the 12-month `replies` series summed to 80 vs 1391 Replies Sent). The MCP returns FreeScout's JSON
unchanged (the raw browser capture `reports-productivity-ajax-by-month.json` has the same numbers), so this is
FreeScout's chart, not our parsing. Use `d` and sum client-side for per-period totals.

### 11.5 Page `form#rpt-filters` (fixture: `reports-productivity-page.html`)
Selects `type`, `mailbox` (the user's visible mailboxes), `user` (every option has `data-mailboxes="15,21,…"`;
options whose mailboxes do not include the selected mailbox are `disabled` **client-side only**; the first option
`All Users` is `disabled` with value `""`, which is why `filters[user]` is omitted), `tag` (every tag, thousands on
a big install), `period`, inputs `from`/`to` (flatpickr, `YYYY-MM-DD`). `body[data-auth_user_id]` holds the current
user id. The MCP uses this form for: module/permission detection, the list of users (`id`, name, mailboxes) and
mailboxes available to reports, and the CSRF token.

### 11.6 Cost and limits (observed)
A 12-month day-grouped productivity report took several seconds server-side; a 10-day one was quick. Every ajax
call recomputes the report. The MCP caps the range (≤ 366 days) and sends one report request per tool call (no
fan-out, no pacing pause; the session layer may retry it once after a CSRF refresh or re-login).

### What the MCP does with this (2026-10-28, Phase B; no live test: the demo has no Reports module)
Code: `src/reports.ts` (flow, guard), `src/parsers/reports.ts` (fragment and filter form), tools
`productivity_report`, `satisfaction_report`, `list_report_users`.
- **Validation before any request**: `from`/`to` strict `YYYY-MM-DD` real dates, year 1970 or later (`src/dates.ts`), `from <= to`, at
  most 366 days inclusive; ids positive integers; `type` email|phone|chat → `1|2|3`.
- **Page GET** `GET /reports/<name>`: HTTP 404 → `{available:false, reason:"module_not_installed"}`; HTTP 403, a final
  path (after same-origin redirects) other than exactly `<FREESCOUT_URL path>/reports/<name>` (trailing slash
  ignored; e.g. a satisfaction page redirected to `/reports/productivity`), a login form, a page without `form#rpt-filters`,
  or `#rpt-report[data-report-name]` naming another report → `reason:"not_available_to_this_account"`. Both are
  success-shaped results whose `note` points at `ticket_volume`; no POST is sent and no number is returned. Other
  errors (500, cross-origin redirect) are tool errors. Through the real session a redirect to `/login` or a 200 login
  page is an `AuthError` first (dead session; re-login when credentials are configured), not "not available". The
  page's `<meta csrf-token>` is remembered by the session as for every page; `filter_warnings` is set when a
  requested mailbox/user/tag id is not among the page's options (what FreeScout then does is unverified).
- **One report request** per call to `/reports/ajax` (constant `REPORTS_AJAX`, the only literal and call site in
  `src/`; the session layer may retry it once after a CSRF refresh or re-login), urlencoded in the `rptRefresh()` order
  of 11.2, `_token` appended like every ajax POST. The form is built and checked by
  `assertReportForm` right before the POST: exactly `action=report`, `report_name` productivity|satisfaction,
  `filters` = `type` (`''|1|2|3`), `mailbox` (`''` or positive int), `user` (positive int, key **absent** for all
  users), `tag` (`''` or positive int), `period=custom`, `from`, `to` (as above); `chart` = `group_by` d|w|m and
  `type` customers_helped|replies|closed, productivity only, and sent only for a non-default chart: the default
  request (customers_helped by d) carries no chart keys, byte-identical to bodies 1 and 4. Any other key, value or
  type throws before the request.
- **Answer**: `checkAjax` (status must be `success`; a permission `msg` is a `PermissionError`), `report` must be a
  non-empty HTML string with at least one `.rpt-metric`, otherwise a tool error; a non-JSON answer is a tool error; an
  HTTP 403 on the POST is a tool error worded as a Reports permission (not a mailbox one). Metrics: `key` = slug of the title,
  `value` only when the text is a plain number (else `null`, `raw_value` kept), `change_percent`/`change_direction`
  from the sign of the change text. Tables under `#rpt-tables`: header `X | % | Δ` → distribution keyed by slug of X
  (`first_response_time`, `response_time`, `resolution_time`, `replies_to_resolve`, others in
  `other_distributions`), the `colspan` row is `average` verbatim; the table with `button.rpt-user-btn` → users
  (columns by header match only; an unrecognised header is kept verbatim under `extra_columns` keyed by its slug,
  never guessed by position; `raw_values` when a cell is not a plain number; `users: null` with a note when there is
  no users table); the table with conversation links → ratings (rating from the span text, falling back to its
  class; the customer name from the cell text with `id: null` when there is no link). Keys are slugs of the rendered
  titles: on a non-English UI the time tables land in `other_distributions` and the note says the UI language seems
  non-English.
- **Chart**: passed through (`labels` verbatim, `current`/`previous` by dataset label, `group_by` d|w|m → day|week|month).
  Data points that are missing or not numbers (`null`, `""`, gaps) are `null`, never 0, with a note. If the answer's
  `type`/`group_by` differs from the request, or `group_bys` is present and lacks the requested group-by, the result
  has `mismatch` and the note says so; without `group_bys`, `available_group_bys` is `null` (with a note) and only
  `type`/`group_by` are compared. Satisfaction: `distribution` = pie `data[0..2]` by position, `null` when missing.
- **Caps**: one GET and one report request per call, no fan-out, no pacing pause between them; satisfaction returns at most
  500 rated conversations (`ratings_total`, `ratings_truncated`). Customer names and comments only with
  `include_comments: true`, with an untrusted-content notice. `list_report_users` is the GET only.
