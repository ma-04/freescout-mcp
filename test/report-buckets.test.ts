/**
 * Calendar bucketing for agent_stats and the productivity_report week/month periods (src/dates.ts): ISO and Sunday
 * weeks across month and year boundaries, months, clipping to from..to, the bucket cap, and summing a day series.
 */
import { describe, expect, it } from "vitest";
import { dateBuckets, daySpan, parseStrictDate, sumIntoBuckets, type BucketPeriod, type WeekStart } from "../src/dates.js";

const d = (s: string) => parseStrictDate(s)!;
const pairs = (from: string, to: string, period: BucketPeriod, weekStart?: WeekStart) =>
  dateBuckets(d(from), d(to), period, weekStart).map((b) => `${b.start}..${b.end}`);

/** Live productivity day series, replies, 2026-10-01..31 (sum 437 = Replies Sent). Oct 3 2026 is a Saturday. */
const OCT_REPLIES = [9, 4, 9, 11, 9, 10, 23, 10, 16, 5, 13, 22, 24, 47, 17, 6, 1, 9, 18, 45, 8, 20, 1, 7, 2, 13, 1, 52, 15, 10, 0];

describe("dateBuckets", () => {
  it("days, inclusive", () => {
    expect(pairs("2026-10-30", "2026-11-01", "day")).toEqual(["2026-10-30..2026-10-30", "2026-10-31..2026-10-31", "2026-11-01..2026-11-01"]);
    expect(pairs("2026-10-30", "2026-10-30", "day")).toEqual(["2026-10-30..2026-10-30"]);
  });

  it("ISO weeks (Monday-Sunday), clipped to from/to; October 2026", () => {
    expect(pairs("2026-10-01", "2026-10-31", "week")).toEqual([
      "2026-10-01..2026-10-04", "2026-10-05..2026-10-11", "2026-10-12..2026-10-18", "2026-10-19..2026-10-25", "2026-10-26..2026-10-31",
    ]);
  });

  it("Sunday weeks end on Saturdays: FreeScout's own week labels Oct 3, 10, 17, 24, 31", () => {
    const b = dateBuckets(d("2026-10-01"), d("2026-10-31"), "week", "sunday");
    expect(b.map((x) => x.end)).toEqual(["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"]);
    expect(b[0]!.start).toBe("2026-10-01");
    expect(b[1]!.start).toBe("2026-10-04");
    for (const x of b.slice(1)) expect(d(x.start).getUTCDay()).toBe(0);
  });

  it("weeks across a month and a year boundary (ISO week 53 of 2026 runs Dec 28 - Jan 3)", () => {
    expect(pairs("2026-12-24", "2027-01-12", "week")).toEqual(["2026-12-24..2026-12-27", "2026-12-28..2027-01-03", "2027-01-04..2027-01-10", "2027-01-11..2027-01-12"]);
    expect(pairs("2026-12-24", "2027-01-12", "week", "sunday")).toEqual(["2026-12-24..2026-12-26", "2026-12-27..2027-01-02", "2027-01-03..2027-01-09", "2027-01-10..2027-01-12"]);
    // A range starting on the week's first day and ending on its last is one bucket.
    expect(pairs("2026-11-02", "2026-11-08", "week")).toEqual(["2026-11-02..2026-11-08"]);
    expect(pairs("2026-11-01", "2026-11-07", "week", "sunday")).toEqual(["2026-11-01..2026-11-07"]);
  });

  it("calendar months, clipped, across a leap February and a year boundary", () => {
    expect(pairs("2027-12-15", "2028-03-10", "month")).toEqual(["2027-12-15..2027-12-31", "2028-01-01..2028-01-31", "2028-02-01..2028-02-29", "2028-03-01..2028-03-10"]);
    expect(pairs("2026-02-01", "2026-02-28", "month")).toEqual(["2026-02-01..2026-02-28"]);
  });

  it("the cap: more than max buckets throws; exactly max is fine", () => {
    expect(dateBuckets(d("2026-10-01"), d("2026-10-31"), "day", "monday", 31)).toHaveLength(31);
    expect(() => dateBuckets(d("2026-10-01"), d("2026-11-01"), "day", "monday", 31)).toThrow(/more than 31 buckets\. Nothing was requested/);
    expect(() => dateBuckets(d("2020-01-01"), d("2026-12-31"), "month", "monday", 31)).toThrow(/more than 31 buckets/);
  });

  it("refuses from > to, an unknown period and an unknown week_start", () => {
    expect(() => dateBuckets(d("2026-10-02"), d("2026-10-01"), "day")).toThrow(/must not be later/);
    expect(() => dateBuckets(d("2026-10-01"), d("2026-10-02"), "year" as never)).toThrow(/period must be/);
    expect(() => dateBuckets(d("2026-10-01"), d("2026-10-02"), "week", "saturday" as never)).toThrow(/week_start must be/);
  });
});

describe("sumIntoBuckets", () => {
  const from = d("2026-10-01");
  it("live October replies: Monday and Sunday weeks both total 437; the month is 437", () => {
    expect(daySpan(from, d("2026-10-31"))).toBe(OCT_REPLIES.length);
    const mon = sumIntoBuckets(OCT_REPLIES, from, dateBuckets(from, d("2026-10-31"), "week"));
    const sun = sumIntoBuckets(OCT_REPLIES, from, dateBuckets(from, d("2026-10-31"), "week", "sunday"));
    expect(mon).toEqual([33, 86, 126, 101, 91]);
    expect(sun).toEqual([22, 84, 130, 108, 93]);
    for (const s of [mon, sun]) expect(s.reduce((a, b) => a! + b!, 0)).toBe(437);
    expect(sumIntoBuckets(OCT_REPLIES, from, dateBuckets(from, d("2026-10-31"), "month"))).toEqual([437]);
  });

  it("a null point makes its bucket null (never a partial sum); buckets outside the series are null", () => {
    const s = [1, 2, null, 4, 5, 6, 7, 8];
    const b = dateBuckets(d("2026-10-01"), d("2026-10-08"), "week"); // Oct 1-4, Oct 5-8
    expect(sumIntoBuckets(s, d("2026-10-01"), b)).toEqual([null, 26]);
    expect(sumIntoBuckets([1, 2], d("2026-10-01"), [{ start: "2026-10-02", end: "2026-10-03" }])).toEqual([null]);
    expect(sumIntoBuckets([1, 2], d("2026-10-01"), [{ start: "2026-09-30", end: "2026-10-01" }])).toEqual([null]);
  });

  it("decimals are summed without float noise", () => {
    expect(sumIntoBuckets([0.1, 0.2], d("2026-10-01"), [{ start: "2026-10-01", end: "2026-10-02" }])).toEqual([0.3]);
  });
});
