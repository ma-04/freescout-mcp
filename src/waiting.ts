/**
 * waiting_conversations: active conversations whose customer has been waiting longer than N hours, composed from
 * folder listings (GET only). Folder pages are requested oldest first (`sorting[sort_by]=date&sorting[order]=asc`,
 * honoured by `Conversation::getConvTableSorting()`), so the capped pages hold the longest waits.
 * docs/freescout-endpoints.md §4.2 and "Waiting since" below it.
 */
import type { FreeScoutPort } from "./client.js";
import { FreeScoutError, PermissionError } from "./errors.js";
import { parseConversationTable, type ConversationRow } from "./parsers/conversation-table.js";
import { parseDashboard, parseMailboxSidebar, type FolderType } from "./parsers/mailbox.js";

export const WAITING_FOLDERS = ["unassigned", "mine", "assigned"] as const;
export const WAITING_MAX_PAGES = 5;
/** Hard cap on GETs per call (dashboard + mailbox sidebars + folder pages). */
export const WAITING_MAX_REQUESTS = 40;

/** Bounds, in hours, of how long ago a relative "waiting since" label can be. */
export interface AgeBounds {
  min: number;
  max: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The label's day is in the viewing user's timezone, which we do not know: allow UTC-12..UTC+14. */
const TZ_SLACK_HOURS = 14;

/**
 * FreeScout's `User::dateDiffForHumans()` (English): "Just now" (<= 60 s), Carbon's "N min/hours/days/weeks ago"
 * (diffInDays <= 7), otherwise the date only ("Oct 12", or "Oct 12, 2025" for another year) in the user's timezone.
 * Returns the lower/upper bound of the age in hours, or null for anything else (another locale, empty).
 */
export function parseWaitingAge(label: string | null | undefined, now: Date): AgeBounds | null {
  const s = (label ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "just now") return { min: 0, max: 1 / 60 };
  const rel = /^(\d+|an?)\s+(seconds?|secs?|min|mins|minutes?|hours?|hrs?|days?|weeks?)\s+ago$/.exec(s);
  if (rel) {
    const n = /^\d+$/.test(rel[1]!) ? Number(rel[1]) : 1;
    const unit = rel[2]!;
    const h = unit.startsWith("sec") ? 1 / 3600 : unit.startsWith("min") ? 1 / 60 : unit.startsWith("h") ? 1 : unit.startsWith("d") ? 24 : 168;
    // Carbon floors: "2 days ago" is 48h..72h. FreeScout shows "1 week ago" only at exactly 7 days (diffInDays > 7
    // shows a date), so that label is 168..192 h; any other "N weeks ago" is read as Carbon's floor, N..N+1 weeks.
    return { min: n * h, max: h === 168 && n === 1 ? 192 : (n + 1) * h };
  }
  const abs = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(s);
  if (abs) {
    const month = MONTHS.indexOf(abs[1]!);
    if (month < 0) return null;
    const day = Number(abs[2]);
    let year = abs[3] ? Number(abs[3]) : now.getUTCFullYear();
    let start = Date.UTC(year, month, day);
    if (!abs[3] && start > now.getTime() + 2 * 86400_000) start = Date.UTC(--year, month, day);
    const hoursSince = (t: number) => (now.getTime() - t) / 3600_000;
    // Shown only when diffInDays > 7, i.e. at least 8 days.
    return { min: Math.max(192, hoursSince(start + 86400_000) - TZ_SLACK_HOURS), max: hoursSince(start) + TZ_SLACK_HOURS };
  }
  return null;
}

export interface WaitingRow extends ConversationRow {
  mailbox_id: number;
  folder: FolderType;
  /** Lower bound of the wait in hours (from the relative label; null when the label could not be read). */
  waiting_hours: number | null;
  /** Upper bound of the wait in hours. */
  waiting_hours_max: number | null;
}

export interface WaitingInput {
  mailbox_id?: number;
  older_than_hours?: number;
  max_pages?: number;
}

export interface WaitingResult {
  older_than_hours: number;
  /** Active conversations whose customer has certainly waited at least older_than_hours, longest wait first. */
  conversations: WaitingRow[];
  /** Active, customer waiting, but the label is too coarse to tell (e.g. "1 day ago" with older_than_hours 30). */
  borderline: WaitingRow[];
  counts: {
    waiting: number;
    borderline: number;
    rows_read: number;
    not_active: number;
    last_reply_by_user: number;
    unreadable_age: number;
  };
  /**
   * sorted_oldest_first is false when the table did not echo `data-sorting_order="asc"` or when the rows read were
   * visibly not oldest first (a row certainly older than the one before it); paging then never stops early.
   */
  folders_read: Array<{ mailbox_id: number; folder: FolderType; folder_id: number; pages: number; more_pages: boolean; sorted_oldest_first: boolean }>;
  folders_missing: Array<{ mailbox_id: number; folder: FolderType }>;
  /** Mailboxes skipped while scanning all mailboxes (e.g. no permission to open them). */
  mailboxes_skipped: Array<{ mailbox_id: number; reason: string }>;
  requests_made: number;
  truncated: boolean;
  note: string;
}

export const WAITING_NOTE =
  "Active conversations in the Unassigned, Mine and Assigned folders whose last reply (or creation) is by the " +
  "customer, i.e. the customer is waiting on the team. waiting_hours/waiting_hours_max are bounds derived from " +
  "FreeScout's relative 'waiting since' label (last_reply_at; 'N hours ago' is N..N+1 hours, older than 7 days " +
  "it shows only a date in the viewing user's timezone, so those bounds carry +/-14 h slack). The absolute time " +
  "in last_activity.at is a display string in the viewing user's timezone and is not used. Pending conversations " +
  "and conversations whose last reply is by a user are left out (counted). Pages are requested oldest first; the " +
  "order is checked on every page. Labels are read in English only.";

export const WAITING_UNREADABLE_NOTE = (n: number): string =>
  `${n} active row(s) could not be classified: the 'waiting since' label or its 'Last reply by' tooltip could not be ` +
  "read. Only FreeScout's English UI is understood; with another interface language every row lands here and the " +
  "result is empty although customers may be waiting.";

const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export async function waitingConversations(port: FreeScoutPort, input: WaitingInput = {}, now: Date = new Date()): Promise<WaitingResult> {
  const threshold = input.older_than_hours ?? 24;
  if (typeof threshold !== "number" || !(threshold >= 0) || threshold > 24 * 366) throw new Error("older_than_hours must be 0..8784");
  const maxPages = input.max_pages ?? WAITING_MAX_PAGES;
  if (!isPosInt(maxPages) || maxPages > WAITING_MAX_PAGES) throw new Error(`max_pages must be 1..${WAITING_MAX_PAGES}`);
  if (input.mailbox_id !== undefined && !isPosInt(input.mailbox_id)) throw new Error("mailbox_id must be a positive integer");

  let requests = 0;
  let truncated = false;
  const get = async (path: string) => {
    requests++;
    return port.getHtml(path);
  };
  const budgetLeft = () => requests < WAITING_MAX_REQUESTS;

  let mailboxIds: number[];
  if (input.mailbox_id !== undefined) mailboxIds = [input.mailbox_id];
  else {
    const home = await get("/");
    mailboxIds = parseDashboard(home.$, home.url).map((m) => m.id);
  }

  const result: WaitingResult = {
    older_than_hours: threshold,
    conversations: [],
    borderline: [],
    counts: { waiting: 0, borderline: 0, rows_read: 0, not_active: 0, last_reply_by_user: 0, unreadable_age: 0 },
    folders_read: [],
    folders_missing: [],
    mailboxes_skipped: [],
    requests_made: 0,
    truncated: false,
    note: WAITING_NOTE,
  };
  const seen = new Set<number>();
  /** Folders whose rows were seen out of oldest-first order (as opposed to a missing data-sorting_order echo). */
  const outOfOrder = new Set<(typeof result.folders_read)[number]>();

  for (const mailboxId of mailboxIds) {
    if (!budgetLeft()) {
      truncated = true;
      break;
    }
    let side;
    try {
      const first = await get(`/mailbox/${mailboxId}`);
      side = parseMailboxSidebar(first.$, first.url);
    } catch (e) {
      // A single requested mailbox without access is an error; when scanning all, skip it (and say so).
      if (e instanceof PermissionError && input.mailbox_id === undefined) {
        result.mailboxes_skipped.push({ mailbox_id: mailboxId, reason: `no permission: ${e.message}` });
        continue;
      }
      throw e;
    }
    for (const type of WAITING_FOLDERS) {
      const folder = side.folders.find((f) => f.type === type);
      if (!folder) {
        result.folders_missing.push({ mailbox_id: mailboxId, folder: type });
        continue;
      }
      const entry = { mailbox_id: mailboxId, folder: type, folder_id: folder.id, pages: 0, more_pages: false, sorted_oldest_first: true };
      result.folders_read.push(entry);
      // Age of the previous row read in this folder (across pages), to check the oldest-first order.
      let prevAge: AgeBounds | null = null;
      for (let page = 1; page <= maxPages; page++) {
        if (!budgetLeft()) {
          truncated = true;
          entry.more_pages = true;
          break;
        }
        const qs = new URLSearchParams({ "sorting[sort_by]": "date", "sorting[order]": "asc" });
        if (page > 1) qs.set("page", String(page));
        const html = await get(`/mailbox/${mailboxId}/${folder.id}?${qs.toString()}`);
        const cur = parseMailboxSidebar(html.$, html.url).folders.find((f) => f.current);
        if (cur && cur.id !== folder.id) {
          throw new FreeScoutError(`FreeScout showed folder ${cur.id} instead of ${folder.id} in mailbox ${mailboxId}`);
        }
        const tableEl = html.$("table.table-conversations").first();
        if (tableEl.length && tableEl.attr("data-sorting_order") !== "asc") entry.sorted_oldest_first = false;
        const table = parseConversationTable(html.$, html.url, type);
        entry.pages = page;
        for (const row of table.conversations) {
          result.counts.rows_read++;
          const age = parseWaitingAge(row.last_activity?.relative, now);
          // Oldest first means each row is no older than the previous one. Bounds overlap for equal labels, so only a
          // row that is certainly older (its lower bound above the previous upper bound) proves the order is wrong.
          if (age) {
            if (prevAge && age.min > prevAge.max) {
              entry.sorted_oldest_first = false;
              outOfOrder.add(entry);
            }
            prevAge = age;
          }
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          if (row.status !== "active") {
            result.counts.not_active++;
            continue;
          }
          if (row.last_activity?.by?.toLowerCase() !== "customer") {
            if (row.last_activity?.by) result.counts.last_reply_by_user++;
            else result.counts.unreadable_age++;
            continue;
          }
          if (!age) {
            result.counts.unreadable_age++;
            continue;
          }
          const out: WaitingRow = {
            ...row,
            mailbox_id: mailboxId,
            folder: type,
            waiting_hours: round(age.min),
            waiting_hours_max: round(age.max),
          };
          if (age.min >= threshold) result.conversations.push(out);
          else if (age.max > threshold) result.borderline.push(out);
        }
        entry.more_pages = table.has_next_page;
        if (!table.has_next_page) break;
        // Oldest first: once the last (newest) row of a page is newer than the threshold, later pages are too.
        const lastRow = table.conversations[table.conversations.length - 1];
        const lastAge = lastRow ? parseWaitingAge(lastRow.last_activity?.relative, now) : null;
        if (entry.sorted_oldest_first && lastAge && lastAge.max <= threshold) {
          entry.more_pages = false;
          break;
        }
      }
    }
  }
  const byAge = (a: WaitingRow, b: WaitingRow) => (b.waiting_hours ?? 0) - (a.waiting_hours ?? 0);
  result.conversations.sort(byAge);
  result.borderline.sort(byAge);
  result.counts.waiting = result.conversations.length;
  result.counts.borderline = result.borderline.length;
  result.requests_made = requests;
  result.truncated = truncated || result.folders_read.some((f) => f.more_pages);
  const extra: string[] = [];
  if (result.truncated) extra.push(`Not every page was read (max_pages ${maxPages}, at most ${WAITING_MAX_REQUESTS} requests): more waiting conversations may exist.`);
  if (result.folders_read.some((f) => !f.sorted_oldest_first && !outOfOrder.has(f))) {
    extra.push("FreeScout did not apply the oldest-first sorting on some folder, so capped pages may miss the longest waits.");
  }
  if (outOfOrder.size) {
    extra.push(
      "Rows on some folder were not in oldest-first order, so paging did not stop early there and capped pages may " +
        "miss the longest waits.",
    );
  }
  if (result.counts.unreadable_age > 0) extra.push(WAITING_UNREADABLE_NOTE(result.counts.unreadable_age));
  if (result.mailboxes_skipped.length) {
    extra.push(
      `Skipped mailbox(es) ${result.mailboxes_skipped.map((m) => m.mailbox_id).join(", ")} (see mailboxes_skipped): ` +
        "conversations there are not included.",
    );
  }
  if (extra.length) result.note = `${WAITING_NOTE} ${extra.join(" ")}`;
  return result;
}

const round = (h: number) => Math.round(h * 10) / 10;
