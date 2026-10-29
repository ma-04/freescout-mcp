# Capturing the FreeScout Reports module (for the support lead)

> **Status (2026-10-28): done.** The capture from our production install is documented in
> docs/freescout-endpoints.md §11 (scrubbed fixtures in `docs/fixtures/reports-*`), and the tools
> `productivity_report`, `satisfaction_report` and `list_report_users` are built on it. This guide stays for
> capturing other installs or Reports-module versions.

## Why

We want two new MCP tools, `productivity_report` and `satisfaction_report`, that read the numbers
from FreeScout's paid **Reports** module. That module is not installed on our demo server, and
Claude never logs in to production (https://support.example.com/). This repo only documents
FreeScout endpoints from real captured traffic, never from guesses, so we need you to record what
your browser sends and receives while you click through the Reports pages, clean that recording
with a script, and leave the files on disk for Claude.

**The sanitized capture keeps:** request URLs, methods, query and form fields (CSRF tokens blanked)
and the response bodies of `/reports` requests. Those bodies can contain agent names, ticket counts
and, on the Satisfaction tab, customer rating comments. Look through the file before sharing it.

**It removes:** all cookies, all headers except `content-type`, `x-requested-with` and `accept`,
authorization and CSRF headers, the value of every field whose name contains `token`, `password`,
`passwd`, `secret`, `csrf`, `xsrf`, `api_key`/`apikey`, `auth`, `cookie`, `remember` or `session`
(in query strings, form, multipart and JSON bodies, and HTML inputs, at any nesting depth, also in
HTML embedded in JSON), Laravel encrypted values anywhere, binary bodies (exports) and
`<script>`/`<style>` blocks in HTML pages. Every secret value it saw is then removed wherever else
it appears in the output, and the script refuses to write if one would survive. Requests for other
pages and for images, scripts and fonts are dropped. It will not overwrite the input `.har`.

The raw `.har` export **does** contain your session cookie. Treat it like a password: keep it in
`captures/`, never send it anywhere, and delete it once the sanitized file exists.

## 1. Note your setup (plain text)

Create `captures/reports-notes.txt` and write down:

1. The FreeScout version (Manage → System).
2. Every module listed under Manage → Modules, with its version (Reports, Satisfaction Ratings,
   Time Tracking, and so on).
3. Whether your account is an admin.

## 2. Record the browser traffic

Use Chrome, Edge or Firefox, logged in to FreeScout as usual.

1. Open the **Reports** page from the top menu.
2. Open DevTools: F12, or Cmd+Option+I on macOS. Go to the **Network** tab.
3. Tick **Preserve log** (Firefox: the gear icon → **Persist Logs**).
4. Click the clear button (the circle with a line through it, or the trash can in Firefox).
5. Do exactly these actions, in order. After each one, wait until the page has finished updating
   before moving on:
   1. **Productivity** tab with its default date range.
   2. Change the date range to a custom one, for example the last 30 days.
   3. If the page offers a grouping or period (day / week / month), change it once.
   4. Select one specific user (agent).
   5. Select one mailbox.
   6. **Satisfaction** tab, then repeat steps 1 to 5 there (default, custom range, grouping,
      one user, one mailbox).
   7. Any other tabs you see (Customers, Time tracking, Tags, ...): open each once with defaults.
   8. Reload the Reports page once (F5 / Cmd+R), so the full HTML of the page itself is recorded.
6. Export the recording:
   - **Chrome / Edge:** right-click any row in the Network list → **Save all as HAR** (or the
     download-arrow "Export HAR..." button). If asked, choose the option **with sensitive data**;
     the sanitizer removes it in step 4 below.
   - **Firefox:** right-click any row → **Save All As HAR**.
7. Save the file as `captures/reports.har` inside this repository folder (create `captures/` if it
   does not exist; it is git-ignored and never committed).

## 3. Save two pages as HTML

1. Go to the **Productivity** tab, change the date range, and wait for it to update.
2. Browser menu → **Save page as...** → format **Webpage, HTML only** → save as
   `captures/reports-productivity.html`.
3. Do the same on the **Satisfaction** tab and save as `captures/reports-satisfaction.html`.

These HTML files are not sanitized by the script. Open them in a text editor and search for
anything you would not want shared (for example a `csrf-token` value); blank it if found.

## 4. Sanitize the capture

In a terminal, from the repository folder (Node 20 or newer):

```sh
node scripts/sanitize-har.mjs captures/reports.har captures/reports.sanitized.json
```

The script prints how many requests it kept and dropped. If it kept 0, your Reports URLs may not
contain `/reports`; rerun with `--keep-path <part of the URL>` (repeatable) or `--all-paths`
(keeps every non-static request, so review that output more carefully). Run with `--help` for all
options.

Then open `captures/reports.sanitized.json` and skim it. Search for `laravel_session`,
`Cookie` and `eyJ`; none of them should appear as values. Agent names and emails in report
tables are expected; remove anything you are not comfortable sharing. Once you are happy, delete
`captures/reports.har`.

## 5. Hand over

Tell Claude the files are in `captures/`:

- `captures/reports.sanitized.json`
- `captures/reports-productivity.html`
- `captures/reports-satisfaction.html`
- `captures/reports-notes.txt`

## What happens next

1. Claude reads the capture and documents the Reports endpoints in
   `docs/freescout-endpoints.md`, replacing real names, emails and IDs with placeholders.
2. Claude adds parser fixtures built from placeholder data, then builds `productivity_report` and
   `satisfaction_report` against those fixtures, read-only.
3. You try the tools against production with your own session; any mismatch goes back to step 2
   of this guide with a narrower capture.
