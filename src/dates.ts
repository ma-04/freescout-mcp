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
