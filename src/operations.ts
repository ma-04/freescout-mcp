/**
 * Tool operations: fetch FreeScout pages / ajax endpoints and turn them into JSON.
 * Everything takes a FreeScoutPort so the logic can be unit-tested with a stub.
 * Endpoint details: docs/freescout-endpoints.md.
 */
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { checkAjax, type AjaxEnvelope } from "./ajax.js";
import type { FreeScoutPort, HtmlPage } from "./client.js";
import { AuthError, FreeScoutError, PermissionError } from "./errors.js";
import { isStrictRecipient, recipientAllowed } from "./forward-allow.js";
import { requireDate } from "./dates.js";
import { parseConversation, type ParsedConversation, type ParsedThread } from "./parsers/conversation.js";
import { parseConversationTable, type ConversationRow, type ConversationTable } from "./parsers/conversation-table.js";
import { parseCustomerEdit, parseCustomerSearch, parseCustomerSnippet, type CustomerProfile } from "./parsers/customer.js";
import {
  parseDashboard,
  parseMailboxSidebar,
  type FolderInfo,
  type FolderType,
  type MailboxSidebar,
  type MailboxSummary,
} from "./parsers/mailbox.js";
import { offeredFilters, parseSearchFilters, selectedAssigned, type FilterOption } from "./parsers/search-filters.js";
import { htmlToText, squish } from "./parsers/text.js";

const AJAX = "/conversation/ajax";

// ---------------------------------------------------------------------------------------------
// Mailboxes and folders

export async function listMailboxes(port: FreeScoutPort, includeFolders = true): Promise<MailboxSummary[]> {
  const home = await port.getHtml("/");
  const boxes = parseDashboard(home.$, home.url);
  if (!includeFolders) return boxes;
  for (const box of boxes) {
    // The dashboard card omits Closed/Spam; the mailbox sidebar has them. Merge by folder id.
    try {
      const page = await port.getHtml(`/mailbox/${box.id}`);
      const side = parseMailboxSidebar(page.$, page.url);
      if (!box.email && side.email) box.email = side.email;
      const byId = new Map<number, FolderInfo>(box.folders.map((f) => [f.id, f]));
      for (const f of side.folders) {
        const { current: _current, ...info } = f;
        byId.set(f.id, { ...byId.get(f.id), ...info, active_count: f.active_count ?? byId.get(f.id)?.active_count ?? null });
      }
      box.folders = [...byId.values()];
    } catch (e) {
      if (!(e instanceof PermissionError)) throw e;
    }
  }
  return boxes;
}

export type FolderArg = FolderType | number;

interface ResolvedFolder {
  folderId: number | null;
  type: FolderType | null;
  /** Already-fetched page that *is* this folder's page 1 listing, to avoid a second request. */
  page?: HtmlPage;
  note?: string;
}

/**
 * Folder ids are per mailbox (Mine/Starred also per user), so names are resolved from the
 * sidebar of `/mailbox/{id}`. FreeScout hides Drafts there when empty (the dashboard card
 * still lists it) and shows Deleted only on the Closed folder page when non-empty.
 */
export async function resolveFolder(port: FreeScoutPort, mailboxId: number, folder: FolderArg): Promise<ResolvedFolder> {
  if (typeof folder === "number") return { folderId: folder, type: null };
  const first = await port.getHtml(`/mailbox/${mailboxId}`);
  const side = parseMailboxSidebar(first.$, first.url);
  const hit = side.folders.find((f) => f.type === folder);
  if (hit) return { folderId: hit.id, type: folder, page: hit.current ? first : undefined };
  if (folder === "drafts") {
    const home = await port.getHtml("/");
    const card = parseDashboard(home.$, home.url).find((m) => m.id === mailboxId);
    const d = card?.folders.find((f) => f.type === "drafts");
    if (d) return { folderId: d.id, type: "drafts" };
  }
  if (folder === "deleted") {
    const closed = side.folders.find((f) => f.type === "closed");
    if (closed) {
      const cp = await port.getHtml(`/mailbox/${mailboxId}/${closed.id}`);
      const del = parseMailboxSidebar(cp.$, cp.url).folders.find((f) => f.type === "deleted");
      if (del) return { folderId: del.id, type: "deleted" };
    }
  }
  return {
    folderId: null,
    type: folder,
    note:
      folder === "drafts" || folder === "deleted"
        ? `FreeScout hides the ${folder} folder when it is empty, so it has no conversations.`
        : `Folder "${folder}" is not visible to this user in mailbox ${mailboxId}.`,
  };
}

export interface ConversationList extends ConversationTable {
  mailbox: { id: number; name: string | null };
  folder: { id: number | null; name: string | null; type: FolderType | null };
  note?: string;
}

export async function listConversations(
  port: FreeScoutPort,
  mailboxId: number,
  folder: FolderArg,
  page = 1,
): Promise<ConversationList> {
  const r = await resolveFolder(port, mailboxId, folder);
  if (r.folderId === null) {
    return {
      mailbox: { id: mailboxId, name: null },
      folder: { id: null, name: null, type: r.type },
      conversations: [],
      page,
      total: 0,
      active: null,
      range: null,
      has_next_page: false,
      last_page: 1,
      note: r.note,
    };
  }
  const html = page === 1 && r.page ? r.page : await port.getHtml(`/mailbox/${mailboxId}/${r.folderId}${page > 1 ? `?page=${page}` : ""}`);
  const side: MailboxSidebar = parseMailboxSidebar(html.$, html.url);
  const current = side.folders.find((f) => f.current);
  // FreeScout silently falls back to Unassigned for a folder id that is not in this mailbox.
  if (side.folders.length && current && current.id !== r.folderId) {
    throw new FreeScoutError(
      `Folder ${r.folderId} is not a folder of mailbox ${mailboxId} visible to this user (FreeScout showed "${current.name}" instead). Use list_mailboxes to see folder ids.`,
    );
  }
  const type = r.type ?? current?.type ?? null;
  const table = parseConversationTable(html.$, html.url, type);
  return {
    mailbox: { id: mailboxId, name: side.name },
    folder: { id: r.folderId, name: current?.name ?? null, type },
    ...table,
    page: table.page || page,
  };
}

// ---------------------------------------------------------------------------------------------
// Search (filters: docs/freescout-endpoints.md §10.1)

export const SEARCH_STATUSES = ["active", "pending", "closed", "spam"] as const;
export const SEARCH_STATES = ["draft", "published", "deleted"] as const;
export const SEARCH_TYPES = ["email", "phone", "chat"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];
export type SearchState = (typeof SEARCH_STATES)[number];
export type SearchType = (typeof SEARCH_TYPES)[number];
/** A user id, or "unassigned" (wire value -1, `user_id IS NULL`). */
export type AssignedArg = number | "unassigned";

export interface SearchFilters {
  assigned?: AssignedArg;
  status?: SearchStatus[];
  state?: SearchState[];
  /** created_at >= after 00:00:00 (server timezone). */
  after?: string;
  /** created_at <= before 23:59:59 (server timezone, inclusive). */
  before?: string;
  customer_id?: number;
  type?: SearchType;
  has_attachments?: boolean;
  subject?: string;
  body?: string;
  /** Exact tag name (Tags module; `f[tag]`, the same URL a tag chip links to). */
  tag?: string;
  /** Only conversations the current user follows (`f[following]=yes`). There is no "not following" filter. */
  following?: true;
  /** Exact conversation number (`f[number]`). Also set when q is "#N" (or "N") together with a filter (see buildSearchParams). */
  number?: number;
  /** Exact conversation id (`f[id]`). */
  id?: number;
  /** Attachment file name (`f[attachment name]`, a module filter seen on production; matching rules not verified). */
  attachment_name?: string;
}

export const TAG_MAX = 100;
export const ATTACHMENT_NAME_MAX = 200;
/** Filter names accepted by search_conversations, in the order of the "give q or a filter" error. */
export const SEARCH_FILTER_NAMES = [
  "assigned", "status", "state", "after", "before", "customer_id", "type", "has_attachments", "subject", "body",
  "tag", "following", "number", "id", "attachment_name",
] as const;

export interface SearchOptions extends SearchFilters {
  q?: string;
  mailbox_id?: number;
  page?: number;
}

export interface SearchResult extends ConversationTable {
  query: string | null;
  mailbox_id: number | null;
  /** The filters that were sent (normalised). */
  filters: SearchFilters;
  /**
   * Set when mailbox_id was requested: true if FreeScout dropped it (no access) and searched all viewable mailboxes,
   * null if the page had no mailbox dropdown to check against. Absent when the filter was verifiably applied.
   */
  mailbox_filter_ignored?: boolean | null;
  /** The assigned filter FreeScout applied when it differs from the requested one (agents limited to their own conversations). */
  assigned_filter_forced?: AssignedArg;
  /**
   * Filters (the module filters tag, attachment_name, and the core following, id, number) that were sent but that
   * this install's search page does not offer: FreeScout ignored them, so the results are NOT narrowed by them.
   * Absent when every sent checked filter is offered.
   */
  unsupported_filters?: string[];
  /** Checked filters that were sent but could not be verified (the page had no filter markup). */
  unverified_filters?: string[];
  note?: string;
}

/**
 * Search filters checked against the page's filter list (option name -> FreeScout's data-filter name, module filter?).
 * tag and attachment_name come from modules. following, id and number are core in 1.8.248 (the version whose source
 * was read) but are the newest entries of its filter list, so they are checked too: an install whose search lacks
 * them would ignore them just as silently. The other core filters are trusted (in Conversation::$search_filters of
 * 1.8.248); assigned and mailbox are additionally verified from their dropdowns.
 */
const CHECKED_FILTERS = [
  ["tag", "tag", true],
  ["attachment_name", "attachment name", true],
  ["following", "following", false],
  ["id", "id", false],
  ["number", "number", false],
] as const;

export const MAILBOX_IGNORED_NOTE =
  "FreeScout ignored mailbox_id (this account cannot view that mailbox) and searched all mailboxes it can view.";
export const MAILBOX_UNVERIFIED_NOTE =
  "Could not verify that FreeScout applied mailbox_id (the search page has no mailbox dropdown); results may include other viewable mailboxes.";
export const NUMBER_SEARCH_NOTE = "searched by conversation number";
export const assignedForcedNote = (forced: AssignedArg): string =>
  `FreeScout applied assigned=${JSON.stringify(forced)} instead of the requested assignee filter (this account may ` +
  "only see conversations assigned to it), so these results are limited to that assignee.";

/** Positive integer that survives a round trip through a JS number (ids above 2^53 - 1 would be silently rounded). */
const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/**
 * Validate the filters and build the `/search` query string. Throws (before any request) on a bad value, on
 * after > before, and when neither q nor a filter is given (an empty search lists every conversation).
 */
export function buildSearchParams(opts: SearchOptions): {
  params: URLSearchParams;
  filters: SearchFilters;
  query: string | null;
  /** True when q was a conversation number sent as f[number] instead of q (see below). */
  byNumber: boolean;
} {
  const params = new URLSearchParams();
  const filters: SearchFilters = {};
  const query = typeof opts.q === "string" && opts.q.trim() ? opts.q.trim() : null;
  if (opts.assigned !== undefined) {
    if (opts.assigned !== "unassigned" && !isPosInt(opts.assigned)) throw new Error('assigned must be a positive user id or "unassigned"');
    params.set("f[assigned]", opts.assigned === "unassigned" ? "-1" : String(opts.assigned));
    filters.assigned = opts.assigned;
  }
  if (opts.mailbox_id !== undefined) {
    if (!isPosInt(opts.mailbox_id)) throw new Error("mailbox_id must be a positive integer");
    params.set("f[mailbox]", String(opts.mailbox_id));
  }
  const multi = <T extends string>(name: "status" | "state", values: T[] | undefined, all: readonly T[]): T[] | undefined => {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.length === 0) throw new Error(`${name} must be a non-empty array of ${all.join("|")}`);
    const uniq = [...new Set(values)];
    for (const v of uniq) {
      if (!all.includes(v)) throw new Error(`${name} must only contain ${all.join("|")} (got ${JSON.stringify(v)})`);
      // MUST be an array on the wire; a scalar f[status] is dropped by FreeScout.
      params.append(`f[${name}][]`, String(all.indexOf(v) + 1));
    }
    return uniq;
  };
  const status = multi("status", opts.status, SEARCH_STATUSES);
  if (status) filters.status = status;
  const state = multi("state", opts.state, SEARCH_STATES);
  if (state) filters.state = state;
  let after: Date | undefined;
  if (opts.after !== undefined) {
    after = requireDate("after", opts.after);
    params.set("f[after]", opts.after);
    filters.after = opts.after;
  }
  if (opts.before !== undefined) {
    const before = requireDate("before", opts.before);
    if (after && after.getTime() > before.getTime()) throw new Error(`after (${opts.after}) must not be later than before (${opts.before})`);
    params.set("f[before]", opts.before);
    filters.before = opts.before;
  }
  if (opts.customer_id !== undefined) {
    if (!isPosInt(opts.customer_id)) throw new Error("customer_id must be a positive integer");
    params.set("f[customer]", String(opts.customer_id));
    filters.customer_id = opts.customer_id;
  }
  if (opts.type !== undefined) {
    if (!SEARCH_TYPES.includes(opts.type)) throw new Error(`type must be one of ${SEARCH_TYPES.join("|")}`);
    params.set("f[type]", String(SEARCH_TYPES.indexOf(opts.type) + 1));
    filters.type = opts.type;
  }
  if (opts.has_attachments !== undefined) {
    if (typeof opts.has_attachments !== "boolean") throw new Error("has_attachments must be true or false");
    params.set("f[attachments]", opts.has_attachments ? "yes" : "no");
    filters.has_attachments = opts.has_attachments;
  }
  for (const k of ["subject", "body"] as const) {
    const v = opts[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) throw new Error(`${k} must be non-empty text`);
    params.set(`f[${k}]`, v.trim());
    filters[k] = v.trim();
  }
  if (opts.tag !== undefined) {
    if (typeof opts.tag !== "string" || !opts.tag.trim() || opts.tag.trim().length > TAG_MAX) {
      throw new Error(`tag must be a tag name (1..${TAG_MAX} characters)`);
    }
    params.set("f[tag]", opts.tag.trim());
    filters.tag = opts.tag.trim();
  }
  if (opts.following !== undefined) {
    // FreeScout's select has only "yes"; anything else is not a filter at all, so refuse rather than ignore it.
    if (opts.following !== true) throw new Error("following must be true (there is no 'not following' filter); omit it otherwise");
    params.set("f[following]", "yes");
    filters.following = true;
  }
  if (opts.id !== undefined) {
    if (!isPosInt(opts.id)) throw new Error("id must be a positive integer (conversation id)");
    params.set("f[id]", String(opts.id));
    filters.id = opts.id;
  }
  if (opts.attachment_name !== undefined) {
    const v = opts.attachment_name;
    if (typeof v !== "string" || !v.trim() || v.trim().length > ATTACHMENT_NAME_MAX) {
      throw new Error(`attachment_name must be text (1..${ATTACHMENT_NAME_MAX} characters)`);
    }
    // The key has a space; URLSearchParams sends f%5Battachment+name%5D, as a browser GET form submit does.
    params.set("f[attachment name]", v.trim());
    filters.attachment_name = v.trim();
  }
  if (opts.number !== undefined && !isPosInt(opts.number)) {
    throw new Error(`number must be a positive integer up to ${Number.MAX_SAFE_INTEGER} (conversation number)`);
  }
  const qNumber = query !== null && /^#?\d+$/.test(query) ? Number(query.replace(/^#/, "")) : null;
  // Number("12345678901234567890") rounds: never compare or send a rounded conversation number. Alone, such a q is
  // sent verbatim as text (FreeScout gets the exact string); it is refused only where it would become f[number].
  if (
    qNumber !== null &&
    !Number.isSafeInteger(qNumber) &&
    (Object.keys(filters).length > 0 || opts.mailbox_id !== undefined || opts.number !== undefined)
  ) {
    throw new Error(`q ${JSON.stringify(query)} is too large for a conversation number (max ${Number.MAX_SAFE_INTEGER})`);
  }
  if (opts.number !== undefined && qNumber !== null && qNumber !== opts.number) {
    throw new Error(`q ${JSON.stringify(query)} conflicts with number ${opts.number}; give one conversation number`);
  }
  if (!query && Object.keys(filters).length === 0 && opts.number === undefined) {
    throw new Error(
      `Give q or at least one filter (${SEARCH_FILTER_NAMES.join(", ")}). An empty search would list every conversation.`,
    );
  }
  // q "#N" (or "N") together with any filter, mailbox_id included, makes FreeScout 1.8 answer HTTP 500 (its number
  // shortcut skips the filtered query and the view then paginates a plain array, §10.1). Send FreeScout's exact
  // f[number] filter instead of q. Without filters q is kept: FreeScout redirects to the conversation.
  // An explicit number is the same f[number] filter, so a numeric q next to it is folded into it (never sent as q).
  const byNumber =
    qNumber !== null && (Object.keys(filters).length > 0 || opts.mailbox_id !== undefined || opts.number !== undefined);
  const out = new URLSearchParams();
  if (query && !byNumber) out.set("q", query);
  for (const [k, v] of params) out.append(k, v);
  const n = opts.number ?? (byNumber ? qNumber : null);
  if (n !== null) {
    if (!isPosInt(n)) throw new Error(`conversation number must be a positive integer (got ${JSON.stringify(query)})`);
    out.set("f[number]", String(n));
    filters.number = n;
  }
  const page = opts.page ?? 1;
  if (!isPosInt(page)) throw new Error("page must be a positive integer");
  if (page > 1) out.set("page", String(page));
  return { params: out, filters, query, byNumber };
}

/**
 * When mailbox_id was requested: true if the page's mailbox dropdown shows FreeScout did not apply it, null if there
 * is no dropdown to check (unknown). False when nothing was requested or the filter is verifiably applied.
 */
export function mailboxFilterIgnored(page: HtmlPage, mailboxId: number | undefined): boolean | null {
  if (!mailboxId) return false;
  const { mailboxes } = parseSearchFilters(page.$);
  if (mailboxes === null) return null;
  return !mailboxes.some((m) => m.id === mailboxId);
}

/**
 * The assigned filter FreeScout applied, when it differs from the requested one (`requested` undefined = none).
 * Read from the selected option of `f[assigned]`; nothing selected (e.g. a user id missing from the dropdown) is
 * never reported as forced.
 */
export function assignedFilterForced(page: HtmlPage, requested: AssignedArg | undefined): AssignedArg | null {
  const selected = selectedAssigned(page.$);
  if (selected === null) return null;
  const wire = requested === undefined ? "" : requested === "unassigned" ? "-1" : String(requested);
  if (selected === wire) return null;
  if (selected === "-1") return "unassigned";
  return /^[1-9]\d*$/.test(selected) ? Number(selected) : null;
}

/**
 * A /search response must have ended on /search (under the base path) and show a result table or the empty-result
 * block. Anything else (dashboard, module, maintenance or login-like page) is an error, never a count of 0.
 */
export function assertSearchPage(page: HtmlPage): void {
  const path = new URL(page.url).pathname;
  if (!/\/search\/?$/.test(path)) throw new FreeScoutError(`unexpected page: the search ended at ${path}, not /search`);
  if (!page.$("table.table-conversations").length && !page.$(".empty-content").length) {
    throw new FreeScoutError("unexpected page: /search returned neither a results table nor an empty result");
  }
}

export async function searchConversations(port: FreeScoutPort, q: string, mailboxId?: number, page?: number): Promise<SearchResult>;
export async function searchConversations(port: FreeScoutPort, opts: SearchOptions): Promise<SearchResult>;
export async function searchConversations(
  port: FreeScoutPort,
  qOrOpts: string | SearchOptions,
  mailboxId?: number,
  page = 1,
): Promise<SearchResult> {
  const opts: SearchOptions = typeof qOrOpts === "string" ? { q: qOrOpts, mailbox_id: mailboxId, page } : qOrOpts;
  const { params, filters, query, byNumber } = buildSearchParams(opts);
  const mailbox = opts.mailbox_id ?? null;
  const pageNo = opts.page ?? 1;
  const html = await port.getHtml(`/search?${params.toString()}`);
  // `#123` or a bare number with exactly one match: FreeScout 302s straight to the conversation. It only does that
  // when no filter is set (§10.1), so this branch is reached with q alone.
  if (/\/conversation\/\d+/.test(new URL(html.url).pathname)) {
    const c = parseConversation(html.$, html.url);
    if (mailbox && c.mailbox_id !== mailbox) {
      return { query, mailbox_id: mailbox, filters, conversations: [], page: pageNo, total: 0, active: null, range: null, has_next_page: false, last_page: 1 };
    }
    // Preview the latest customer/agent message, never an internal note (matches FreeScout's list preview).
    const last = [...c.threads].reverse().find((t) => t.type === "customer" || t.type === "message");
    const row: ConversationRow = {
      id: c.id,
      number: c.number,
      subject: c.subject ?? "",
      customer: c.customer ? { name: c.customer.name, email: c.customer.email } : null,
      preview: last ? last.body.slice(0, 200) : null,
      mailbox_name: c.mailbox_name,
      status: c.status,
      assignee: c.assignee,
      last_activity: c.updated_at ? { relative: null, by: null, at: c.updated_at } : null,
      thread_count: c.threads.filter((t) => t.type === "customer" || t.type === "message").length,
      starred: c.starred,
      has_attachments: c.threads.some((t) => t.attachments.length > 0),
      tags: conversationTags(html) ?? [],
      url: c.url,
    };
    return {
      query,
      mailbox_id: mailbox,
      filters,
      conversations: [row],
      page: 1,
      total: 1,
      active: null,
      range: { from: 1, to: 1 },
      has_next_page: false,
      last_page: 1,
      note: "FreeScout matched exactly one conversation by number and redirected to it.",
    };
  }
  assertSearchPage(html);
  const table = parseConversationTable(html.$, html.url, null);
  const result: SearchResult = { query, mailbox_id: mailbox, filters, ...table };
  const notes: string[] = [];
  if (byNumber) notes.push(NUMBER_SEARCH_NOTE);
  const ignored = mailboxFilterIgnored(html, opts.mailbox_id);
  if (ignored === true) {
    result.mailbox_filter_ignored = true;
    notes.push(MAILBOX_IGNORED_NOTE);
  } else if (ignored === null) {
    result.mailbox_filter_ignored = null;
    notes.push(MAILBOX_UNVERIFIED_NOTE);
  }
  const forced = assignedFilterForced(html, opts.assigned);
  if (forced !== null) {
    result.assigned_filter_forced = forced;
    notes.push(assignedForcedNote(forced));
  }
  const sentChecked = CHECKED_FILTERS.filter(([opt]) => filters[opt] !== undefined);
  if (sentChecked.length) {
    const offered = offeredFilters(html.$);
    if (offered === null) {
      result.unverified_filters = sentChecked.map(([opt]) => opt);
      notes.push(
        `Could not verify that this install supports ${result.unverified_filters.join(", ")} (no filter list on the page); ` +
          "if it does not, FreeScout ignores the filter and the results are not narrowed by it.",
      );
    } else {
      const missing = sentChecked.filter(([, wire]) => !offered.includes(wire));
      if (missing.length) {
        result.unsupported_filters = missing.map(([opt]) => opt);
        const why = missing.every(([, , mod]) => mod)
          ? "module not installed"
          : missing.every(([, , mod]) => !mod)
            ? "older FreeScout version"
            : "module not installed or older FreeScout version";
        notes.push(
          `This install's search does not offer ${result.unsupported_filters.join(", ")} (${why}), so FreeScout ignored it: ` +
            "these results are NOT filtered by it.",
        );
      }
    }
  }
  if (notes.length) result.note = notes.join(" ");
  return result;
}

export const ASSIGNEES_NOTE =
  "Only users FreeScout lets this account see are listed (admins and users of other mailboxes may be missing). " +
  "Any numeric user id still works in assigned filters; use \"unassigned\" for conversations without an assignee.";

export interface AssigneeList {
  assignees: FilterOption[];
  unassigned_value: "unassigned";
  note: string;
}

/** Users in the search page's `f[assigned]` dropdown (§10.2). `GET /users` is 403 for non-admins. */
export async function listAssignees(port: FreeScoutPort): Promise<AssigneeList> {
  const page = await port.getHtml("/search");
  assertSearchPage(page);
  const { assignees } = parseSearchFilters(page.$);
  if (assignees === null) throw new FreeScoutError("The search page has no assignee filter (unexpected FreeScout markup).");
  return { assignees, unassigned_value: "unassigned", note: ASSIGNEES_NOTE };
}

// ---------------------------------------------------------------------------------------------
// Conversation

export async function getConversation(port: FreeScoutPort, id: number): Promise<ParsedConversation> {
  return (await loadConversation(port, id)).conv;
}

/** The conversation page plus its parsed form (add_tag also needs the raw page for the tag chips). */
async function loadConversation(port: FreeScoutPort, id: number): Promise<{ conv: ParsedConversation; page: HtmlPage }> {
  // Without folder_id FreeScout 302s to /conversation/{id}?folder_id=…; Session follows it.
  const html = await port.getHtml(`/conversation/${id}`);
  if (!/\/conversation\/\d+/.test(new URL(html.url).pathname)) {
    throw new FreeScoutError(`Conversation ${id} did not open (ended at ${new URL(html.url).pathname})`);
  }
  const conv = parseConversation(html.$, html.url);
  if (conv.id !== id) throw new FreeScoutError(`Asked for conversation ${id} but FreeScout showed ${conv.id}`);
  return { conv, page: html };
}

/** Trim each thread body to maxChars, marking truncation. */
export function capBodies(conv: ParsedConversation, maxChars: number): ParsedConversation & { threads: (ParsedThread & { body_truncated?: boolean })[] } {
  return {
    ...conv,
    threads: conv.threads.map((t) =>
      t.body.length > maxChars ? { ...t, body: t.body.slice(0, maxChars) + " …", body_truncated: true } : t,
    ),
  };
}

/**
 * Keep only the newest maxThreads threads (still oldest first). Output shaping for the tool only:
 * write operations need the full thread list and call getConversation directly.
 */
export function capThreads<C extends ParsedConversation>(
  conv: C,
  maxThreads: number,
): C & { total_threads: number; threads_truncated: boolean } {
  const total = conv.threads.length;
  const cut = total > maxThreads;
  return { ...conv, threads: cut ? conv.threads.slice(total - maxThreads) : conv.threads, total_threads: total, threads_truncated: cut };
}

// ---------------------------------------------------------------------------------------------
// Customer

export interface CustomerResult {
  id: number;
  name: string | null;
  email: string | null;
  extra: string | null;
  profile: CustomerProfile | null;
  conversations: ConversationRow[];
  conversations_total: number | null;
  url: string;
}

export async function getCustomer(port: FreeScoutPort, idOrEmail: number | string, limit = 20): Promise<CustomerResult> {
  let id: number;
  /** Set when the only search hit's card shows a different email: confirm it via the profile's email list. */
  let mustHaveEmail: string | undefined;
  if (typeof idOrEmail === "number") id = idOrEmail;
  else {
    const email = idOrEmail.trim().toLowerCase();
    const s = await port.getHtml(`/search?${new URLSearchParams({ q: email, mode: "customers" }).toString()}`);
    const hits = parseCustomerSearch(s.$);
    const exact = hits.find((h) => h.email?.toLowerCase() === email);
    // FreeScout's search is a substring match, so a single hit may be another customer
    // (q=lopez@x.example finds maria.lopez@x.example). Cards show only the main email.
    const hit = exact ?? (hits.length === 1 ? hits[0] : undefined);
    if (!hit) throw new FreeScoutError(`No customer found with email ${idOrEmail}`, 404);
    if (!exact) mustHaveEmail = email;
    id = hit.id;
  }
  const page = await port.getHtml(`/customers/${id}/`);
  const snippet = parseCustomerSnippet(page.$);
  const table = parseConversationTable(page.$, page.url, null);
  let profile: CustomerProfile | null = null;
  try {
    const edit = await port.getHtml(`/customers/${id}/edit`);
    profile = parseCustomerEdit(edit.$);
  } catch (e) {
    if (!(e instanceof PermissionError)) throw e;
  }
  if (mustHaveEmail && !profile?.emails.some((e) => e.toLowerCase() === mustHaveEmail)) {
    throw new FreeScoutError(`No customer found with email ${mustHaveEmail}`, 404);
  }
  return {
    id,
    name: snippet?.name ?? null,
    email: snippet?.email ?? profile?.emails[0] ?? null,
    extra: snippet?.extra ?? null,
    profile,
    conversations: table.conversations.slice(0, limit),
    conversations_total: table.total,
    url: page.url,
  };
}

export interface CustomerHistoryItem {
  id: number;
  number: number | null;
  subject: string;
  status: ConversationRow["status"];
  assignee: string | null;
  last_activity: ConversationRow["last_activity"];
  tags: string[];
}

export interface CustomerHistory {
  customer: Omit<CustomerResult, "conversations" | "conversations_total">;
  conversations: CustomerHistoryItem[];
  /** Counts over the listed conversations only (see listed / conversations_total). */
  by_status: Record<"active" | "pending" | "closed" | "spam" | "unknown", number>;
  listed: number;
  /** FreeScout's total for this customer in mailboxes this account can view (null if the page had no total). */
  conversations_total: number | null;
  complete: boolean;
  note: string;
}

export const CUSTOMER_HISTORY_NOTE =
  "Composed from the customer page (one page, newest first): conversations in mailboxes this account can view. " +
  "status is inferred from the row (lock badge = closed, active class = active, otherwise pending); by_status counts " +
  "only the listed rows. last_activity.at is a display string in the viewing user's timezone.";

/** get_customer plus a compact per-conversation list and counts by status (no extra requests). */
export async function customerHistory(port: FreeScoutPort, idOrEmail: number | string, limit = 50): Promise<CustomerHistory> {
  const c = await getCustomer(port, idOrEmail, limit);
  const { conversations: rows, conversations_total, ...customer } = c;
  const by_status: CustomerHistory["by_status"] = { active: 0, pending: 0, closed: 0, spam: 0, unknown: 0 };
  for (const r of rows) by_status[r.status ?? "unknown"]++;
  const complete = conversations_total !== null && rows.length >= conversations_total;
  let note = CUSTOMER_HISTORY_NOTE;
  if (conversations_total === null) {
    note +=
      rows.length === 0
        ? " The customer page showed no conversations and no total; there may still be conversations, use " +
          "search_conversations with customer_id to check."
        : ` FreeScout's total could not be read, so ${rows.length} conversation(s) are listed and there may be more; ` +
          "use search_conversations with customer_id for the full list.";
  } else if (!complete) {
    note += ` Only ${rows.length} of ${conversations_total} conversations are listed; use search_conversations with customer_id for the rest.`;
  }
  return {
    customer,
    conversations: rows.map((r) => ({
      id: r.id,
      number: r.number,
      subject: r.subject,
      status: r.status,
      assignee: r.assignee,
      last_activity: r.last_activity,
      tags: r.tags,
    })),
    by_status,
    listed: rows.length,
    conversations_total,
    complete,
    note,
  };
}

// ---------------------------------------------------------------------------------------------
// Saved replies (paid module; absent on the demo)

export interface SavedRepliesResult {
  available: boolean;
  reason?: string;
  mailbox_id: number;
  source_url?: string;
  replies?: { id: number | null; name: string; text: string | null }[];
}

/**
 * The Saved Replies module is not in FreeScout core. We look for a "saved-replies" link on the
 * mailbox page (modules add mailbox menu items there), then try the module's usual URL. Anything
 * else means not installed. The module's page layout was not available to verify against, so the
 * list parsing is best-effort.
 */
export async function listSavedReplies(port: FreeScoutPort, mailboxId: number): Promise<SavedRepliesResult> {
  const mb = await port.getHtml(`/mailbox/${mailboxId}`);
  const links = new Set<string>();
  mb.$("a[href*='saved-replies'], a[href*='saved_replies']").each((_, a) => {
    const href = mb.$(a).attr("href");
    if (href) links.add(new URL(href, mb.url).toString());
  });
  // Relative path: Session.resolve() puts it under FREESCOUT_URL, including a sub-path install.
  const candidates = [...links, `mailbox/saved-replies/${mailboxId}`];
  for (const url of candidates) {
    let page: HtmlPage;
    try {
      page = await port.getHtml(url);
    } catch (e) {
      if (e instanceof FreeScoutError && (e.status === 404 || e.status === 403)) continue;
      throw e;
    }
    const replies: NonNullable<SavedRepliesResult["replies"]> = [];
    page.$("[data-saved-reply-id], .saved-reply, .saved-replies-list li, .panel[id^='saved-reply']").each((_, el) => {
      const n = page.$(el);
      const name = squish(n.find(".panel-title, h4, .saved-reply-name, a").first().text()) || squish(n.text()).slice(0, 80);
      if (!name) return;
      const idAttr = n.attr("data-saved-reply-id") ?? /(\d+)/.exec(n.attr("id") ?? "")?.[1];
      const textEl = n.find(".saved-reply-text, .panel-body, textarea").first();
      replies.push({ id: idAttr ? Number(idAttr) : null, name, text: textEl.length ? htmlToText(textEl) || null : null });
    });
    return { available: true, mailbox_id: mailboxId, source_url: page.url, replies };
  }
  return {
    available: false,
    mailbox_id: mailboxId,
    reason:
      "The Saved Replies module is not installed on this FreeScout (it is a paid add-on; no saved-replies page or menu link exists).",
  };
}

// ---------------------------------------------------------------------------------------------
// Tags (paid module; absent on the demo). Protocol verified from a production FreeScout's own JS bundle and
// page markup: docs/freescout-endpoints.md §9.

/** `laroute` entry `{"uri":"tags\/ajax","name":"tags.ajax"}`; relative, so Session.resolve keeps a sub-path. */
export const TAGS_AJAX = "tags/ajax";

export interface TagInfo {
  name: string;
  /** From a data-tag-id attribute, when the markup exposes one (the observed module markup does not). */
  id: number | null;
  /** Link on the tag chip (the module links tags to a filtered search), when present. */
  url: string | null;
  /** How many conversations on the scanned page(s) show this tag; null for autocomplete results. */
  conversations_seen: number | null;
}

export interface TagsResult {
  available: boolean;
  reason?: string;
  mailbox_ids: number[];
  query: string | null;
  tags?: TagInfo[];
  source?: string;
  note?: string;
}

/**
 * Markers the Tags module adds. Conversation page (observed): `#conv_tags` with `span.tag.tag-c-N` chips, each
 * `a.tag-name` (href = search filtered by the tag) plus `a.tag-remove`; toolbar `span.conv-add-tags`. The list
 * selectors (`.conv-tags`, `.fs-tag`) come from freescout-refresh v1.8.0.
 */
const TAG_CHIP = ".tag, .fs-tag";
const TAG_LIST_SEL = ".table-conversations .conv-tags";
const TAG_CONV_SEL = "#conv_tags";
const TAG_CONV_MARKERS = `${TAG_CONV_SEL}, .conv-add-tags`;
const TAG_MARKERS = `${TAG_LIST_SEL}, ${TAG_CONV_MARKERS}, script[src*='/modules/tags/']`;

export const TAGS_UNAVAILABLE = "Tags module not installed or not visible to this user";

/** Tag chips inside `scope` (a selector or a cheerio selection): one entry per chip, in page order. */
export function parseTagChips(
  $: cheerio.CheerioAPI,
  scope: string | cheerio.Cheerio<AnyNode>,
  pageUrl: string,
): Array<Omit<TagInfo, "conversations_seen">> {
  const out: Array<Omit<TagInfo, "conversations_seen">> = [];
  (typeof scope === "string" ? $(scope) : scope)
    .find(TAG_CHIP)
    .each((_, el) => {
      const chip = $(el);
      const label = chip.find(".tag-name, .fs-tag-name").first();
      const link = label.length ? label : chip.find("a").not(".tag-remove, .fs-tag-remove").first();
      const name = squish(link.length ? link.text() : chip.clone().find(".tag-remove, .fs-tag-remove").remove().end().text());
      if (!name) return;
      const idAttr = chip.attr("data-tag-id") ?? link.attr("data-tag-id");
      const href = (link.is("a") ? link : chip.find("a").not(".tag-remove, .fs-tag-remove").first()).attr("href");
      out.push({
        name,
        id: idAttr && /^\d+$/.test(idAttr) ? Number(idAttr) : null,
        url: href && href !== "#" && !/^\s*javascript:/i.test(href) ? new URL(href, pageUrl).toString() : null,
      });
    });
  return out;
}

/** Tag names on a conversation page, or null when the page has no Tags module markup. */
export function conversationTags(page: HtmlPage): string[] | null {
  if (!page.$(TAG_CONV_MARKERS).length) return null;
  const names: string[] = [];
  for (const t of parseTagChips(page.$, TAG_CONV_SEL, page.url)) {
    if (!names.some((n) => tagKey(n) === tagKey(t.name))) names.push(t.name);
  }
  return names;
}

/** Comparison key: the server normalises names (Tag::normalizeName); compare trimmed and case-insensitively. */
function tagKey(name: string): string {
  return squish(name).toLowerCase();
}

interface AutocompleteResponse {
  results?: Array<{ id?: unknown; text?: unknown }>;
  pagination?: { more?: unknown };
  msg?: unknown;
}

const AUTOCOMPLETE_MAX_PAGES = 5;

/** The module's select2 autocomplete (read-only). Throws FreeScoutError when the endpoint is absent or odd. */
async function autocompleteTags(port: FreeScoutPort, q: string): Promise<{ names: string[]; more: boolean }> {
  const names: string[] = [];
  let more = false;
  for (let page = 1; page <= AUTOCOMPLETE_MAX_PAGES; page++) {
    const res = await port.ajaxPost<AutocompleteResponse>(TAGS_AJAX, { action: "autocomplete", q, page: String(page) });
    if (!res || typeof res !== "object") throw new FreeScoutError("tags autocomplete returned a non-object");
    if (typeof res.msg === "string" && /not enough permissions|unauthori[sz]ed|access denied/i.test(res.msg)) {
      throw new PermissionError(`tags autocomplete: FreeScout said "${res.msg}"`);
    }
    if (!Array.isArray(res.results)) throw new FreeScoutError("tags autocomplete returned no results array");
    for (const r of res.results) {
      // The module uses the result id as the tag name.
      const name = squish(typeof r?.id === "string" ? r.id : typeof r?.text === "string" ? r.text : "");
      if (name && !names.some((n) => tagKey(n) === tagKey(name))) names.push(name);
    }
    more = res.pagination?.more === true;
    if (!more) break;
  }
  return { names, more };
}

/**
 * Tags shown in FreeScout's UI. With `q`, the module's autocomplete is asked first (all matching tags the user
 * can see); if that endpoint is missing or fails, and always without `q`, tag chips on the first page of each
 * mailbox's default folder are read; if that page has none, the first conversation on it is opened to tell
 * "module present, no tags here" from "module absent".
 */
export async function listTags(port: FreeScoutPort, mailboxId?: number, q?: string): Promise<TagsResult> {
  const query = q?.trim() ? q.trim() : null;
  if (query) {
    try {
      const { names, more } = await autocompleteTags(port, query);
      return {
        available: true,
        mailbox_ids: mailboxId ? [mailboxId] : [],
        query,
        tags: names.map((name) => ({ name, id: null, url: null, conversations_seen: null })).sort((a, b) => a.name.localeCompare(b.name)),
        source: "Tags module autocomplete",
        note:
          "Tags matching q, from the module's autocomplete. Tags are global in FreeScout, not per mailbox." +
          (more ? ` Only the first ${AUTOCOMPLETE_MAX_PAGES} result pages were read; refine q.` : ""),
      };
    } catch (e) {
      if (!(e instanceof FreeScoutError)) throw e; // AuthError and programming errors propagate
      // Endpoint missing (module absent: 404), not JSON, or refused: fall back to reading pages.
    }
  }
  const ids = mailboxId ? [mailboxId] : (await listMailboxes(port, false)).map((m) => m.id);
  const seen = new Map<string, TagInfo & { conversations_seen: number }>();
  let detected = false;
  let firstConversation: number | null = null;
  const scanned: number[] = [];
  for (const id of ids) {
    let page: HtmlPage;
    try {
      page = await port.getHtml(`/mailbox/${id}`);
    } catch (e) {
      if (!mailboxId && e instanceof PermissionError) continue;
      throw e;
    }
    scanned.push(id);
    if (page.$(TAG_MARKERS).length) detected = true;
    page.$(".table-conversations tr.conv-row").each((_, row) => {
      const r = page.$(row);
      const rowTags = new Set<string>();
      for (const t of parseTagChips(page.$, r.find(".conv-tags"), page.url)) {
        const key = t.name.toLowerCase();
        const cur = seen.get(key) ?? { ...t, conversations_seen: 0 };
        if (!rowTags.has(key)) cur.conversations_seen++;
        rowTags.add(key);
        if (cur.id === null) cur.id = t.id;
        if (cur.url === null) cur.url = t.url;
        seen.set(key, cur);
      }
      if (firstConversation === null) {
        const cid = Number(r.attr("data-conversation_id"));
        if (Number.isInteger(cid) && cid > 0) firstConversation = cid;
      }
    });
  }
  let source = "first page of each mailbox's default folder";
  if (!detected && firstConversation !== null) {
    const conv = await port.getHtml(`/conversation/${firstConversation}`);
    if (conv.$(TAG_MARKERS).length) {
      detected = true;
      source += ` and conversation ${firstConversation}`;
      for (const t of parseTagChips(conv.$, TAG_CONV_SEL, conv.url)) {
        const key = t.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, { ...t, conversations_seen: 1 });
      }
    }
  }
  if (!detected) return { available: false, reason: TAGS_UNAVAILABLE, mailbox_ids: scanned, query };
  const tags = [...seen.values()]
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    available: true,
    mailbox_ids: scanned,
    query,
    tags,
    source,
    note:
      "Only tags visible on the scanned page(s) are listed, not every tag that exists (pass q to search all tags). " +
      "Tags are shared across mailboxes in FreeScout. add_tag adds tags and remove_tag removes them from one conversation.",
  };
}

// ---------------------------------------------------------------------------------------------
// add_tag. Adds only; removing is the separate remove_tag below, with its own form and guard.

export const MAX_TAGS_PER_CALL = 10;
export const MAX_TAG_LENGTH = 50;

/**
 * The only form add_tag ever posts to tags/ajax: `action=add&tag_names[]=a&tag_names[]=b&conversation_id=N`.
 * A type alias (not an interface) so it is assignable to the port's form record.
 */
export type TagForm = { action: "add"; tag_names: string[]; conversation_id: string };

const TAG_FORM_KEYS = ["action", "conversation_id", "tag_names"];

/** Problems with one tag name (empty list = valid). Commas separate tokens in the module's UI, so they are refused. */
function tagNameProblems(name: unknown): string[] {
  if (typeof name !== "string") return ["tag name is not a string"];
  const p: string[] = [];
  if (name !== name.trim()) p.push(`tag name ${JSON.stringify(name)} is not trimmed`);
  if (name.length < 1 || name.length > MAX_TAG_LENGTH) p.push(`tag name ${JSON.stringify(name)} must be 1..${MAX_TAG_LENGTH} characters`);
  if (name.includes(",")) p.push(`tag name ${JSON.stringify(name)} contains a comma`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) p.push(`tag name ${JSON.stringify(name)} contains control characters`);
  return p;
}

/**
 * Hard guard run right before the POST. The same endpoint does bulk tagging when conversation_id is an ARRAY
 * (the module's list view sends getSelectedConversations()), and removes tags with action=remove; this form may
 * only ever add names to exactly one conversation.
 */
export function assertTagForm(form: unknown): asserts form is TagForm {
  const problems: string[] = [];
  if (!form || typeof form !== "object" || Array.isArray(form) || ![Object.prototype, null].includes(Object.getPrototypeOf(form))) {
    throw new FreeScoutError("Refusing to send tag form (not a plain object)");
  }
  const f = form as Record<string, unknown>;
  const keys = Object.keys(f).sort();
  for (const k of keys) if (!TAG_FORM_KEYS.includes(k)) problems.push(`unexpected field ${k}`);
  for (const k of TAG_FORM_KEYS) if (!keys.includes(k)) problems.push(`${k} missing`);
  if (f.action !== "add") problems.push("action is not 'add'");
  if (typeof f.conversation_id !== "string" || !/^[1-9]\d*$/.test(f.conversation_id)) {
    problems.push(Array.isArray(f.conversation_id) ? "conversation_id is an array (bulk tagging)" : "conversation_id is not a single positive integer string");
  }
  const names = f.tag_names;
  if (!Array.isArray(names)) problems.push("tag_names is not an array");
  else {
    if (names.length < 1 || names.length > MAX_TAGS_PER_CALL) problems.push(`tag_names must have 1..${MAX_TAGS_PER_CALL} entries`);
    for (const n of names) problems.push(...tagNameProblems(n));
    const keys2 = names.filter((n): n is string => typeof n === "string").map(tagKey);
    if (new Set(keys2).size !== keys2.length) problems.push("duplicate tag names");
  }
  if (problems.length) throw new FreeScoutError(`Refusing to send tag form (${problems.join(", ")})`);
}

export function buildTagForm(conversationId: number, names: string[]): TagForm {
  const form: TagForm = { action: "add", tag_names: [...names], conversation_id: String(conversationId) };
  assertTagForm(form);
  return form;
}

export interface TagResult {
  conversation_id: number;
  tags_before: string[];
  tags_after: string[];
  added: string[];
  /** Names from the ajax response's `tags` list (the conversation's resulting tags); null if absent. */
  response_tags?: string[] | null;
  note?: string;
}

/** Load the conversation and its current tags, refusing draft conversations and pages without the module. */
async function loadTaggable(port: FreeScoutPort, conversationId: number): Promise<string[]> {
  const { conv, page } = await loadConversation(port, conversationId);
  refuseDraftConversation(conv, "tag");
  const tags = conversationTags(page);
  if (tags === null) {
    throw new FreeScoutError(
      `Conversation ${conversationId} has no tag controls: the paid Tags module is not installed on this FreeScout or ` +
        "not available to this user. Tags cannot be changed.",
    );
  }
  return tags;
}

/**
 * Add tags to one conversation. Never removes a tag, never touches status/assignee/customer: the only POST is
 * `action=add` to tags/ajax with the new names, and the page is re-read to verify nothing was lost.
 */
export async function addTag(port: FreeScoutPort, conversationId: number, requested: string[]): Promise<TagResult> {
  const wanted: string[] = [];
  for (const raw of requested) {
    const name = typeof raw === "string" ? raw.trim() : raw;
    const p = tagNameProblems(name);
    if (p.length) throw new FreeScoutError(`Invalid tag: ${p.join(", ")}`);
    if (!wanted.some((w) => tagKey(w) === tagKey(name as string))) wanted.push(name as string);
  }
  if (wanted.length < 1 || wanted.length > MAX_TAGS_PER_CALL) throw new FreeScoutError(`Give 1..${MAX_TAGS_PER_CALL} tags`);

  // Fresh page: current tags, draft check and (via Session) a fresh CSRF token.
  const before = await loadTaggable(port, conversationId);
  const have = new Set(before.map(tagKey));
  const toAdd = wanted.filter((n) => !have.has(tagKey(n)));
  if (toAdd.length === 0) {
    return { conversation_id: conversationId, added: [], tags_before: before, tags_after: before, note: "already tagged" };
  }

  const form = buildTagForm(conversationId, toAdd);
  assertTagForm(form);
  const res = checkAjax(await port.ajaxPost<AjaxEnvelope & { tags?: unknown }>(TAGS_AJAX, form), "add_tag");
  const responseTags = Array.isArray(res.tags)
    ? res.tags.map((t) => (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" ? squish((t as { name: string }).name) : "")).filter(Boolean)
    : null;

  const after = await loadTaggable(port, conversationId);
  const now = new Set(after.map(tagKey));
  const detail = `tags_before=${JSON.stringify(before)}, tags_after=${JSON.stringify(after)}, response_tags=${JSON.stringify(responseTags)}`;
  const vanished = before.filter((n) => !now.has(tagKey(n)));
  if (vanished.length) {
    throw new FreeScoutError(
      `DANGER: after add_tag, conversation ${conversationId} lost tag(s) ${JSON.stringify(vanished)} that were there before. ` +
        `add_tag never removes tags; a human must check this conversation in FreeScout and restore them. (${detail})`,
    );
  }
  const missing = toAdd.filter((n) => !now.has(tagKey(n)));
  if (missing.length) {
    throw new FreeScoutError(
      `FreeScout accepted add_tag but ${JSON.stringify(missing)} is not shown on conversation ${conversationId} afterwards ` +
        `(FreeScout may have normalised the name differently). Check the conversation in the UI. (${detail})`,
    );
  }
  return { conversation_id: conversationId, tags_before: before, tags_after: after, added: toAdd, response_tags: responseTags };
}

// remove_tag. One tag per POST (the module's remove action takes a single tag_name), one conversation only.

/** The only form remove_tag ever posts to tags/ajax: `action=remove&tag_name=a&conversation_id=N`. */
export type TagRemoveForm = { action: "remove"; tag_name: string; conversation_id: string };

const TAG_REMOVE_FORM_KEYS = ["action", "conversation_id", "tag_name"];

/** Hard guard run right before each remove POST: one string tag name, one conversation id (never an array). */
export function assertTagRemoveForm(form: unknown): asserts form is TagRemoveForm {
  const problems: string[] = [];
  if (!form || typeof form !== "object" || Array.isArray(form) || ![Object.prototype, null].includes(Object.getPrototypeOf(form))) {
    throw new FreeScoutError("Refusing to send tag remove form (not a plain object)");
  }
  const f = form as Record<string, unknown>;
  const keys = Object.keys(f).sort();
  for (const k of keys) if (!TAG_REMOVE_FORM_KEYS.includes(k)) problems.push(`unexpected field ${k}`);
  for (const k of TAG_REMOVE_FORM_KEYS) if (!keys.includes(k)) problems.push(`${k} missing`);
  if (f.action !== "remove") problems.push("action is not 'remove'");
  if (typeof f.conversation_id !== "string" || !/^[1-9]\d*$/.test(f.conversation_id)) {
    problems.push(Array.isArray(f.conversation_id) ? "conversation_id is an array (bulk tagging)" : "conversation_id is not a single positive integer string");
  }
  if (Array.isArray(f.tag_name)) problems.push("tag_name is an array");
  else problems.push(...tagNameProblems(f.tag_name));
  if (problems.length) throw new FreeScoutError(`Refusing to send tag remove form (${problems.join(", ")})`);
}

export function buildTagRemoveForm(conversationId: number, name: string): TagRemoveForm {
  const form: TagRemoveForm = { action: "remove", tag_name: name, conversation_id: String(conversationId) };
  assertTagRemoveForm(form);
  return form;
}

export interface TagRemoveResult {
  conversation_id: number;
  tags_before: string[];
  tags_after: string[];
  removed: string[];
  /** Requested names that were not on the conversation (nothing posted for them). */
  not_present: string[];
  note?: string;
}

/**
 * Remove tags from one conversation. Only names currently shown on the conversation are posted (one
 * `action=remove` per tag, using the name exactly as shown), never status/assignee/customer fields, and the page
 * is re-read to verify the removed tags are gone and every other tag is still there.
 */
export async function removeTag(port: FreeScoutPort, conversationId: number, requested: string[]): Promise<TagRemoveResult> {
  const wanted: string[] = [];
  for (const raw of requested) {
    const name = typeof raw === "string" ? raw.trim() : raw;
    const p = tagNameProblems(name);
    if (p.length) throw new FreeScoutError(`Invalid tag: ${p.join(", ")}`);
    if (!wanted.some((w) => tagKey(w) === tagKey(name as string))) wanted.push(name as string);
  }
  if (wanted.length < 1 || wanted.length > MAX_TAGS_PER_CALL) throw new FreeScoutError(`Give 1..${MAX_TAGS_PER_CALL} tags`);

  const before = await loadTaggable(port, conversationId);
  const toRemove: string[] = [];
  const notPresent: string[] = [];
  for (const w of wanted) {
    const shown = before.find((n) => tagKey(n) === tagKey(w));
    if (shown === undefined) notPresent.push(w);
    else toRemove.push(shown);
  }
  if (toRemove.length === 0) {
    return { conversation_id: conversationId, removed: [], not_present: notPresent, tags_before: before, tags_after: before, note: "none of these tags are on the conversation" };
  }

  for (const name of toRemove) {
    const form = buildTagRemoveForm(conversationId, name);
    assertTagRemoveForm(form);
    checkAjax(await port.ajaxPost<AjaxEnvelope>(TAGS_AJAX, form), "remove_tag");
  }

  const after = await loadTaggable(port, conversationId);
  const now = new Set(after.map(tagKey));
  const removedKeys = new Set(toRemove.map(tagKey));
  const detail = `tags_before=${JSON.stringify(before)}, tags_after=${JSON.stringify(after)}`;
  const collateral = before.filter((n) => !removedKeys.has(tagKey(n)) && !now.has(tagKey(n)));
  if (collateral.length) {
    throw new FreeScoutError(
      `DANGER: after remove_tag, conversation ${conversationId} also lost tag(s) ${JSON.stringify(collateral)} that were not ` +
        `asked to be removed; a human must check this conversation in FreeScout and restore them. (${detail})`,
    );
  }
  const still = toRemove.filter((n) => now.has(tagKey(n)));
  if (still.length) {
    throw new FreeScoutError(
      `FreeScout accepted remove_tag but ${JSON.stringify(still)} is still shown on conversation ${conversationId} afterwards. ` +
        `Check the conversation in the UI. (${detail})`,
    );
  }
  return { conversation_id: conversationId, tags_before: before, tags_after: after, removed: toRemove, not_present: notPresent };
}

// ---------------------------------------------------------------------------------------------
// Writes: internal note and reply draft. There is deliberately no customer reply/send code path. The note form
// never carries `subtype`; forwarding is a separate, allow-listed and pinned path (forwardConversation, below).

const BLOCK_TAGS = new Set(["p", "br", "div", "ul", "ol", "li", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "td", "th", "hr"]);
const INLINE_TAGS = new Set(["strong", "em", "b", "i", "u", "s", "a", "code", "span", "small", "sub", "sup"]);

/** Tag names of the elements the input really parses into (text inside comments/scripts does not count). */
function elementTags(text: string): Set<string> {
  const $ = cheerio.load(text, null, false);
  const tags = new Set<string>();
  $("*").each((_, el) => {
    const name = (el as { tagName?: string }).tagName;
    if (name) tags.add(name.toLowerCase());
  });
  return tags;
}

/**
 * Body for the FreeScout editor. The input counts as HTML only if it parses into at least one element
 * from the allow-lists above; anything else (including "<script>…", "<!-- … -->", "<int>") is plain text.
 * Plain text: <p> per paragraph (blank line), <br> per line, escaped.
 * Allow-listed inline tags only (<b>, <a>, <code>…): same paragraph/line wrapping, tags kept.
 * An allow-listed block tag (<p>, <ul>, <br>…): used as HTML. HTML is sanitised (no scripts, forms,
 * event handlers or javascript: links).
 */
export function formatBody(input: string): string {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new FreeScoutError("body is empty");
  const tags = text.includes("<") ? elementTags(text) : new Set<string>();
  if ([...tags].some((t) => BLOCK_TAGS.has(t))) return sanitizeHtml(text);
  const inline = [...tags].some((t) => INLINE_TAGS.has(t));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map((l) => (inline ? l : esc(l))).join("<br>")}</p>`)
    .join("");
  return inline ? sanitizeHtml(html) : html;
}

function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html, null, false);
  $("script, style, iframe, object, embed, form, input, button, textarea, select, link, meta, base").remove();
  $("*").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      const v = attribs[name] ?? "";
      if (/^on/i.test(name) || ((name === "href" || name === "src") && /^\s*(javascript|data|vbscript):/i.test(v))) {
        $(el).removeAttr(name);
      }
    }
  });
  return $.html().trim();
}

export interface NoteFormInput {
  conversation_id: number;
  mailbox_id: number;
  /** Current assignee user id, or -1 when unassigned. Omitting it 500s FreeScout on assigned conversations. */
  user_id: number;
  /** Current Conversation::STATUS_* value, so adding a note does not change the status. */
  status: number;
  body: string;
}

/**
 * Field set for an internal note (docs/freescout-endpoints.md §5.1). `send_reply` is the same action
 * that emails customers; `is_note` is the only switch, so it is pinned as the last key (nothing can
 * override it) and `subtype` (forward) / `thread_id` (publishes a draft) are never present. Forwarding has its
 * own builder and guard (buildForwardForm / assertForwardForm); this form can never become a forward.
 */
export function buildNoteForm(input: NoteFormInput): Record<string, string> {
  const form: Record<string, string> = {
    action: "send_reply",
    conversation_id: String(input.conversation_id),
    mailbox_id: String(input.mailbox_id),
    body: input.body,
    user_id: String(input.user_id),
    status: String(input.status),
    is_note: "1",
  };
  assertNoteForm(form);
  return form;
}

const NOTE_FIELDS = new Set(["action", "conversation_id", "mailbox_id", "body", "user_id", "status", "is_note"]);

/**
 * Hard guard run right before the POST. Throws instead of ever sending something that could email a customer.
 * `subtype` stays forbidden here: a note is never a forward (see assertForwardForm for that separate path).
 */
export function assertNoteForm(form: Record<string, string>): void {
  const problems: string[] = [];
  if (form.is_note !== "1") problems.push("is_note is not '1'");
  if ("subtype" in form) problems.push("subtype present");
  if ("thread_id" in form) problems.push("thread_id present");
  if (form.action !== "send_reply") problems.push("action is not send_reply");
  if (!/^-?\d+$/.test(form.user_id ?? "")) problems.push("user_id missing");
  if (!/^\d+$/.test(form.status ?? "")) problems.push("status missing");
  for (const k of Object.keys(form)) if (!NOTE_FIELDS.has(k)) problems.push(`unexpected field ${k}`);
  if (problems.length) throw new FreeScoutError(`Refusing to send note form (${problems.join(", ")})`);
}

export interface NoteResult {
  conversation_id: number;
  number: number | null;
  thread_id: number;
  type: "note";
  body: string;
  status: string | null;
  assignee: string | null;
  /** Set (true) only when another status/assignee change was logged during the call; see concurrentChangeWarning. */
  concurrent_change_detected?: true;
  warning?: string;
}

/**
 * Status/assignee change log lines ("lineitem" threads). They have no thread id, so the `known` thread-id sets cannot
 * see them; counting them before and after a write is the only way to notice a teammate changing status or assignee
 * while the call was in flight (send_reply itself never adds one).
 */
function lineitemCount(conv: ParsedConversation): number {
  return conv.threads.filter((t) => t.type === "lineitem").length;
}

function concurrentChangeWarning(conversationId: number, what: string): string {
  return (
    `Someone else changed the status or assignee of conversation ${conversationId} while this ${what} was being saved. ` +
    "This request carried the status and assignee read beforehand, so it may have overwritten their change. " +
    `Ask the human to re-check the status and assignee of conversation ${conversationId} in FreeScout.`
  );
}

/**
 * A draft *conversation* (New Conversation page, not yet sent) must not be touched: FreeScout's
 * send_reply on it publishes the conversation, which emails the recipient.
 */
function refuseDraftConversation(conv: ParsedConversation, what: string): void {
  if (conv.is_draft_conversation) {
    throw new FreeScoutError(
      `Conversation ${conv.id} is an unsent draft conversation (a new conversation still being composed in FreeScout); ` +
        `refusing to ${what} it, because acting on it could publish (send) it. A human must finish or discard it in the UI.`,
    );
  }
}

export async function addNote(port: FreeScoutPort, conversationId: number, rawBody: string): Promise<NoteResult> {
  const body = formatBody(rawBody);
  // Fresh page: current status, assignee and mailbox, and (via Session) a fresh CSRF token.
  const before = await getConversation(port, conversationId);
  refuseDraftConversation(before, "add a note to");
  if (before.mailbox_id === null) throw new FreeScoutError("Could not read the conversation's mailbox id");
  if (before.status_value === null) throw new FreeScoutError("Could not read the conversation's current status");
  if (before.assignee_id === null) throw new FreeScoutError("Could not read the conversation's current assignee");
  const known = new Set(before.threads.map((t) => t.thread_id).filter((x): x is number => x !== null));
  const lineitemsBefore = lineitemCount(before);

  const form = buildNoteForm({
    conversation_id: conversationId,
    mailbox_id: before.mailbox_id,
    user_id: before.assignee_id,
    status: before.status_value,
    body,
  });
  assertNoteForm(form);
  checkAjax(await port.ajaxPost<AjaxEnvelope>(AJAX, form), "add_note");

  const after = await getConversation(port, conversationId);
  const fresh = after.threads.filter((t) => t.thread_id !== null && !known.has(t.thread_id) && t.type !== "lineitem");
  if (fresh.length === 0) {
    throw new FreeScoutError("FreeScout accepted the note but no new thread appeared on the conversation. Check the conversation in the UI.");
  }
  // send_reply can only create a note or an agent message; a new customer thread is an inbound email
  // that arrived meanwhile, not something we created.
  const wrong = fresh.filter((t) => t.type !== "note" && t.type !== "draft" && t.type !== "customer");
  if (wrong.length) {
    throw new FreeScoutError(
      `DANGER: add_note created thread(s) ${wrong.map((t) => `${t.thread_id}:${t.type}`).join(", ")} that are NOT notes. ` +
        "A human must check this conversation in FreeScout immediately.",
    );
  }
  const note = fresh.filter((t) => t.type === "note").pop();
  if (!note || note.thread_id === null) {
    throw new FreeScoutError("FreeScout accepted the request but the new thread is not a note. Check the conversation in the UI.");
  }
  const result: NoteResult = {
    conversation_id: conversationId,
    number: after.number,
    thread_id: note.thread_id,
    type: "note",
    body: note.body,
    status: after.status,
    assignee: after.assignee,
  };
  // Not an error: the note is stored, and an error would invite a retry (a duplicate note).
  if (lineitemCount(after) > lineitemsBefore) {
    result.concurrent_change_detected = true;
    result.warning = concurrentChangeWarning(conversationId, "note");
  }
  return result;
}

/** Fields for `save_draft` on an existing conversation (§5.2). No is_note / subtype / is_create / recipients. */
export function buildDraftForm(input: { conversation_id: number; mailbox_id: number; body: string; thread_id?: number }): Record<string, string> {
  const form: Record<string, string> = {
    action: "save_draft",
    conversation_id: String(input.conversation_id),
    mailbox_id: String(input.mailbox_id),
    thread_id: input.thread_id ? String(input.thread_id) : "",
    body: input.body,
  };
  for (const k of ["is_note", "subtype", "is_create", "to", "cc", "bcc"]) {
    if (k in form) throw new FreeScoutError(`Refusing to send draft form with ${k}`);
  }
  return form;
}

export interface DraftResult {
  conversation_id: number;
  number: number | null;
  thread_id: number;
  updated: boolean;
  body: string;
}

function requireDraftThread(conv: ParsedConversation, threadId: number): void {
  const t = conv.threads.find((x) => x.thread_id === threadId);
  if (!t) throw new FreeScoutError(`Thread ${threadId} is not on conversation ${conv.id}`);
  if (t.type !== "draft") throw new FreeScoutError(`Thread ${threadId} is a ${t.type ?? "unknown"} thread, not a draft; refusing`);
}

export async function saveDraft(port: FreeScoutPort, conversationId: number, rawBody: string, threadId?: number): Promise<DraftResult> {
  const body = formatBody(rawBody);
  const conv = await getConversation(port, conversationId);
  refuseDraftConversation(conv, "save a reply draft on");
  if (conv.mailbox_id === null) throw new FreeScoutError("Could not read the conversation's mailbox id");
  if (threadId) requireDraftThread(conv, threadId);
  const form = buildDraftForm({ conversation_id: conversationId, mailbox_id: conv.mailbox_id, body, thread_id: threadId });
  const res = checkAjax(await port.ajaxPost<AjaxEnvelope & { thread_id?: number; number?: number }>(AJAX, form), "save_draft");
  const newId = Number(res.thread_id);
  if (!Number.isInteger(newId) || newId <= 0) throw new FreeScoutError("save_draft: FreeScout did not return a thread_id");
  const after = await getConversation(port, conversationId);
  const t = after.threads.find((x) => x.thread_id === newId);
  if (!t || t.type !== "draft") {
    throw new FreeScoutError(`save_draft: thread ${newId} is ${t ? `a ${t.type} thread` : "missing"} after saving, expected a draft`);
  }
  return {
    conversation_id: conversationId,
    number: typeof res.number === "number" ? res.number : after.number,
    thread_id: newId,
    updated: Boolean(threadId),
    body: t.body,
  };
}

export async function discardDraft(port: FreeScoutPort, conversationId: number, threadId: number): Promise<{ conversation_id: number; thread_id: number; discarded: true }> {
  const conv = await getConversation(port, conversationId);
  refuseDraftConversation(conv, "discard a draft of"); // discard_draft would delete the whole conversation
  requireDraftThread(conv, threadId);
  // discard_draft deletes the whole conversation when the conversation itself is a draft;
  // only allow it on conversations that have published threads.
  if (!conv.threads.some((t) => t.type === "customer" || t.type === "message" || t.type === "note")) {
    throw new FreeScoutError(`Conversation ${conversationId} has no published threads (it is a draft conversation); refusing to discard`);
  }
  checkAjax(await port.ajaxPost<AjaxEnvelope>(AJAX, { action: "discard_draft", thread_id: String(threadId) }), "discard_draft");
  const after = await getConversation(port, conversationId);
  if (after.threads.some((t) => t.thread_id === threadId)) {
    throw new FreeScoutError(`discard_draft: thread ${threadId} is still on conversation ${conversationId}`);
  }
  return { conversation_id: conversationId, thread_id: threadId, discarded: true };
}

// ---------------------------------------------------------------------------------------------
// Close a conversation: conversation_change_status with status pinned to Closed (§5.4). There is no
// reopen / pending / spam / assign code path: STATUS_CLOSED is the only status this module ever posts.

/** Conversation::STATUS_CLOSED (app/Conversation.php). */
export const STATUS_CLOSED = 3;
/** Conversation::STATUS_SPAM. Closing a spam conversation would move it back into the mailbox (un-spam). */
export const STATUS_SPAM = 4;

export type StatusForm = { action: "conversation_change_status"; conversation_id: string; status: "3" };

const STATUS_FORM_KEYS = ["action", "conversation_id", "status"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}

/**
 * Hard guard run right before the POST: exactly {action:'conversation_change_status', conversation_id, status:'3'}.
 * Any other status (1 active = reopen, 2 pending, 4 spam, 'not_spam'), an array id or any extra key is refused.
 */
export function assertStatusForm(form: unknown): asserts form is StatusForm {
  if (!isPlainObject(form)) throw new FreeScoutError("Refusing to send status form (not a plain object)");
  const problems: string[] = [];
  const keys = Object.keys(form);
  for (const k of keys) if (!STATUS_FORM_KEYS.includes(k)) problems.push(`unexpected field ${k}`);
  for (const k of STATUS_FORM_KEYS) if (!keys.includes(k)) problems.push(`${k} missing`);
  if (form.action !== "conversation_change_status") problems.push("action is not 'conversation_change_status'");
  if (form.status !== String(STATUS_CLOSED)) problems.push(`status is not '${STATUS_CLOSED}' (closed)`);
  if (typeof form.conversation_id !== "string" || !/^[1-9]\d*$/.test(form.conversation_id)) {
    problems.push("conversation_id is not a single positive integer string");
  }
  if (problems.length) throw new FreeScoutError(`Refusing to send status form (${problems.join(", ")})`);
}

export function buildStatusForm(conversationId: number): StatusForm {
  const form: StatusForm = { action: "conversation_change_status", conversation_id: String(conversationId), status: "3" };
  assertStatusForm(form);
  return form;
}

export interface CloseResult {
  conversation_id: number;
  number: number | null;
  previous_status: string | null;
  status: "closed";
  already_closed: boolean;
  changed: boolean;
  assignee_id: number | null;
  assignee: string | null;
  thread_count: number;
  /** Set (true) only when more than our one status line was logged during the call. */
  concurrent_change_detected?: true;
  warning?: string;
}

function requireWritable(conv: ParsedConversation): { mailbox_id: number; status_value: number; assignee_id: number } {
  if (conv.mailbox_id === null) throw new FreeScoutError("Could not read the conversation's mailbox id");
  if (conv.status_value === null) throw new FreeScoutError("Could not read the conversation's current status");
  if (conv.assignee_id === null) throw new FreeScoutError("Could not read the conversation's current assignee");
  return { mailbox_id: conv.mailbox_id, status_value: conv.status_value, assignee_id: conv.assignee_id };
}

function closedResult(conv: ParsedConversation, previous: string | null, changed: boolean): CloseResult {
  return {
    conversation_id: conv.id,
    number: conv.number,
    previous_status: previous,
    status: "closed",
    already_closed: !changed,
    changed,
    assignee_id: conv.assignee_id,
    assignee: conv.assignee,
    thread_count: conv.threads.length,
  };
}

/**
 * Set one conversation's status to Closed. Never reopens, never changes the assignee, never emails the customer
 * (FreeScout's ConversationStatusChanged only notifies users). Already closed: returns without posting, because
 * FreeScout answers "Status already set" as an error.
 */
export async function closeConversation(port: FreeScoutPort, conversationId: number): Promise<CloseResult> {
  // Fresh page: status, assignee, thread ids, draft check and (via Session) a fresh CSRF token.
  const before = await getConversation(port, conversationId);
  refuseDraftConversation(before, "close");
  const cur = requireWritable(before);
  if (cur.status_value === STATUS_CLOSED) return closedResult(before, "closed", false);
  if (cur.status_value === STATUS_SPAM) {
    throw new FreeScoutError(
      `Conversation ${conversationId} is marked as Spam; refusing to close it, because closing would move it out of Spam ` +
        "back into the mailbox. A human must decide in FreeScout whether it is spam.",
    );
  }
  const known = new Set(before.threads.map((t) => t.thread_id).filter((x): x is number => x !== null));
  const lineitemsBefore = lineitemCount(before);

  const form = buildStatusForm(conversationId);
  assertStatusForm(form);
  try {
    checkAjax(await port.ajaxPost<AjaxEnvelope>(AJAX, form), "close_conversation");
  } catch (e) {
    // Closed meanwhile (by a teammate): FreeScout says "Status already set". Report it as already closed.
    if (!(e instanceof PermissionError) && e instanceof FreeScoutError && /status already set/i.test(e.message)) {
      const now = await getConversation(port, conversationId);
      if (now.status_value === STATUS_CLOSED) return closedResult(now, before.status, false);
    }
    throw e;
  }

  const after = await getConversation(port, conversationId);
  const fresh = after.threads.filter((t) => t.thread_id !== null && !known.has(t.thread_id));
  // Changing status creates only a lineitem (status log, normally without a thread id). A new customer thread is
  // an inbound email that arrived meanwhile. Anything else would be something this call must never create.
  const wrong = fresh.filter((t) => t.type !== "lineitem" && t.type !== "customer");
  if (wrong.length) {
    throw new FreeScoutError(
      `DANGER: close_conversation created thread(s) ${wrong.map((t) => `${t.thread_id}:${t.type}`).join(", ")} on ` +
        `conversation ${conversationId}; closing must only add a status line. A human must check this conversation in FreeScout immediately.`,
    );
  }
  if (after.assignee_id !== before.assignee_id) {
    throw new FreeScoutError(
      `DANGER: after close_conversation the assignee of conversation ${conversationId} changed from ${before.assignee_id} ` +
        `to ${after.assignee_id}. Closing never reassigns; a human must check this conversation in FreeScout.`,
    );
  }
  if (after.status_value !== STATUS_CLOSED) {
    throw new FreeScoutError(
      `FreeScout accepted close_conversation but conversation ${conversationId} shows status ${after.status ?? after.status_value} ` +
        "afterwards. Check the conversation in the UI.",
    );
  }
  const result = closedResult(after, before.status, true);
  // Our close logs exactly one status line; more means a teammate changed status/assignee meanwhile.
  if (lineitemCount(after) - lineitemsBefore > 1) {
    result.concurrent_change_detected = true;
    result.warning = concurrentChangeWarning(conversationId, "close");
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Forward a conversation to ONE allow-listed recipient (§5.5): send_reply + is_note=1 + subtype=1 + to_email[].
// This is outbound email, so it is gated three times: the tool exists only when FREESCOUT_FORWARD_ALLOW is set,
// the recipient must match it and must not be the conversation's customer, and the form is pinned and asserted.

export type ForwardForm = {
  action: "send_reply";
  conversation_id: string;
  mailbox_id: string;
  body: string;
  user_id: string;
  status: string;
  is_note: "1";
  subtype: "1";
  to_email: [string];
};

export interface ForwardFormInput {
  conversation_id: number;
  mailbox_id: number;
  body: string;
  /** Current assignee user id, or -1 when unassigned (same quirk as notes). */
  user_id: number;
  /** Current Conversation::STATUS_* value, so the forward does not change the status. */
  status: number;
  /** One normalised recipient. */
  to: string;
}

const FORWARD_FORM_KEYS = ["action", "body", "conversation_id", "is_note", "mailbox_id", "status", "subtype", "to_email", "user_id"];

/**
 * Hard guard run right before the POST. `is_note=1` is pinned next to `subtype=1` as a failsafe: if `subtype` were
 * ever lost, FreeScout would store an internal note instead of emailing anyone (with `subtype=1` the forward branch
 * still wins, ConversationsController: `if ($is_note || $is_forward) type = NOTE`, events check is_forward first).
 * `to_email` must be an array of exactly one strict address; `to`/`cc`/`bcc` would reach the forwarded
 * conversation, `thread_id` publishes a draft, `is_create` creates a new conversation, so all are refused.
 */
export function assertForwardForm(form: unknown): asserts form is ForwardForm {
  if (!isPlainObject(form)) throw new FreeScoutError("Refusing to send forward form (not a plain object)");
  const problems: string[] = [];
  const keys = Object.keys(form);
  for (const k of keys) if (!FORWARD_FORM_KEYS.includes(k)) problems.push(`unexpected field ${k}`);
  for (const k of FORWARD_FORM_KEYS) if (!keys.includes(k)) problems.push(`${k} missing`);
  if (form.action !== "send_reply") problems.push("action is not send_reply");
  if (form.is_note !== "1") problems.push("is_note is not '1'");
  if (form.subtype !== "1") problems.push("subtype is not '1' (forward)");
  for (const k of ["conversation_id", "mailbox_id"]) {
    const v = form[k];
    if (typeof v !== "string" || !/^[1-9]\d*$/.test(v)) problems.push(`${k} is not a single positive integer string`);
  }
  if (typeof form.user_id !== "string" || !/^-?\d+$/.test(form.user_id)) problems.push("user_id missing or not an integer");
  if (typeof form.status !== "string" || !/^\d+$/.test(form.status)) problems.push("status missing or not an integer");
  if (typeof form.body !== "string" || !form.body.trim()) problems.push("body is empty");
  const to = form.to_email;
  if (!Array.isArray(to)) problems.push("to_email is not an array");
  else if (to.length !== 1) problems.push(`to_email must have exactly one recipient (has ${to.length})`);
  else if (!isStrictRecipient(to[0])) problems.push("to_email[0] is not a single bare lowercase address");
  for (const k of keys) if (k !== "to_email" && typeof form[k] !== "string") problems.push(`${k} is not a string`);
  if (problems.length) throw new FreeScoutError(`Refusing to send forward form (${problems.join(", ")})`);
}

export function buildForwardForm(input: ForwardFormInput): ForwardForm {
  const form: ForwardForm = {
    action: "send_reply",
    conversation_id: String(input.conversation_id),
    mailbox_id: String(input.mailbox_id),
    body: input.body,
    user_id: String(input.user_id),
    status: String(input.status),
    is_note: "1",
    subtype: "1",
    to_email: [input.to],
  };
  assertForwardForm(form);
  return form;
}

export interface ForwardResult {
  conversation_id: number;
  number: number | null;
  forwarded_to: string;
  /** The forward note created on the original conversation. */
  thread_id: number;
  /** Whether the note carried FreeScout's forward marker on the re-read page. */
  forward_marker_seen: boolean;
  /** `#number` of the new "Fwd:" conversation when the page shows it, else null. */
  forwarded_conversation_number: number | null;
  status: string | null;
  assignee: string | null;
  /** Set (true) only when a status/assignee change was logged during the call; see concurrentChangeWarning. */
  concurrent_change_detected?: true;
  warning?: string;
}

/**
 * Prefix of every forward error raised after the POST was dispatched, when FreeScout may have processed it. The
 * forward cannot be undone after its ~15 s window and a retry sends a second email, so the caller must not retry.
 */
export const POSSIBLY_SENT = "POSSIBLY SENT:";

function possiblySent(to: string, conversationId: number, cause: unknown): FreeScoutError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new FreeScoutError(
    `${POSSIBLY_SENT} the forward to ${to} on conversation ${conversationId} may already have gone out. Do NOT retry ` +
      `forward_conversation; check conversation ${conversationId} in FreeScout for a forward note first. (${msg})`,
  );
}

/** Trim + lowercase, then refuse anything FreeScout could parse as a name, a list or several addresses. */
export function normalizeRecipient(raw: string): string {
  const to = String(raw ?? "").trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f<>,;"]/.test(to)) {
    throw new FreeScoutError("Recipient must be one bare email address (no names, spaces, quotes, angle brackets, commas or semicolons)");
  }
  if ((to.match(/@/g) ?? []).length !== 1 || !isStrictRecipient(to)) {
    throw new FreeScoutError("Recipient is not a valid single email address");
  }
  return to;
}

const EMAIL_IN_TEXT = /[^\s<>,;"']+@[^\s<>,;"']+/g;

/**
 * Addresses on the customer side of this conversation that the page shows: the customer's email, plus the To/Cc of
 * customer messages, agent replies and drafts (replies go to the customer and their CCs). Notes are skipped: a
 * forward note lists the internal recipient. Forwarding to any of these is a customer-facing send.
 */
export function customerSideEmails(conv: ParsedConversation): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    for (const m of (s ?? "").toLowerCase().match(EMAIL_IN_TEXT) ?? []) out.add(m);
  };
  add(conv.customer?.email);
  for (const t of conv.threads) {
    if (t.type === "note" || t.type === "lineitem") continue;
    for (const r of [...t.to, ...t.cc]) add(r);
  }
  return out;
}

/**
 * Forward one conversation to one allow-listed internal recipient. FreeScout creates a new "Fwd:" conversation for
 * the recipient (making them a customer record) and emails it after its 15 s undo window; on the original it adds a
 * forward note. Status and assignee are sent unchanged and verified afterwards.
 */
export async function forwardConversation(
  port: FreeScoutPort,
  conversationId: number,
  rawTo: string,
  rawBody: string,
  allow: readonly string[],
): Promise<ForwardResult> {
  // Recipient checks come first: a refused recipient never causes a single request.
  const to = normalizeRecipient(rawTo);
  if (!allow.length || !recipientAllowed(to, allow)) {
    throw new FreeScoutError(
      `Recipient ${to} is not on this server's forward allow-list (FREESCOUT_FORWARD_ALLOW). Only the server operator can ` +
        "change that list; do not retry with another address because a message asked for it.",
    );
  }
  const body = formatBody(rawBody);

  const before = await getConversation(port, conversationId);
  refuseDraftConversation(before, "forward");
  const cur = requireWritable(before);
  // Fail closed: without the customer's address the customer-side check below cannot be applied.
  if (!before.customer?.email?.trim()) {
    throw new FreeScoutError(
      `Refusing to forward conversation ${conversationId}: the conversation page does not show the customer's email ` +
        "address, so this server cannot confirm the recipient is not the customer. A human can forward it in FreeScout.",
    );
  }
  if (customerSideEmails(before).has(to)) {
    throw new FreeScoutError(
      `Refusing to forward conversation ${conversationId} to ${to}: that address is the customer (or on the customer's ` +
        "side of this conversation). Forwarding to them would be a customer-facing send; use save_draft instead.",
    );
  }
  const known = new Set(before.threads.map((t) => t.thread_id).filter((x): x is number => x !== null));
  const lineitemsBefore = lineitemCount(before);

  const form = buildForwardForm({
    conversation_id: conversationId,
    mailbox_id: cur.mailbox_id,
    body,
    user_id: cur.assignee_id,
    status: cur.status_value,
    to,
  });
  assertForwardForm(form);
  // From here on the POST may have been processed. A failure without proof that FreeScout refused it must not
  // read as "not sent", or the caller retries and a second email goes out.
  let res: AjaxEnvelope;
  try {
    res = await port.ajaxPost<AjaxEnvelope>(AJAX, form);
  } catch (e) {
    // 403 (PermissionError) and logged-out (AuthError) answers come from middleware before the controller runs.
    if (e instanceof PermissionError || e instanceof AuthError) throw e;
    throw possiblySent(to, conversationId, e);
  }
  try {
    checkAjax(res, "forward_conversation");
  } catch (e) {
    // FreeScout's own {status:"error", msg} envelope is returned before anything is saved or queued.
    if (e instanceof PermissionError) throw e;
    if (isPlainObject(res) && res.status === "error" && typeof res.msg === "string" && res.msg.trim()) throw e;
    throw possiblySent(to, conversationId, e);
  }

  let after: ParsedConversation;
  try {
    after = await getConversation(port, conversationId);
  } catch (e) {
    throw possiblySent(to, conversationId, e);
  }
  const fresh = after.threads.filter((t) => t.thread_id !== null && !known.has(t.thread_id) && t.type !== "lineitem" && t.type !== "customer");
  const wrong = fresh.filter((t) => t.type !== "note");
  if (wrong.length) {
    throw new FreeScoutError(
      `DANGER: forward_conversation created thread(s) ${wrong.map((t) => `${t.thread_id}:${t.type}`).join(", ")} on ` +
        `conversation ${conversationId} that are NOT the forward note; a reply may have been sent to the customer. ` +
        "A human must check this conversation in FreeScout immediately (FreeScout allows undoing a send for about 15 seconds).",
    );
  }
  const changed: string[] = [];
  if (after.status_value !== before.status_value) changed.push(`status ${before.status_value} -> ${after.status_value}`);
  if (after.assignee_id !== before.assignee_id) changed.push(`assignee ${before.assignee_id} -> ${after.assignee_id}`);
  if (changed.length) {
    throw new FreeScoutError(
      `DANGER: after forward_conversation, conversation ${conversationId} changed (${changed.join(", ")}). Forwarding must ` +
        "not change status or assignee; a human must check this conversation in FreeScout. The forward was probably " +
        "sent: do NOT retry.",
    );
  }
  if (fresh.length === 0) {
    throw new FreeScoutError(
      "FreeScout accepted the forward but no forward note appeared on the conversation. Do NOT retry; check the " +
        "conversation in the UI.",
    );
  }
  const marked = fresh.filter((t) => t.is_forward);
  const note = marked.length === 1 ? marked[0]! : fresh.length === 1 ? fresh[0]! : null;
  if (!note || note.thread_id === null) {
    throw new FreeScoutError(
      `FreeScout accepted the forward but ${fresh.length} new notes appeared on conversation ${conversationId}; cannot tell ` +
        "which is the forward note. Do NOT retry; check the conversation in the UI.",
    );
  }
  const result: ForwardResult = {
    conversation_id: conversationId,
    number: after.number,
    forwarded_to: to,
    thread_id: note.thread_id,
    forward_marker_seen: note.is_forward === true,
    forwarded_conversation_number: note.forwarded_conversation_number ?? null,
    status: after.status,
    assignee: after.assignee,
  };
  const warnings: string[] = [];
  if (!note.is_forward) {
    warnings.push(
      "The new note does not show FreeScout's forward marker on the re-read page. If FreeScout stored a plain note, " +
        "nothing was emailed; check the conversation in the UI before forwarding again.",
    );
  }
  // A forward never logs a status line. Not an error: the forward is out, and an error would invite a retry.
  if (lineitemCount(after) > lineitemsBefore) {
    result.concurrent_change_detected = true;
    warnings.push(concurrentChangeWarning(conversationId, "forward"));
  }
  if (warnings.length) result.warning = warnings.join(" ");
  return result;
}
