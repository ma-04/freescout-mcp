/**
 * Strict calendar dates (YYYY-MM-DD) for search filters. FreeScout parses filter dates with strtotime and turns
 * anything it cannot parse into 1970-01-01 without saying so (docs/freescout-endpoints.md §10.1), so nothing but a
 * real calendar date in this exact form (year 1970 or later) is ever sent. All arithmetic is in UTC so the host timezone cannot shift a day.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** FreeScout's own fallback for an unparsable date is 1970-01-01; nothing earlier is a meaningful filter date. */
export const MIN_YEAR = 1970;

/** Parse a strict YYYY-MM-DD real calendar date (year >= 1970) to a UTC midnight Date, or null. */
export function parseStrictDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y, mo - 1, d); // Date.UTC alone maps years 0-99 to 1900-1999
  // Round-trip: Date.UTC rolls 2026-02-30 over to March 2, so compare the parts.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function isStrictDate(s: unknown): s is string {
  return parseStrictDate(s) !== null;
}

/** Throws a clear error (before any request is made) unless `value` is a strict real date. */
export function requireDate(name: string, value: unknown): Date {
  const d = parseStrictDate(value);
  if (!d) {
    throw new Error(
      `${name} must be a real calendar date in YYYY-MM-DD form, year 1970 or later (got ${JSON.stringify(value)}). ` +
        `Nothing was sent: FreeScout would silently treat an unparsable date as 1970-01-01.`,
    );
  }
  return d;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Inclusive number of days from..to (both UTC midnights). */
export function daySpan(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

export const BUCKET_PERIODS = ["day", "week", "month"] as const;
export type BucketPeriod = (typeof BUCKET_PERIODS)[number];
/** monday = ISO weeks (Monday-Sunday); sunday = Sunday-Saturday weeks (FreeScout's own week chart). */
export const WEEK_STARTS = ["monday", "sunday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface DateBucket {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
}

/**
 * Inclusive buckets covering from..to: days; weeks starting on `weekStart` (default Monday, ISO); calendar months.
 * The first and last bucket are clipped to from/to. With `max`, throws as soon as there would be more than `max`
 * buckets (so a huge range is refused without building it); callers check this before any request.
 */
export function dateBuckets(from: Date, to: Date, period: BucketPeriod, weekStart: WeekStart = "monday", max?: number): DateBucket[] {
  if (from.getTime() > to.getTime()) throw new Error(`from (${formatDate(from)}) must not be later than to (${formatDate(to)})`);
  if (!(BUCKET_PERIODS as readonly string[]).includes(period)) throw new Error(`period must be one of ${BUCKET_PERIODS.join("|")}`);
  if (!(WEEK_STARTS as readonly string[]).includes(weekStart)) throw new Error(`week_start must be one of ${WEEK_STARTS.join("|")}`);
  const firstDow = weekStart === "monday" ? 1 : 0;
  const out: DateBucket[] = [];
  let cur = from;
  while (cur.getTime() <= to.getTime()) {
    let last: Date;
    if (period === "day") last = cur;
    else if (period === "week") last = addDays(cur, 6 - ((cur.getUTCDay() - firstDow + 7) % 7)); // last day of cur's week
    else last = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)); // last day of cur's month
    if (last.getTime() > to.getTime()) last = to;
    out.push({ start: formatDate(cur), end: formatDate(last) });
    if (max !== undefined && out.length > max) {
      throw new Error(
        `${formatDate(from)}..${formatDate(to)} by ${period} is more than ${max} buckets. Nothing was requested: use a ` +
          "coarser period or a shorter range.",
      );
    }
    cur = addDays(last, 1);
  }
  return out;
}

/**
 * Sum a per-day series (index 0 = `from`) into the given buckets (which must lie inside the series' range). A bucket
 * whose days include a null point, or reach outside the series, is null (no data), never a partial sum or 0.
 */
export function sumIntoBuckets(series: ReadonlyArray<number | null>, from: Date, buckets: readonly DateBucket[]): Array<number | null> {
  return buckets.map((b) => {
    const i = daySpan(from, parseStrictDate(b.start)!) - 1;
    const j = daySpan(from, parseStrictDate(b.end)!) - 1;
    if (i < 0 || j >= series.length || i > j) return null;
    let sum = 0;
    for (let k = i; k <= j; k++) {
      const v = series[k];
      if (v === null || v === undefined) return null;
      sum += v;
    }
    // Chart points can be decimals; keep the sum free of binary float noise (0.1 + 0.2).
    return Math.round(sum * 1e6) / 1e6;
  });
}
