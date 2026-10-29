/**
 * Search-derived statistics (docs/freescout-endpoints.md §10). Every number here is the tfoot total of one filtered
 * `GET /search` (page 1 only). FreeScout's search filters `after`/`before` on conversations.created_at in the app
 * timezone, so these are counts of conversations CREATED in a period, grouped by their CURRENT status / assignee /
 * mailbox, published conversations only (f[state][]=2). Requests run one after another, paced (DEFAULT_STATS_DELAY_MS /
 * FREESCOUT_STATS_DELAY_MS) and capped, because every /search also runs FreeScout's customer search; the session
 * layer takes the re-issued cookie from each response.
 */
import type { FreeScoutPort } from "./client.js";
import { DEFAULT_STATS_DELAY_MS } from "./config.js";
import { addDays, formatDate, requireDate } from "./dates.js";
import { FreeScoutError } from "./errors.js";
import { redact } from "./log.js";
import {
  MAILBOX_IGNORED_NOTE,
  MAILBOX_UNVERIFIED_NOTE,
  SEARCH_STATUSES,
  assertSearchPage,
  assignedFilterForced,
  assignedForcedNote,
  buildSearchParams,
  listMailboxes,
  mailboxFilterIgnored,
  type AssignedArg,
  type SearchOptions,
  type SearchState,
} from "./operations.js";
import { parseConversationTable } from "./parsers/conversation-table.js";
import { parseSearchFilters, type FilterOption } from "./parsers/search-filters.js";

export const PERIODS = ["day", "week", "month"] as const;
export const BREAKDOWNS = ["none", "status", "assignee", "mailbox"] as const;
export type Period = (typeof PERIODS)[number];
export type Breakdown = (typeof BREAKDOWNS)[number];

export const MAX_BUCKETS = 31;
export const MAX_BREAKDOWN_VALUES = 10;
/**
 * Every GET /search also runs FreeScout's customer search (`searchCustomers`, `LIKE '%%'` over the customers table
 * when q is empty, §10), so each request costs a full customer count on the server. Calls are capped and paced.
 */
export const MAX_REQUESTS = 64;
export { DEFAULT_STATS_DELAY_MS };

export interface Bucket {
  start: string;
  end: string;
}

/**
 * Inclusive buckets covering from..to: days; ISO weeks (Monday-Sunday); calendar months. The first and last bucket
 * are clipped to from/to. Throws (before any request) on bad dates, from > to, or more than MAX_BUCKETS buckets.
 */
export function makeBuckets(from: string, to: string, period: Period): Bucket[] {
  const start = requireDate("from", from);
  const end = requireDate("to", to);
  if (start.getTime() > end.getTime()) throw new Error(`from (${from}) must not be later than to (${to})`);
  if (!PERIODS.includes(period)) throw new Error(`period must be one of ${PERIODS.join("|")}`);
  const buckets: Bucket[] = [];
  let cur = start;
  while (cur.getTime() <= end.getTime()) {
    let last: Date;
    if (period === "day") last = cur;
    else if (period === "week") last = addDays(cur, 6 - ((cur.getUTCDay() + 6) % 7)); // Sunday of cur's ISO week
    else last = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)); // last day of cur's month
    if (last.getTime() > end.getTime()) last = end;
    buckets.push({ start: formatDate(cur), end: formatDate(last) });
    if (buckets.length > MAX_BUCKETS) {
      throw new Error(
        `${from}..${to} by ${period} is more than ${MAX_BUCKETS} buckets. Nothing was requested: use a coarser period ` +
          `(week or month) or a shorter range.`,
      );
    }
    cur = addDays(last, 1);
  }
  return buckets;
}

export interface TicketVolumeInput {
  from: string;
  to: string;
  period?: Period;
  breakdown?: Breakdown;
  mailbox_id?: number;
  assigned?: AssignedArg;
}

export interface TicketVolumeOptions {
  /** Pause between consecutive requests in ms (default DEFAULT_STATS_DELAY_MS; 0 = none). */
  delayMs?: number;
}

export interface VolumeBucket extends Bucket {
  total: number;
  by?: Record<string, number>;
  /** Assignee breakdown only: the per-assignee counts add up to more than the total, so "other" is omitted. */
  inconsistent?: true;
  note?: string;
}

export interface TicketVolume {
  from: string;
  to: string;
  period: Period;
  breakdown: Breakdown;
  /** Filters sent with every request; state is always ["published"] (deleted and draft conversations excluded). */
  filters: { mailbox_id?: number; assigned?: AssignedArg; state: SearchState[] };
  /** What each `by` key means (assignee and mailbox keys are ids). */
  breakdown_values?: Array<{ key: string; label: string }>;
  buckets: VolumeBucket[];
  totals: { total: number; by?: Record<string, number> };
  requests_made: number;
  /** true: FreeScout dropped mailbox_id; null: could not verify (no mailbox dropdown on the page). */
  mailbox_filter_ignored?: boolean | null;
  /** The assigned filter FreeScout applied when it differs from the requested one (accounts limited to their own conversations). */
  assigned_filter_forced?: AssignedArg;
  /** Set when a request failed mid-run: buckets holds only the buckets finished before the failure. */
  incomplete?: true;
  error?: string;
  note: string;
}

export const VOLUME_NOTE =
  "Counts published conversations (deleted and draft excluded) CREATED in each period (created_at, server timezone, " +
  "usually UTC), broken down by their CURRENT status/assignee/mailbox. It is not resolved/closed per day and has no " +
  "response or resolution times and no satisfaction ratings. Only mailboxes this account can view are counted.";

const INCONSISTENT_NOTE =
  "The per-assignee counts add up to more than the bucket total (FreeScout probably forced the assigned filter), " +
  "so \"other\" is not computed for this bucket.";

interface Value {
  key: string;
  label: string;
  filter: SearchOptions;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Conversations created per period, from one filtered search per bucket and breakdown value, run serially. */
export async function ticketVolume(port: FreeScoutPort, input: TicketVolumeInput, options: TicketVolumeOptions = {}): Promise<TicketVolume> {
  const period = input.period ?? "day";
  const breakdown = input.breakdown ?? "none";
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? DEFAULT_STATS_DELAY_MS));
  if (!BREAKDOWNS.includes(breakdown)) throw new Error(`breakdown must be one of ${BREAKDOWNS.join("|")}`);
  const buckets = makeBuckets(input.from, input.to, period);
  if (breakdown === "mailbox" && input.mailbox_id !== undefined) {
    throw new Error("mailbox_id cannot be combined with breakdown=mailbox; drop one of them.");
  }
  if (breakdown === "assignee" && input.assigned !== undefined) {
    throw new Error("assigned cannot be combined with breakdown=assignee; drop one of them.");
  }
  const filters: TicketVolume["filters"] = { state: ["published"] };
  if (input.mailbox_id !== undefined) filters.mailbox_id = input.mailbox_id;
  if (input.assigned !== undefined) filters.assigned = input.assigned;
  // Validates mailbox_id/assigned before any request (the date pair is a stand-in filter).
  buildSearchParams({ ...filters, after: input.from, before: input.to });

  let requests = 0;
  // Mutated inside count(); an object so TypeScript does not narrow the fields to their initial values.
  const seen: { mailboxIgnored: boolean | null; forced: AssignedArg | null } = { mailboxIgnored: false, forced: null };
  // Read-only view of the port: counts and paces GETs, and there is no way to POST from here.
  const counted: FreeScoutPort = {
    getHtml: async (path) => {
      if (requests > 0 && delayMs > 0) await sleep(delayMs);
      requests++;
      return port.getHtml(path);
    },
    ajaxPost: () => Promise.reject(new Error("ticket_volume never posts")),
  };
  const count = async (b: Bucket, extra: SearchOptions): Promise<{ total: number; assignees: FilterOption[] | null }> => {
    const opts: SearchOptions = { ...filters, ...extra, after: b.start, before: b.end };
    const { params } = buildSearchParams(opts);
    const page = await counted.getHtml(`/search?${params.toString()}`);
    if (/\/conversation\/\d+/.test(new URL(page.url).pathname)) {
      throw new FreeScoutError("FreeScout redirected a filtered search to a conversation (unexpected).");
    }
    assertSearchPage(page);
    const ignored = mailboxFilterIgnored(page, opts.mailbox_id);
    if (ignored === true) seen.mailboxIgnored = true;
    else if (ignored === null && seen.mailboxIgnored === false) seen.mailboxIgnored = null;
    const f = assignedFilterForced(page, opts.assigned);
    if (f !== null) seen.forced = f;
    const table = parseConversationTable(page.$, page.url, null);
    let total = table.total;
    if (total === null) {
      if (table.has_next_page) throw new FreeScoutError("Search results have no total (unexpected FreeScout markup).");
      total = table.conversations.length;
    }
    return { total, assignees: parseSearchFilters(page.$).assignees };
  };
  const formula =
    breakdown === "assignee"
      ? "buckets x (values + 1) must be <= " + MAX_REQUESTS
      : breakdown === "none"
        ? "buckets must be <= " + MAX_REQUESTS
        : "buckets x values must be <= " + MAX_REQUESTS;
  const capError = (perBucket: number, planned: number) =>
    new Error(
      `${buckets.length} ${period} bucket(s) x ${perBucket} request(s) each is ${planned} requests, over the cap of ` +
        `${MAX_REQUESTS} per call (${formula}). Nothing more was requested: use a coarser period or a shorter range, ` +
        "or drop the breakdown and filter by one assignee (assigned=<id>) or one mailbox (mailbox_id).",
    );
  const valueCapError = (what: string, n: number, hint: string) =>
    new Error(`breakdown=${what} would need ${n} values, over the cap of ${MAX_BREAKDOWN_VALUES}. ${hint}`);

  let values: Value[] = [];
  /** Assignee breakdown: one extra unfiltered request per bucket, so conversations of unlisted users show as "other". */
  let withTotal = false;
  const firstTotal: { value?: number } = {};
  if (breakdown === "none") {
    withTotal = true;
  } else if (breakdown === "status") {
    values = SEARCH_STATUSES.map((s) => ({ key: s, label: s, filter: { status: [s] } }));
  } else if (breakdown === "assignee") {
    withTotal = true;
    if (buckets.length * 2 > MAX_REQUESTS) throw capError(2, buckets.length * 2);
    // The first bucket's total request doubles as discovery: its page carries the f[assigned] dropdown.
    const first = await count(buckets[0]!, {});
    firstTotal.value = first.total;
    if (first.assignees === null) throw new FreeScoutError("The search page has no assignee filter (unexpected FreeScout markup).");
    values = [
      ...first.assignees.map((u) => ({ key: String(u.id), label: u.name, filter: { assigned: u.id } as SearchOptions })),
      { key: "unassigned", label: "Unassigned", filter: { assigned: "unassigned" } },
    ];
    if (values.length > MAX_BREAKDOWN_VALUES) {
      throw valueCapError("assignee", values.length, "Filter by one user with assigned=<id> (see list_assignees) instead.");
    }
  } else {
    const boxes = await listMailboxes(counted, false);
    values = boxes.map((m) => ({ key: String(m.id), label: m.name, filter: { mailbox_id: m.id } }));
    if (values.length > MAX_BREAKDOWN_VALUES) {
      throw valueCapError("mailbox", values.length, "Run it per mailbox with mailbox_id instead.");
    }
    if (values.length === 0) throw new FreeScoutError("No mailboxes are visible to this account.");
  }
  const perBucket = values.length + (withTotal ? 1 : 0);
  const planned = requests + buckets.length * perBucket - (firstTotal.value !== undefined ? 1 : 0);
  if (planned > MAX_REQUESTS) throw capError(perBucket, planned);

  const out: VolumeBucket[] = [];
  let failure: unknown;
  try {
    for (const [i, b] of buckets.entries()) {
      // Serial on purpose (no Promise.all): each response re-issues the session cookie.
      let total: number | undefined;
      if (withTotal) total = i === 0 && firstTotal.value !== undefined ? firstTotal.value : (await count(b, {})).total;
      if (breakdown === "none") {
        out.push({ ...b, total: total! });
        continue;
      }
      const by: Record<string, number> = {};
      for (const v of values) by[v.key] = (await count(b, v.filter)).total;
      const sum = Object.values(by).reduce((a, n) => a + n, 0);
      if (breakdown === "assignee") {
        if (sum > total!) {
          out.push({ ...b, total: total!, by, inconsistent: true, note: INCONSISTENT_NOTE });
          continue;
        }
        by.other = total! - sum;
      }
      out.push({ ...b, total: total ?? sum, by });
    }
  } catch (e) {
    failure = e;
  }

  const totals: TicketVolume["totals"] = { total: out.reduce((a, b) => a + b.total, 0) };
  if (breakdown !== "none") {
    const keys = [...values.map((v) => v.key), ...(breakdown === "assignee" ? ["other"] : [])];
    totals.by = Object.fromEntries(keys.map((k) => [k, out.reduce((a, b) => a + (b.by?.[k] ?? 0), 0)]));
  }
  const notes: string[] = [];
  const result: TicketVolume = {
    from: input.from,
    to: input.to,
    period,
    breakdown,
    filters,
    ...(breakdown !== "none"
      ? { breakdown_values: [...values.map((v) => ({ key: v.key, label: v.label })), ...(breakdown === "assignee" ? [{ key: "other", label: "Other users" }] : [])] }
      : {}),
    buckets: out,
    totals,
    requests_made: requests,
    note: "",
  };
  if (failure !== undefined) {
    const e = failure instanceof Error ? failure : new Error(String(failure));
    result.incomplete = true;
    result.error = `${e.name}: ${redact(e.message)}`;
    notes.push(
      `INCOMPLETE: a request failed after ${requests} of ${planned} planned requests; buckets lists only the ` +
        `${out.length} of ${buckets.length} bucket(s) finished before the failure, and totals cover only those. Do not ` +
        "retry the same call blindly (it repeats every request): tell the user, or ask for just the missing range.",
    );
  }
  if (seen.mailboxIgnored === true) {
    result.mailbox_filter_ignored = true;
    notes.push(MAILBOX_IGNORED_NOTE);
  } else if (seen.mailboxIgnored === null) {
    result.mailbox_filter_ignored = null;
    notes.push(MAILBOX_UNVERIFIED_NOTE);
  }
  if (seen.forced !== null) {
    result.assigned_filter_forced = seen.forced;
    notes.push(assignedForcedNote(seen.forced));
  }
  if (out.some((b) => b.inconsistent)) {
    notes.push('Some buckets are marked inconsistent; their "other" is omitted and totals.by.other covers only the consistent buckets.');
  }
  notes.push(VOLUME_NOTE);
  if (breakdown === "assignee") {
    notes.push('"other" = conversations assigned to users missing from this account\'s assignee list (e.g. admins).');
  }
  result.note = notes.join(" ");
  return result;
}
