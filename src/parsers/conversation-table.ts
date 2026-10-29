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
  /** Inferred: FreeScout lists have no status column (see docs/freescout-endpoints.md §4.2). */
  status: ConversationStatus | null;
  assignee: string | null;
  last_activity: { relative: string | null; by: string | null; at: string | null } | null;
  thread_count: number | null;
  starred: boolean;
  has_attachments: boolean;
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
export function parseConversationTable($: CheerioAPI, base: string, folderType?: FolderType | null): ConversationTable {
  const table = $("table.table-conversations").first();
  const conversations: ConversationRow[] = [];
  table.find("tbody tr.conv-row[data-conversation_id]").each((_, el) => {
    const tr = $(el);
    const id = intOrNull(tr.attr("data-conversation_id"));
    if (id === null) return;
    const classes = (tr.attr("class") ?? "").split(/\s+/);
    const subjectP = tr.find("td.conv-subject a p").not(".conv-preview").first();

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
      customer = {
        name: textOrNull(custTd.find(".conv-customer-name").first().text()),
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
    const tip = dateA.attr("title") ?? dateA.attr("aria-description") ?? "";
    // "Last reply by Customer<br/>Oct 22, 2026 06:42" or "Created by Customer<br/>…"
    const tipM = /^\s*(?:last reply|created)\s+by\s+([^<]+?)\s*<br\s*\/?>\s*(.+)$/i.exec(tip);
    const href = tr.find("td.conv-subject a").first().attr("href") ?? `/conversation/${id}`;

    conversations.push({
      id,
      number: intOrNull(tr.find("td.conv-number a").first().text()),
      subject: squish(subjectP.text()),
      customer,
      preview: textOrNull(tr.find("p.conv-preview").first().text()),
      status,
      assignee,
      last_activity: dateA.length
        ? { relative: textOrNull(dateA.text()), by: tipM ? squish(tipM[1]) : null, at: tipM ? squish(tipM[2]) : textOrNull(tip) }
        : null,
      // .conv-counter is rendered only when threads_count > 1.
      thread_count: custTd.length && !custTd.hasClass("conv-owner-mobile") ? (counter.length ? intOrNull(counter.text()) : 1) : null,
      starred: tr.find("i.conv-star").first().hasClass("glyphicon-star"),
      has_attachments: tr.find("i.glyphicon-paperclip").length > 0,
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
