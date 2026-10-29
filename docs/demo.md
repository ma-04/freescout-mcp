# FreeScout demo instance

- URL: https://freescout.example.com (your demo hostname; `DEMO_HOST` in the compose `.env`, `DEMO_DOMAIN` for `demo/reset.sh`; HTTP 301s to HTTPS)
- FreeScout 1.8.248 in `nfrastack/freescout` (compose: `demo/docker-compose.yml`), MariaDB 10.11 sidecar
- Host: `ssh user@host`, compose dir `~/freescout.example.com/`, containers `freescout-demo`, `freescout-demo-db`
- Run PHP/artisan in the app container as `nginx` (owner of `/www/html`): `docker exec -u nginx freescout-demo php /www/html/artisan …`

## Credentials (server only, never in the repo)
`~/freescout.example.com/.env` on the server:

| Var | Use |
|---|---|
| `ADMIN_EMAIL` / `ADMIN_PASS` | admin@freescout.example.com (role admin, user id 1) |
| `AGENT_PASS` | password for **agent@freescout.example.com** (Demo Agent, role user, user id 2, **Support mailbox only**) |
| `DB_PASS`, `DB_ROOT_PASS` | MariaDB (`freescout` db/user) |

Read one without printing it, e.g. `ssh user@host 'grep ^AGENT_PASS= ~/freescout.example.com/.env | cut -d= -f2-'`.

## Outgoing mail is disabled
- Both mailboxes: `out_method = 3` (SMTP) to `127.0.0.1:2525`, where nothing listens. Customer replies *and* user
  notifications go through the mailbox's outgoing settings, so every send fails with
  `Connection could not be established with host 127.0.0.1 [Connection refused #111]` (visible in `send_logs`).
  Verified: a test note produced one notification attempt to admin, logged in `send_logs` with status 2 (send error).
- System mail option `mail_driver = log` (writes to `storage/logs`, never sends).
- A queue worker (`artisan queue:work`) does run in the container, so do not rely on "no worker".
- Check for leaks: `select * from send_logs;` and `select count(*) from jobs;` (`emails` table = customer email addresses, not outbound mail).

## Modules
None installed (`/data/Modules` empty, `modules` table empty). **No Saved Replies, no Tags**, so no saved replies or tags were seeded.

## Seeded data (ids are deterministic after `demo/reset.sh`)

Mailboxes: **Support = 1** (support@freescout.example.com), **Billing = 2** (billing@freescout.example.com).

Folder ids:

| Mailbox | Unassigned | Drafts | Assigned | Closed | Spam | Deleted | Mine (admin / agent) | Starred (admin / agent) |
|---|---|---|---|---|---|---|---|---|
| Support (1) | 1 | 2 | 3 | 4 | 5 | 6 | 7 / **17** | 8 / **18** |
| Billing (2) | 9 | 10 | 11 | 12 | 13 | 14 | 15 / none | 16 / none |

Conversations (id = number). Status 1 active, 2 pending, 3 closed. Thread types 1 customer, 2 message (agent reply), 3 note.

| id | Mailbox | Subject | Status | Assignee | Agent sees it in | Threads (id:type, oldest first) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Support | Can't log in after password reset | active | none | Unassigned (1) | 1:1 | single message |
| 2 | Support | Webhook deliveries failing with 401 since yesterday | active | agent | Mine (17), Starred (18) | 2:1, 3:2, 4:1 | **starred by agent**, multi-message |
| 3 | Support | Feature request: export reports to CSV | pending | agent | Mine (17) | 5:1, 6:2 | |
| 4 | Support | SSO setup with Okta returns invalid_audience | active | none | Unassigned (1) | 7:1, 8:3 | **internal note by admin** |
| 5 | Support | How do I add teammates to my workspace? | closed | agent | Closed (4) | 9:1, 10:2, 11:1 | multi-message |
| 6 | Support | API rate limit hit at 100 req/min | active | admin | Assigned (3) | 12:1, 13:2 | assigned to someone else |
| 7 | Support | Mobile app crashes on Android 15 when uploading photos | pending | none | Unassigned (1) | 14:1, 15:2 | |
| 8 | Support | Data deletion request (GDPR Art. 17) | closed | admin | Closed (4) | 16:1, 17:2 | |
| 9 | Support | Dashboard charts not loading in Safari 18 | active | agent | Mine (17) | 18:1, 19:3, 20:2 | **note by agent** + reply (fixture) |
| 10 | Billing | Charged twice for October invoice | active | none | (403 for agent) | 21:1 | |
| 11 | Billing | Upgrade from Starter to Pro mid-cycle: how is it prorated? | pending | admin | (403) | 22:1, 23:2 | customer 5 also has Support conv 3 |
| 12 | Billing | Request VAT invoice for 2026 Q3 | closed | admin | (403) | 24:1, 25:2 | customer 8 also has Support conv 8 |

Customers (id: name, email): 1 Maria Lopez maria.lopez@brightpath.example · 2 Tom Becker tom.becker@northwind.example ·
3 Aisha Khan aisha.khan@lumenlabs.example · 4 Priya Natarajan devops@acme-retail.example · 5 Jonas Berg jonas.berg@fjordsoft.example ·
6 Li Wei li.wei@pixelforge.example · 7 Sam O'Connor sam.oconnor@gmail.example · 8 Elena Rossi elena.rossi@verdeco.example ·
9 Carlos Mendes carlos.mendes@tidepool.example · 10 Grace Liu accounts@harborfreight-co.example (Billing only).
All addresses use the reserved `.example` TLD.

Expected agent views (verified with curl as the agent):
- Dashboard: Support card only. `/mailbox/1` (Unassigned) rows 1, 4, 7; `/mailbox/1/17` (Mine) rows 9, 2, 3;
  `/mailbox/1/18` (Starred) row 2; `/mailbox/1/3` (Assigned) row 6; `/mailbox/1/4` (Closed) rows 5, 8.
- `/conversation/10`, `/mailbox/2` → 403. `/search?q=webhook` → conv 2.

## Reset

```sh
DEMO_SSH=user@host DEMO_DOMAIN=freescout.example.com demo/reset.sh   # from the repo root
```

Copies `demo/seed.php` into the container and runs it as `nginx` with `--reset`: deletes all conversations,
threads, customers, drafts, notifications, send logs and queued jobs, resets their auto-increment counters, re-applies
the mail lockdown, updates mailboxes/agent (password re-hashed from `AGENT_PASS`) and reseeds. Prints a JSON summary of
ids. Mailboxes, users and folders are kept, so their ids never change. Without `--reset` the seed refuses to run when
conversations exist.

Integration tests that add notes/drafts should either run `demo/reset.sh` afterwards or discard their drafts
(`action=discard_draft`). Notes can be removed from the UI thread menu (Delete, shown to the note author) or by a reset.
