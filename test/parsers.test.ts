import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { parseConversation } from "../src/parsers/conversation.js";
import { parseConversationTable } from "../src/parsers/conversation-table.js";
import { parseCustomerEdit, parseCustomerSearch, parseCustomerSnippet } from "../src/parsers/customer.js";
import { parseDashboard, parseMailboxSidebar } from "../src/parsers/mailbox.js";
import { htmlToText } from "../src/parsers/text.js";

const BASE = "https://freescout.example.com/";
const fixture = (name: string) => cheerio.load(readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8"));

describe("htmlToText", () => {
  it("keeps paragraphs, line breaks, lists and useful link targets", () => {
    const t = htmlToText(
      "<p>Hi&nbsp;there,</p><p>Line one<br>line two</p><ul><li>a</li><li>b</li></ul><p><a href='https://x.example/a'>docs</a> and <a href='https://y.example'>https://y.example</a></p><script>x()</script>",
    );
    expect(t).toBe("Hi there,\n\nLine one\nline two\n\n- a\n- b\n\ndocs (https://x.example/a) and https://y.example");
  });
});

describe("dashboard / sidebar", () => {
  it("lists only the mailboxes on the dashboard with their folder links", () => {
    const boxes = parseDashboard(fixture("dashboard.html"), BASE);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ id: 1, name: "Support", email: "support@freescout.example.com" });
    expect(boxes[0]!.folders.map((f) => [f.id, f.type, f.active_count])).toEqual([
      [1, "unassigned", 2],
      [17, "mine", 2],
      [18, "starred", 1],
      [2, "drafts", 0],
      [3, "assigned", 1],
    ]);
  });

  it("parses the mailbox sidebar folders with types from icon classes", () => {
    const side = parseMailboxSidebar(fixture("mailbox-folder-mine.html"), BASE);
    expect(side.mailbox_id).toBe(1);
    expect(side.name).toBe("Support");
    expect(side.current_folder_id).toBe(17);
    expect(side.folders.map((f) => `${f.id}:${f.type}`)).toEqual(["1:unassigned", "17:mine", "18:starred", "3:assigned", "4:closed", "5:spam"]);
    const drafts = parseMailboxSidebar(fixture("mailbox-drafts-empty.html"), BASE);
    expect(drafts.folders.find((f) => f.current)).toMatchObject({ id: 2, type: "drafts" });
  });
});

describe("conversation table", () => {
  it("parses the Mine folder rows", () => {
    const t = parseConversationTable(fixture("mailbox-folder-mine.html"), BASE, "mine");
    expect(t.conversations.map((c) => c.id)).toEqual([9, 2, 3]);
    expect(t).toMatchObject({ total: 3, active: 2, range: { from: 1, to: 3 }, has_next_page: false, page: 1 });
    expect(t.conversations[0]).toMatchObject({
      id: 9,
      number: 9,
      subject: "Dashboard charts not loading in Safari 18",
      customer: { name: "Carlos Mendes", email: "carlos.mendes@tidepool.example" },
      status: "active",
      assignee: "Demo Agent",
      thread_count: 2,
      starred: false,
      last_activity: { by: "User", at: "Oct 22, 2026 08:58", relative: "1 hour ago" },
      url: "https://freescout.example.com/conversation/9?folder_id=17",
    });
    expect(t.conversations[0]!.preview).toMatch(/^Hi Carlos, Thanks for the console output/);
    expect(t.conversations[1]).toMatchObject({ id: 2, starred: true, thread_count: 3, status: "active" });
    expect(t.conversations[2]).toMatchObject({ id: 3, status: "pending" });
  });

  it("parses the Unassigned folder (no assignee) and an empty folder", () => {
    const t = parseConversationTable(fixture("mailbox-unassigned.html"), BASE, "unassigned");
    expect(t.conversations.map((c) => [c.id, c.status, c.assignee])).toEqual([
      [1, "active", null],
      [4, "active", null],
      [7, "pending", null],
    ]);
    expect(t.conversations[0]!.last_activity?.by).toBe("Customer");
    const empty = parseConversationTable(fixture("mailbox-drafts-empty.html"), BASE, "drafts");
    expect(empty.conversations).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it("parses search results (with Assigned To column)", () => {
    const t = parseConversationTable(fixture("search-safari.html"), BASE, null);
    expect(t.conversations).toHaveLength(1);
    expect(t.conversations[0]).toMatchObject({ id: 9, assignee: "Demo Agent", customer: { email: "carlos.mendes@tidepool.example" } });
    expect(t).toMatchObject({ total: 1, range: { from: 1, to: 1 } });
  });

  it("parses the customer page table (no customer column)", () => {
    const t = parseConversationTable(fixture("customer-9.html"), BASE, null);
    expect(t.conversations).toHaveLength(1);
    expect(t.conversations[0]).toMatchObject({ id: 9, customer: null, assignee: "Demo Agent", status: "active" });
    expect(t.conversations[0]!.tags).toEqual([]);
  });

  it("demo rows (no Tags module) have tags: [] and an unchanged subject", () => {
    for (const f of ["mailbox-folder-mine.html", "mailbox-unassigned.html", "search-safari.html", "search-filters-only.html"]) {
      for (const c of parseConversationTable(fixture(f), BASE, null).conversations) expect(c.tags).toEqual([]);
    }
  });

  it("separates the Tags module's chips from the subject (production markup, synthetic values)", () => {
    const t = parseConversationTable(fixture("search-results-tags.html"), BASE, null);
    expect(t).toMatchObject({ total: 1234, range: { from: 1, to: 50 }, has_next_page: true, last_page: 25 });
    expect(t.conversations.map((c) => [c.id, c.subject, c.tags, c.status])).toEqual([
      [1001, "Subject one", [], "active"],
      [1002, "Subject two", ["tag-alpha", "tag-beta"], "active"],
      [1003, "Subject three", ["tag-gamma"], "closed"],
      [1004, "Subject four", ["tag-delta", "tag-epsilon", "tag-zeta"], "pending"],
    ]);
    // Production rows have no .conv-customer-name span; the name is the link's own text.
    expect(t.conversations.map((c) => [c.customer?.name ?? null, c.assignee, c.thread_count])).toEqual([
      ["Mail Delivery Subsystem", null, 1],
      ["Pat Example", "Agent One", 2],
      ["Robin Test", "Agent Two", 8],
      ["Sam Placeholder", "Agent One", 11],
    ]);
    // Rendered DOM: title="" and the tooltip moved to data-original-title; aria-description still has it.
    expect(t.conversations.map((c) => c.last_activity)).toEqual([
      { relative: "53 min ago", by: "Customer", at: "Oct 31, 2026 05:27pm" },
      { relative: "1 day ago", by: "Customer", at: "Oct 30, 2026 05:29am" },
      { relative: "3 days ago", by: "User", at: "Oct 28, 2026 05:37pm" },
      { relative: "2 days ago", by: "User", at: "Oct 29, 2026 10:25am" },
    ]);
    expect(t.conversations[0]!.has_attachments).toBe(true);
    expect(t.conversations[0]!.customer).toEqual({ name: "Mail Delivery Subsystem", email: null });
    // Cross-mailbox results prefix the preview with "[Mailbox name]<br>".
    expect(t.conversations.map((c) => c.mailbox_name)).toEqual(Array(4).fill("Example Support"));
    expect(t.conversations[1]!.preview).toBe("Preview two.");
    expect(t.conversations[0]!.preview).toBe("Preview one. Sent to someone@example.com.");
  });

  it("mailbox_name only on show-mailbox tables with the [Name]<br> prefix; elsewhere the preview is untouched", () => {
    for (const f of ["mailbox-folder-mine.html", "mailbox-unassigned.html", "search-safari.html", "customer-9.html"]) {
      for (const c of parseConversationTable(fixture(f), BASE, null).conversations) expect(c.mailbox_name).toBeNull();
    }
    const row = (preview: string, showMailbox = "1") =>
      parseConversationTable(
        cheerio.load(
          `<table class="table-conversations" data-param_show_mailbox="${showMailbox}"><tbody><tr class="conv-row" data-conversation_id="7"><td class="conv-subject">` +
            `<a href="/conversation/7"><p>S</p><p class="conv-preview">${preview}</p></a></td></tr></tbody></table>`,
        ),
        BASE,
        null,
      ).conversations[0]!;
    expect(row("[Billing] see invoice")).toMatchObject({ mailbox_name: null, preview: "[Billing] see invoice" });
    expect(row("[Billing]<br>see invoice")).toMatchObject({ mailbox_name: "Billing", preview: "see invoice" });
    expect(row(" [Sales &amp; Support] <br/>hi there")).toMatchObject({ mailbox_name: "Sales & Support", preview: "hi there" });
    expect(row("")).toMatchObject({ mailbox_name: null, preview: null });
    // A folder list (no data-param_show_mailbox) or a single-mailbox search (empty) never splits the customer's text.
    const folder = parseConversationTable(
      cheerio.load(
        `<table class="table-conversations"><tbody><tr class="conv-row conv-active" data-conversation_id="8"><td class="conv-subject">` +
          `<a href="/conversation/8"><p>S</p><p class="conv-preview">[URGENT]<br>site is down</p></a></td></tr></tbody></table>`,
      ),
      BASE,
      "unassigned",
    ).conversations[0]!;
    expect(folder).toMatchObject({ mailbox_name: null, preview: "[URGENT]site is down" });
    expect(row("[URGENT]<br>site is down", "")).toMatchObject({ mailbox_name: null, preview: "[URGENT]site is down" });
  });

  it("dedupes tags, keeps their order, and still sees the lock badge next to them", () => {
    const html =
      `<table class="table-conversations"><tbody><tr class="conv-row" data-conversation_id="5"><td class="conv-subject">` +
      `<a href="/conversation/5"><p><i class="glyphicon glyphicon-lock"></i> <span class="conv-tags">` +
      `<span class="tag">b</span> <span class="tag">a</span> <span class="tag">b</span><span class="tag"> </span>` +
      `<span class="tag">Billing</span> <span class="tag">billing</span> <span class="tag">BILLING </span></span>&nbsp;Hello</p>` +
      `<p class="conv-preview">x</p></a></td></tr></tbody></table>`;
    const [row] = parseConversationTable(cheerio.load(html), BASE, null).conversations;
    expect(row).toMatchObject({ id: 5, subject: "Hello", tags: ["b", "a", "Billing"], status: "closed" });
  });

  it("only the title tooltip shapes: a plain title still parses (server-rendered HTML)", () => {
    const html =
      `<table class="table-conversations"><tbody><tr class="conv-row conv-active" data-conversation_id="6"><td class="conv-subject">` +
      `<a href="/conversation/6"><p>Hi</p></a></td><td class="conv-date"><a title="Last reply by Customer&lt;br/&gt;Oct 30, 2026 05:29am">1 day ago</a></td></tr></tbody></table>`;
    const [row] = parseConversationTable(cheerio.load(html), BASE, null).conversations;
    expect(row!.last_activity).toEqual({ relative: "1 day ago", by: "Customer", at: "Oct 30, 2026 05:29am" });
  });
});

describe("conversation page", () => {
  it("parses conversation 9: header, customer and threads oldest first", () => {
    const c = parseConversation(fixture("conversation-9.html"), "https://freescout.example.com/conversation/9?folder_id=17");
    expect(c).toMatchObject({
      id: 9,
      number: 9,
      subject: "Dashboard charts not loading in Safari 18",
      mailbox_id: 1,
      mailbox_name: "Support",
      folder_id: 17,
      type: "email",
      status: "active",
      status_value: 1,
      assignee_id: 2,
      starred: false,
      current_user_id: 2,
      customer: { id: 9, name: "Carlos Mendes", email: "carlos.mendes@tidepool.example", extra: "Tidepool Media" },
      created_at: "Oct 22, 2026 05:48",
      updated_at: "Oct 22, 2026 08:58",
    });
    expect(c.threads.map((t) => [t.thread_id, t.type])).toEqual([
      [18, "customer"],
      [19, "note"],
      [20, "message"],
    ]);
    const [msg, note, reply] = c.threads;
    expect(msg).toMatchObject({ author: { kind: "customer", id: 9, name: "Carlos Mendes" }, to: ["support@freescout.example.com"], status_snapshot: "Demo Agent, Active" });
    expect(msg!.body).toContain("TypeError: undefined is not a function");
    expect(note).toMatchObject({ author: { kind: "user", id: 2, is_current_user: true }, date: "Oct 22, 2026 08:48" });
    // A plain note on a real page is not mistaken for a forward note (forward markers are best-effort).
    expect(note!.is_forward).toBeUndefined();
    expect(note!.forwarded_conversation_number).toBeUndefined();
    expect(c.threads.every((t) => !("is_forward" in t))).toBe(true);
    expect(note!.body).toBe("Reproduced on Safari 18.1. Intl.DurationFormat polyfill is missing from the charts bundle. Filed ENG-5823.");
    expect(reply!.body).toBe(
      "Hi Carlos,\n\nThanks for the console output, that pinpointed it. We've reproduced the issue and our engineers are working on a fix. As a workaround, Chrome or Firefox will display the charts correctly.\n\nDemo Agent",
    );
  });

  it("parses a draft thread (body directly in .thread-body, author 'you' without link) on an unassigned conversation", () => {
    const c = parseConversation(fixture("conversation-1-draft.html"), "https://freescout.example.com/conversation/1?folder_id=1");
    expect(c.assignee_id).toBe(-1);
    expect(c.assignee).toBeNull();
    expect(c.threads.map((t) => [t.thread_id, t.type])).toEqual([
      [1, "customer"],
      [26, "draft"],
    ]);
    expect(c.threads[1]).toMatchObject({ body: "Draft capture test\n\nline two & more", author: { kind: "user", id: 2, is_current_user: true } });
  });
});

describe("customer pages", () => {
  it("parses snippet, edit form and customer search cards", () => {
    expect(parseCustomerSnippet(fixture("customer-9.html"))).toEqual({
      id: 9,
      name: "Carlos Mendes",
      email: "carlos.mendes@tidepool.example",
      extra: "Tidepool Media",
    });
    expect(parseCustomerEdit(fixture("customer-9-edit.html"))).toMatchObject({
      first_name: "Carlos",
      last_name: "Mendes",
      emails: ["carlos.mendes@tidepool.example"],
      company: "Tidepool Media",
      job_title: null,
      phones: [],
    });
    expect(parseCustomerSearch(fixture("search-customers-carlos.html"))).toEqual([
      { id: 9, name: "Carlos Mendes", email: "carlos.mendes@tidepool.example" },
    ]);
  });
});
