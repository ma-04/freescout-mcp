import type { CheerioAPI } from "cheerio";
import type { FolderType } from "./mailbox.js";
import { intOrNull, squish, textOrNull } from "./text.js";

export type ConversationStatus = "active" | "pending" | "closed" | "spam";

export interface ConversationRow {
  id: number;
  number: number | null;
  subject: string;
  customer: { name: string | null; email: string | null } | null;
  preview: string | null;
  /**
   * Mailbox name from the `[Name]<br>` prefix FreeScout puts in front of the preview when a list spans mailboxes
   * (search results). Only read when the table is marked `data-param_show_mailbox="1"` (FreeScout's own switch for
   * that prefix); null otherwise, so a preview that merely starts with "[Text]<br>" is left alone. The mailbox id is
   * not in the row.
   */
  mailbox_name: string | null;
  /** Inferred: FreeScout lists have no status column (see docs/freescout-endpoints.md §4.2). */
  status: ConversationStatus | null;
  assignee: string | null;
  last_activity: { relative: string | null; by: string | null; at: string | null } | null;
  thread_count: number | null;
  starred: boolean;
  has_attachments: boolean;
  /**
   * Tag names from the Tags module's chips (`span.conv-tags` inside the subject paragraph), in display order,
   * deduplicated. Always [] where the module is not installed.
   */
  tags: string[];
  url: string;
}

export interface ConversationTable {
  conversations: ConversationRow[];
  page: number;
  total: number | null;
  active: number | null;
  range: { from: number; to: number } | null;
  has_next_page: boolean;
  last_page: number | null;
}

/**
 * `table.table-conversations` as rendered on folder pages, search results and the
 * customer page. Columns differ per page, so every field is optional.
 * `folderType` is the folder being listed (if any); it is the only status source
 * for rows in Closed/Spam folders, which carry no badge.
 */
/**
 * Split `<p class="conv-preview">[Mailbox]<br>text</p>` into the mailbox name and the preview text. `showMailbox` is
 * the table's `data-param_show_mailbox`: FreeScout's conversations table emits the prefix only when it is set, so
 * without it the preview is returned untouched (a folder-list preview "[URGENT]<br>..." is the customer's text).
 */
function splitPreview(
  $: CheerioAPI,
  p: ReturnType<CheerioAPI>,
  showMailbox: boolean,
): { mailbox_name: string | null; preview: string | null } {
  if (!p.length) return { mailbox_name: null, preview: null };
  if (!showMailbox) return { mailbox_name: null, preview: textOrNull(p.text()) };
  const clone = p.clone();
  const nodes = clone.contents().toArray().filter((n) => !(n.type === "text" && !squish($(n).text())));
  const first = nodes[0];
  const second = nodes[1];
  if (first?.type === "text" && second?.type === "tag" && (second as { name?: string }).name === "br") {
    const m = /^\s*\[(.+)\]\s*$/s.exec($(first).text());
    if (m) {
      $(first).remove();
      $(second).remove();
      return { mailbox_name: textOrNull(m[1]), preview: textOrNull(clone.text()) };
    }
  }
  return { mailbox_name: null, preview: textOrNull(p.text()) };
}

export function parseConversationTable($: CheerioAPI, base: string, folderType?: FolderType | null): ConversationTable {
  const table = $("table.table-conversations").first();
  const conversations: ConversationRow[] = [];
  const showMailboxAttr = squish(table.attr("data-param_show_mailbox"));
  const showMailbox = showMailboxAttr !== "" && showMailboxAttr !== "0";
  table.find("tbody tr.conv-row[data-conversation_id]").each((_, el) => {
    const tr = $(el);
    const id = intOrNull(tr.attr("data-conversation_id"));
    if (id === null) return;
    const classes = (tr.attr("class") ?? "").split(/\s+/);
    const subjectP = tr.find("td.conv-subject a p").not(".conv-preview").first();
    // The Tags module renders its chips inside the subject paragraph: read them, then read the subject without them.
    // Deduplicated case-insensitively, first spelling kept (the key tagKey uses in operations.ts: the server
    // normalises tag names, so "Billing" and "billing" are one tag).
    const tags: string[] = [];
    const tagKeys = new Set<string>();
    subjectP.find(".conv-tags .tag").each((_, t) => {
      const name = squish($(t).text());
      const key = name.toLowerCase();
      if (name && !tagKeys.has(key)) {
        tagKeys.add(key);
        tags.push(name);
      }
    });
    const subjectText = squish(subjectP.clone().find(".conv-tags").remove().end().text());

    // Status: explicit badges first (lock/ban-circle are rendered outside the matching folder).
    let status: ConversationStatus | null;
    if (classes.includes("conv-spam") || subjectP.find("i.glyphicon-ban-circle").length) status = "spam";
    else if (subjectP.find("i.glyphicon-lock").length) status = "closed";
    else if (classes.includes("conv-active")) status = "active";
    else if (folderType === "closed") status = "closed";
    else if (folderType === "spam") status = "spam";
    else status = "pending";

    const custTd = tr.find("td.conv-customer").first();
    let customer: ConversationRow["customer"] = null;
    let assignee: string | null = null;
    if (custTd.length && !custTd.hasClass("conv-owner-mobile")) {
      const a = custTd.find("a").first();
      // Demo (1.8.248) wraps the name in .conv-customer-name; the production install renders it as the link's own text.
      const nameEl = custTd.find(".conv-customer-name").first();
      const ownText = a
        .contents()
        .toArray()
        .filter((n) => n.type === "text")
        .map((n) => $(n).text())
        .join(" ");
      customer = {
        name: nameEl.length ? textOrNull(nameEl.text()) : textOrNull(ownText),
        email: textOrNull(custTd.find(".conv-email").first().text()) ?? textOrNull(a.attr("title")),
      };
      assignee = textOrNull(custTd.find(".conv-owner-mobile").first().text());
    } else if (custTd.length) {
      // Customer page: this cell only holds the assignee ("<i class=glyphicon-user></i> Name").
      assignee = textOrNull(custTd.find("small").filter((_, s) => $(s).find("i.glyphicon-user").length > 0).first().text());
    }
    const ownerTd = tr.find("td.conv-owner").first();
    if (ownerTd.length) assignee = textOrNull(ownerTd.text()) ?? assignee;

    const counter = custTd.find(".conv-counter").first();
    const dateA = tr.find("td.conv-date a").first();
    // Server HTML has the tooltip in title (and aria-description); after Bootstrap's tooltip init (a browser capture)
    // title is "" and the text sits in data-original-title, so empty strings must fall through.
    const tip = dateA.attr("title") || dateA.attr("aria-description") || dateA.attr("data-original-title") || "";
    // "Last reply by Customer<br/>Oct 22, 2026 06:42" or "Created by Customer<br/>…"
    const tipM = /^\s*(?:last reply|created)\s+by\s+([^<]+?)\s*<br\s*\/?>\s*(.+)$/i.exec(tip);
    const href = tr.find("td.conv-subject a").first().attr("href") ?? `/conversation/${id}`;

    conversations.push({
      id,
      number: intOrNull(tr.find("td.conv-number a").first().text()),
      subject: subjectText,
      customer,
      ...splitPreview($, tr.find("p.conv-preview").first(), showMailbox),
      status,
      assignee,
      last_activity: dateA.length
        ? { relative: textOrNull(dateA.text()), by: tipM ? squish(tipM[1]) : null, at: tipM ? squish(tipM[2]) : textOrNull(tip) }
        : null,
      // .conv-counter is rendered only when threads_count > 1.
      thread_count: custTd.length && !custTd.hasClass("conv-owner-mobile") ? (counter.length ? intOrNull(counter.text()) : 1) : null,
      starred: tr.find("i.conv-star").first().hasClass("glyphicon-star"),
      has_attachments: tr.find("i.glyphicon-paperclip").length > 0,
      tags,
      url: new URL(href, base).toString(),
    });
  });

  const totals = table.find("tfoot td.conv-totals").first();
  const strongs = totals.find("strong").toArray().map((s) => intOrNull($(s).text()));
  const totalsText = squish(totals.text());
  let total: number | null = null;
  let active: number | null = null;
  let range: ConversationTable["range"] = null;
  if (strongs.length) {
    total = strongs[0] ?? null;
    if (/active/i.test(totalsText) && strongs.length >= 4) active = strongs[1] ?? null;
    const from = strongs[strongs.length - 2];
    const to = strongs[strongs.length - 1];
    if (strongs.length >= 3 && from != null && to != null) range = { from, to };
  }
  const next = table.find("a.pager-next").first();
  const last = table.find("a.pager-last").first();
  const page = intOrNull(table.attr("data-page")) ?? 1;
  if (!table.length || $(".empty-content").length) total = total ?? 0;
  return {
    conversations,
    page,
    total,
    active,
    range,
    has_next_page: next.length > 0 && !next.hasClass("disabled"),
    last_page: last.length ? intOrNull(last.attr("data-page")) : 1,
  };
}
