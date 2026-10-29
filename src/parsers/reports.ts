/**
 * Parsers for FreeScout's Reports module (docs/freescout-endpoints.md §11): the `report` HTML fragment returned by
 * `POST /reports/ajax` (§11.4) and the page's `form#rpt-filters` (§11.5). Everything locale-dependent (labels, titles,
 * dates) is passed through as display strings; numbers are parsed only when the text is a plain number.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { squish } from "./text.js";

export type ChangeDirection = "up" | "down" | "flat" | null;

export interface ReportMetric {
  key: string;
  title: string;
  /** Parsed from raw_value when it is a plain number (digits, optional "." decimals); otherwise null. */
  value: number | null;
  raw_value: string;
  /** Signed percent from the change span ("+24%" -> 24, "-65%" -> -65); null when absent or not a plain percent. */
  change_percent: number | null;
  /** From the sign of the change text (not from its colour class). */
  change_direction: ChangeDirection;
  raw_change: string | null;
  /** The metric's tooltip text, when the module renders one. */
  description: string | null;
}

export interface DistributionBucket {
  /** Display label, entities decoded ("< 15 min", "> 2 days", "1"). */
  label: string;
  percent: number | null;
  raw_percent: string;
  change_percent: number | null;
  raw_change: string | null;
}

export interface Distribution {
  title: string;
  buckets: DistributionBucket[];
  /** The `Avg.` row, verbatim ("3 h 27 min", "1.33"); null when the row is absent. */
  average: string | null;
}

export interface ReportUserRow {
  user_id: number | null;
  name: string;
  replies_sent: number | null;
  closed: number | null;
  customers_helped: number | null;
  satisfaction_score: number | null;
  /** Verbatim cell text of the recognised columns, present only when at least one of them is not a plain number. */
  raw_values?: Partial<Record<UserColumn, string>>;
  /** Columns whose header was not recognised (another UI language, a new column), verbatim, keyed by header slug. */
  extra_columns?: Record<string, string>;
}

type UserColumn = "replies_sent" | "closed" | "customers_helped" | "satisfaction_score";

export type Rating = "great" | "okay" | "not_good";

export interface RatingRow {
  conversation_id: number | null;
  number: number | null;
  /** Display string in the account's locale, e.g. "Oct 11, 2026 10:04pm" (timezone not stated by FreeScout). */
  rated_at: string | null;
  user_id: number | null;
  user_name: string | null;
  rating: Rating | null;
  /** Customer-written (untrusted). */
  customer: { id: number | null; name: string } | null;
  /** Customer-written (untrusted); null when empty. */
  comment: string | null;
}

export interface ParsedReport {
  metrics: ReportMetric[];
  /** Tables with a `% | Δ` header, keyed by slug of their title (first_response_time, response_time, ...). */
  distributions: Record<string, Distribution>;
  users: ReportUserRow[] | null;
  ratings: RatingRow[] | null;
  /** From the fragment's own chart options (productivity only): `select#rpt-chart-type` and `#rpt-group-by`. */
  chart_options: { selected_type: string | null; group_bys: string[]; active_group_by: string | null } | null;
}

/** "Customers Helped" -> "customers_helped"; falls back to `fallback` for titles without ASCII letters/digits. */
export function slug(title: string, fallback: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

/** A plain number only: "86", "1.33", "-3". Anything else (thousands separators, units, locale commas) -> null. */
export function plainNumber(raw: string | null | undefined): number | null {
  const t = (raw ?? "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** "+24%" / "-65%" / "0%" / "33%" -> number; anything else -> null. */
export function percent(raw: string | null | undefined): number | null {
  const m = /^([+-]?)(\d+(?:\.\d+)?)\s*%$/.exec((raw ?? "").trim());
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]);
}

function direction(raw: string | null): ChangeDirection {
  const p = percent(raw);
  if (p === null) return null;
  if (p === 0) return "flat";
  return p > 0 ? "up" : "down";
}

/** Text of the element's own text nodes only (not its children), squished. */
function ownText($: CheerioAPI, el: cheerio.Cheerio<AnyNode>): string {
  return squish(
    el
      .contents()
      .filter((_, n) => n.type === "text")
      .map((_, n) => $(n).text())
      .get()
      .join(" "),
  );
}

function idFromHref(href: string | undefined, re: RegExp): number | null {
  const m = re.exec(href ?? "");
  return m ? Number(m[1]) : null;
}

function posInt(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  return /^[1-9]\d*$/.test(t) ? Number(t) : null;
}

function parseMetrics($: CheerioAPI): ReportMetric[] {
  const out: ReportMetric[] = [];
  $(".rpt-metrics .rpt-metric").each((i, el) => {
    const m = $(el);
    const titleEl = m.find(".rpt-metric-title").first();
    const title = ownText($, titleEl);
    const tip = titleEl.find("i").first();
    const description = squish(tip.attr("title") || tip.attr("data-original-title") || "") || null;
    const valueEl = m.find(".rpt-metric-value").first();
    const raw_value = ownText($, valueEl);
    const changeText = squish(valueEl.find(".rpt-metric-change").first().text()) || null;
    out.push({
      key: slug(title, `metric_${i + 1}`),
      title,
      value: plainNumber(raw_value),
      raw_value,
      change_percent: percent(changeText),
      change_direction: direction(changeText),
      raw_change: changeText,
      description,
    });
  });
  return out;
}

function headers($: CheerioAPI, table: cheerio.Cheerio<AnyNode>): string[] {
  return table
    .find("tr")
    .first()
    .find("th")
    .map((_, th) => squish($(th).text()))
    .get();
}

function dataRows($: CheerioAPI, table: cheerio.Cheerio<AnyNode>) {
  return table.find("tr").filter((_, tr) => $(tr).find("td").length > 0);
}

function parseDistribution($: CheerioAPI, table: cheerio.Cheerio<AnyNode>, title: string): Distribution {
  const buckets: DistributionBucket[] = [];
  let average: string | null = null;
  dataRows($, table).each((_, tr) => {
    const tds = $(tr).find("td");
    // The average row: <td><i>Avg.</i></td><td colspan="2"><i>…</i></td>
    if (tds.length === 2 && tds.eq(1).attr("colspan")) {
      average = squish(tds.eq(1).text()) || null;
      return;
    }
    const raw_percent = squish(tds.eq(1).text());
    const raw_change = squish(tds.eq(2).text()) || null;
    buckets.push({ label: squish(tds.eq(0).text()), percent: percent(raw_percent), raw_percent, change_percent: percent(raw_change), raw_change });
  });
  return { title, buckets, average };
}

const USER_COLUMNS: Record<string, UserColumn> = {
  replies_sent: "replies_sent",
  closed: "closed",
  customers_helped: "customers_helped",
  satisfaction_score: "satisfaction_score",
};

function parseUsers($: CheerioAPI, table: cheerio.Cheerio<AnyNode>, head: string[]): ReportUserRow[] {
  // Columns by header match only (English install: User | Replies Sent | Closed | Customers Helped | Satisfaction
  // Score). A header that is not recognised (another UI language, a new column) is never guessed by position: its
  // cells are kept verbatim under extra_columns, keyed by the header slug.
  const cols = head.slice(1).map((h, i) => {
    const known = USER_COLUMNS[slug(h, "")];
    return known ? { known } : { extra: slug(h, `column_${i + 2}`) };
  });
  const seenExtra = new Set<string>();
  for (const c of cols) {
    if (c.extra === undefined) continue;
    while (seenExtra.has(c.extra)) c.extra += "_";
    seenExtra.add(c.extra);
  }
  const out: ReportUserRow[] = [];
  dataRows($, table).each((_, tr) => {
    const tds = $(tr).find("td");
    const btn = tds.eq(0).find("button.rpt-user-btn").first();
    const row: ReportUserRow = {
      user_id: posInt(btn.attr("data-uid")),
      name: squish((btn.length ? btn : tds.eq(0)).text()),
      replies_sent: null,
      closed: null,
      customers_helped: null,
      satisfaction_score: null,
    };
    const rawValues: Partial<Record<UserColumn, string>> = {};
    let unparsed = false;
    const extra: Record<string, string> = {};
    cols.forEach((c, i) => {
      const text = squish(tds.eq(i + 1).text());
      if (c.known) {
        row[c.known] = plainNumber(text);
        rawValues[c.known] = text;
        if (row[c.known] === null) unparsed = true;
      } else if (c.extra !== undefined) extra[c.extra] = text;
    });
    if (unparsed) row.raw_values = rawValues;
    if (Object.keys(extra).length) row.extra_columns = extra;
    out.push(row);
  });
  return out;
}

const RATING_BY_CLASS: Array<[string, Rating]> = [
  ["text-success", "great"],
  ["text-help", "okay"],
  ["text-danger", "not_good"],
];
const RATING_BY_TEXT: Record<string, Rating> = { great: "great", okay: "okay", not_good: "not_good" };

function parseRatings($: CheerioAPI, table: cheerio.Cheerio<AnyNode>): RatingRow[] {
  const out: RatingRow[] = [];
  dataRows($, table).each((_, tr) => {
    const tds = $(tr).find("td");
    const conv = tds.eq(0).find('a[href*="/conversation/"]').first();
    const cust = tds.eq(1).find("a").first();
    const btn = tds.eq(2).find("button.rpt-user-btn").first();
    const span = tds.eq(3).find("span").first();
    let rating: Rating | null = RATING_BY_TEXT[slug(squish(span.text()), "")] ?? null;
    if (!rating) for (const [cls, r] of RATING_BY_CLASS) if (span.hasClass(cls)) rating = r;
    // Name from the link, or from the cell text when there is no link (e.g. a deleted customer: id null).
    const custName = squish((cust.length ? cust : tds.eq(1)).text());
    out.push({
      conversation_id: idFromHref(conv.attr("href"), /\/conversation\/(\d+)/),
      number: plainNumber(squish(conv.text()).replace(/^#/, "")),
      rated_at: squish(tds.eq(0).find("small").first().text()) || null,
      user_id: posInt(btn.attr("data-uid")),
      user_name: squish(btn.text()) || null,
      rating,
      customer: cust.length || custName ? { id: idFromHref(cust.attr("href"), /\/customers\/(\d+)/), name: custName } : null,
      comment: squish(tds.eq(4).text()) || null,
    });
  });
  return out;
}

/** Parse the `report` HTML fragment of a `POST /reports/ajax` answer (§11.4). */
export function parseReportHtml(html: string): ParsedReport {
  const $ = cheerio.load(`<div id="rpt-root">${html}</div>`);
  const distributions: Record<string, Distribution> = {};
  let users: ReportUserRow[] | null = null;
  let ratings: RatingRow[] | null = null;
  $("#rpt-tables table").each((i, el) => {
    const table = $(el);
    const head = headers($, table);
    if (head.length === 3 && head[1] === "%") {
      const title = head[0] ?? "";
      let key = slug(title, `table_${i + 1}`);
      while (key in distributions) key += "_";
      distributions[key] = parseDistribution($, table, title);
    } else if (head[0] === "#" || table.find('a[href*="/conversation/"]').length) {
      ratings = parseRatings($, table);
    } else if (table.find("button.rpt-user-btn").length || slug(head[0] ?? "", "") === "user") {
      users = parseUsers($, table, head);
    }
  });
  const typeSel = $("select#rpt-chart-type");
  const groupBy = $("#rpt-group-by");
  const chart_options =
    typeSel.length || groupBy.length
      ? {
          selected_type: typeSel.find("option[selected]").first().attr("value") ?? null,
          group_bys: groupBy.find("button[value]").map((_, b) => $(b).attr("value") ?? "").get().filter(Boolean),
          active_group_by: groupBy.find("button.active[value]").first().attr("value") ?? null,
        }
      : null;
  return { metrics: parseMetrics($), distributions, users, ratings, chart_options };
}

export interface ReportFilterOption {
  id: number;
  name: string;
}

export interface ReportFilterForm {
  current_user_id: number | null;
  /** `select[name=user]` options with a positive id; `disabled` is ignored (client-side only, §11.5). */
  users: Array<ReportFilterOption & { mailbox_ids: number[] }>;
  mailboxes: ReportFilterOption[];
  types: ReportFilterOption[];
  tags_count: number;
  tags: ReportFilterOption[];
}

function options($: CheerioAPI, form: cheerio.Cheerio<AnyNode>, name: string): Array<{ el: cheerio.Cheerio<AnyNode>; id: number }> {
  const out: Array<{ el: cheerio.Cheerio<AnyNode>; id: number }> = [];
  form.find(`select[name="${name}"] option`).each((_, o) => {
    const id = posInt($(o).attr("value"));
    if (id !== null) out.push({ el: $(o), id });
  });
  return out;
}

/** True when the page has the Reports filter form (§11.5). */
export function hasReportForm($: CheerioAPI): boolean {
  return $("form#rpt-filters").length > 0;
}

/** The `form#rpt-filters` selects of a report page (§11.5). */
export function parseReportFilterForm($: CheerioAPI): ReportFilterForm {
  const form = $("form#rpt-filters").first();
  const named = (name: string) => options($, form, name).map((o) => ({ id: o.id, name: squish(o.el.text()) }));
  const tags = named("tag");
  return {
    current_user_id: posInt($("body").attr("data-auth_user_id")),
    users: options($, form, "user").map((o) => ({
      id: o.id,
      name: squish(o.el.text()),
      mailbox_ids: (o.el.attr("data-mailboxes") ?? "")
        .split(",")
        .map((s) => posInt(s))
        .filter((n): n is number => n !== null),
    })),
    mailboxes: named("mailbox"),
    types: named("type"),
    tags_count: tags.length,
    tags,
  };
}
