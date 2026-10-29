import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { ConversationStatus } from "./conversation-table.js";
import { htmlToText, intOrNull, squish, textOrNull } from "./text.js";

export type ThreadType = "customer" | "message" | "note" | "draft" | "lineitem" | "chat";
const THREAD_TYPES: readonly ThreadType[] = ["customer", "message", "note", "draft", "lineitem", "chat"];

/** Conversation::STATUS_* (app/Conversation.php). */
export const STATUS_BY_VALUE: Record<number, ConversationStatus> = { 1: "active", 2: "pending", 3: "closed", 4: "spam" };

export interface ThreadAuthor {
  kind: "user" | "customer" | "unknown";
  id: number | null;
  name: string | null;
  /** True when FreeScout rendered the author as "you" (the logged-in user). */
  is_current_user: boolean;
}

export interface Attachment {
  name: string;
  size: string | null;
  mime: string | null;
  url: string | null;
}

export interface ParsedThread {
  thread_id: number | null;
  type: ThreadType | null;
  author: ThreadAuthor | null;
  /** Absolute timestamp as FreeScout shows it, in the user's timezone (e.g. "Oct 22, 2026 08:58"). */
  date: string | null;
  date_relative: string | null;
  to: string[];
  cc: string[];
  /** Assignee/status snapshot FreeScout prints on some threads, e.g. "Demo Agent, Active". */
  status_snapshot: string | null;
  body: string;
  attachments: Attachment[];
  /**
   * Present (true) only on a note that FreeScout marks as a forward (`Thread::SUBTYPE_FORWARD`, shown with a
   * `.thread-badge`). Detection is best-effort: the real forward-note markup has not been captured yet.
   */
  is_forward?: true;
  /** On a forward note: the `#number` of the new "Fwd:" conversation, when the page links it. */
  forwarded_conversation_number?: number;
}

export interface ParsedConversation {
  id: number;
  number: number | null;
  subject: string | null;
  mailbox_id: number | null;
  mailbox_name: string | null;
  folder_id: number | null;
  type: string | null;
  status: ConversationStatus | null;
  status_value: number | null;
  /** Assignee user id; -1 means unassigned ("Anyone"). */
  assignee_id: number | null;
  assignee: string | null;
  starred: boolean;
  customer: { id: number | null; name: string | null; email: string | null; extra: string | null } | null;
  current_user_id: number | null;
  /**
   * True when FreeScout rendered the "New Conversation" (create) view: the conversation itself is an
   * unsent draft (conversations.state = 1). It has no status/assignee menus and no threads; replying
   * or adding a note there (send_reply) would publish, i.e. send, it.
   */
  is_draft_conversation: boolean;
  /** Oldest and newest thread timestamps (FreeScout does not print created/updated separately). */
  created_at: string | null;
  updated_at: string | null;
  threads: ParsedThread[];
  url: string;
}

function userIdFromHref(href: string | undefined): number | null {
  const m = /\/users\/profile\/(\d+)/.exec(href ?? "");
  return m ? Number(m[1]) : null;
}
function customerIdFromHref(href: string | undefined): number | null {
  const m = /\/customers\/(\d+)/.exec(href ?? "");
  return m ? Number(m[1]) : null;
}

/** Conversation page `GET /conversation/{id}?folder_id=…` (resources/views/conversations/view.blade.php). */
export function parseConversation($: CheerioAPI, pageUrl: string): ParsedConversation {
  const body = $("body");
  const currentUserId = intOrNull(body.attr("data-auth_user_id"));
  const navName = textOrNull($(".nav-user").first().text());
  const id = intOrNull(body.attr("data-conversation_id")) ?? intOrNull(/\/conversation\/(\d+)/.exec(pageUrl)?.[1]);
  if (id === null) throw new Error("Not a FreeScout conversation page (no data-conversation_id)");

  const statusA = $("#conv-status ul.conv-status li.active a[data-status]").first();
  const statusValue = intOrNull(statusA.attr("data-status")) ?? intOrNull($('select[name="status"]').attr("data-note-status"));
  const assigneeA = $("#conv-assignee ul.conv-user li.active a[data-user_id]").first();
  let assigneeId = intOrNull(assigneeA.attr("data-user_id"));
  let assignee = textOrNull($("#conv-assignee .conv-info-val span").first().text());
  if (assigneeId === null && assignee && /^anyone$/i.test(assignee)) assigneeId = -1;
  if (assigneeId === -1) assignee = null;
  else if (assignee && /^me$/i.test(assignee)) assignee = navName ? `${navName} (you)` : "you";

  const snippet = $("#conv-layout-customer .customer-snippet").first();
  const custA = snippet.find("a.customer-name").first();
  const customer = snippet.length
    ? {
        id: customerIdFromHref(custA.attr("href")),
        name: textOrNull(custA.text()),
        email: textOrNull(snippet.find(".customer-email a.contact-main").first().text()),
        extra: textOrNull(snippet.find(".customer-extra").first().text()),
      }
    : null;

  const isDraftConversation =
    $("#conv-layout").hasClass("conv-new") || $('input[name="is_create"]').length > 0 || $("#form-create").length > 0;
  const typeClass = ($("#conv-layout").attr("class") ?? "").split(/\s+/).find((c) => c.startsWith("conv-type-"));
  const subject =
    textOrNull($("#conv-subject .conv-subjtext > span").first().text()) ?? textOrNull($("#conv-subj-value").attr("value"));

  // Threads are rendered newest first; we return them oldest first.
  const threads = $("#conv-layout-main > div.thread")
    .toArray()
    .map((el) => parseThread($, $(el), pageUrl, currentUserId, navName))
    .reverse();
  const dated = threads.filter((t) => t.date);

  return {
    id,
    number: intOrNull($("#conv-subject .conv-numnav strong").first().text()),
    subject,
    mailbox_id: intOrNull(body.attr("data-mailbox_id")),
    mailbox_name: textOrNull($(".sidebar-title-real.mailbox-name").first().text()),
    folder_id: intOrNull(new URL(pageUrl).searchParams.get("folder_id")),
    type: typeClass ? typeClass.slice("conv-type-".length) : null,
    status: statusValue !== null ? (STATUS_BY_VALUE[statusValue] ?? null) : null,
    status_value: statusValue,
    assignee_id: assigneeId,
    assignee,
    starred: $("#conv-subject .conv-numnav i.conv-star").first().hasClass("glyphicon-star"),
    customer,
    current_user_id: currentUserId,
    is_draft_conversation: isDraftConversation,
    created_at: dated[0]?.date ?? null,
    updated_at: dated[dated.length - 1]?.date ?? null,
    threads,
    url: pageUrl,
  };
}

function parseThread(
  $: CheerioAPI,
  el: ReturnType<CheerioAPI>,
  base: string,
  currentUserId: number | null,
  navName: string | null,
): ParsedThread {
  const classes = (el.attr("class") ?? "").split(/\s+/);
  const typeClass = classes.find((c) => c.startsWith("thread-type-"))?.slice("thread-type-".length) ?? "";
  const type = (THREAD_TYPES as readonly string[]).includes(typeClass) ? (typeClass as ThreadType) : null;
  const threadId = intOrNull(el.attr("data-thread_id")) ?? intOrNull(/^thread-(\d+)$/.exec(el.attr("id") ?? "")?.[1]);
  const dateA = el.find("a.thread-date").first();

  let author: ThreadAuthor | null = null;
  let bodyText: string;
  if (type === "lineitem") {
    // Status/assignee change log line: text lives in .thread-title, author link (if any) inside it.
    const a = el.find(".thread-title a[href*='/users/profile/']").first();
    const uid = userIdFromHref(a.attr("href"));
    if (a.length) author = { kind: "user", id: uid, name: textOrNull(a.text()), is_current_user: uid !== null && uid === currentUserId };
    bodyText = squish(el.find(".thread-title").first().text());
  } else {
    const person = el.find(".thread-person strong").first();
    const a = person.find("a").first();
    const href = a.attr("href");
    const raw = textOrNull((a.length ? a : person).text());
    const youish = raw !== null && /^you$/i.test(raw);
    if (href && /\/customers\//.test(href)) {
      author = { kind: "customer", id: customerIdFromHref(href), name: raw, is_current_user: false };
    } else if (href && /\/users\/profile\//.test(href)) {
      const uid = userIdFromHref(href);
      const isMe = youish || (uid !== null && uid === currentUserId);
      author = { kind: "user", id: uid, name: isMe ? (navName ? `${navName} (you)` : "you") : raw, is_current_user: isMe };
    } else if (raw) {
      // Drafts render the author without a link ("you" for the current user).
      author = youish
        ? { kind: "user", id: currentUserId, name: navName ? `${navName} (you)` : "you", is_current_user: true }
        : { kind: type === "customer" ? "customer" : "user", id: null, name: raw, is_current_user: false };
    }
    // Body: .thread-content for published threads; drafts put the HTML straight in .thread-body.
    const content = el.find(".thread-body .thread-content").first();
    let bodyEl = content.length ? content : el.find(".thread-body").first();
    if (!content.length) {
      bodyEl = bodyEl.clone();
      bodyEl.find(".thread-meta, .thread-attachments, .thread-original").remove();
    }
    bodyText = htmlToText(bodyEl);
  }

  const recipients = (label: string): string[] => {
    const out: string[] = [];
    el.find(".thread-recipients > div").each((_, d) => {
      const t = squish($(d).text());
      const m = new RegExp(`^${label}:\\s*(.+)$`, "i").exec(t);
      if (m) out.push(...m[1]!.split(/\s*,\s*/).filter(Boolean));
    });
    return out;
  };

  const attachments: Attachment[] = [];
  el.find(".thread-attachments li").each((_, li) => {
    const l = $(li);
    const a = l.find("a.attachment-link").first();
    const href = a.attr("href");
    attachments.push({
      name: squish(a.text()),
      size: textOrNull(l.find(".text-help").first().text().replace(/^\(|\)$/g, "")),
      mime: l.attr("data-mime") ?? null,
      url: href ? new URL(href, base).toString() : null,
    });
  });

  const thread: ParsedThread = {
    thread_id: threadId,
    type,
    author,
    date: textOrNull(dateA.attr("title")),
    date_relative: textOrNull(dateA.text()),
    to: recipients("To"),
    cc: recipients("Cc"),
    status_snapshot: textOrNull(el.find(".thread-status").first().text()),
    body: bodyText,
    attachments,
  };
  if (type === "note") Object.assign(thread, forwardInfo($, el));
  return thread;
}

/**
 * Forward marker on a note: a `.thread-badge` that mentions forwarding (FreeScout also has a phone badge), or
 * "forwarded" in the thread header. The child conversation number comes from a `#N` link to /conversation/{id}
 * outside the body (the body is agent-written text and may contain anything).
 */
function forwardInfo($: CheerioAPI, el: ReturnType<CheerioAPI>): Pick<ParsedThread, "is_forward" | "forwarded_conversation_number"> {
  // Agent-written HTML lives in .thread-content (class/title survive purification), so anything inside it is
  // ignored. FreeScout's own chrome counts: the badge in .thread-message and, on a real forward note (captured from
  // the demo 2026-10-27), `.thread-body > .alert.alert-note` with "Forwarded conversation: <a href=/conversation/ID>#N</a>".
  const outsideBody = (_: number, n: AnyNode) => !$(n).closest(".thread-content").length;
  const badge = el.find(".thread-badge").filter(outsideBody).filter((_, b) => {
    const x = $(b);
    return /forward|share|arrow-right/i.test(`${x.attr("class") ?? ""} ${x.attr("title") ?? ""} ${x.find("[class]").attr("class") ?? ""} ${x.text()}`);
  });
  const header = el.find(".thread-header, .thread-title").filter(outsideBody).first();
  if (!badge.length && !/\bforwarded\b/i.test(squish(header.text()))) return {};
  let child: number | undefined;
  el.find("a[href]").each((_, a) => {
    const x = $(a);
    if (child !== undefined || x.closest(".thread-content").length) return;
    const n = /^#\s*(\d+)$/.exec(squish(x.text()));
    if (n && /\/conversation\/\d+/.test(x.attr("href") ?? "")) child = Number(n[1]);
  });
  return child === undefined ? { is_forward: true } : { is_forward: true, forwarded_conversation_number: child };
}
