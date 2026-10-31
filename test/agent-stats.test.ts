/**
 * agent_stats (Phase C item 1): validation and the bucket cap before any request, one page GET, one guarded
 * productivity report request per bucket (serial, paced, day chart keys), totals and per-user totals, nulls never
 * summed as 0, a mid-run failure, the unavailable shape, and the exact wire bodies through the real Session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { AuthError, FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import { agentStats, MAX_AGENT_STATS_BUCKETS, type AgentStats } from "../src/reports.js";
import { Session } from "../src/session.js";
import { FakeFreeScout } from "./fake-freescout.js";

const raw = (n: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${n}`, import.meta.url)), "utf8");
const PAGE = raw("reports-productivity-page.html");
const ALL = JSON.parse(raw("reports-productivity-ajax.json")) as { report: string };
const USER = JSON.parse(raw("reports-productivity-ajax-user.json")) as { report: string };
const ok = (report: string) => ({ status: "success", msg: "", report, chart: {} });

/** Stub port: the productivity page, then `answers[i]` for the i-th POST (Error = throw); records timing and overlap. */
function stub(answers: Array<unknown>, page: { error?: Error } = {}) {
  const gets: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const times: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const port: FreeScoutPort = {
    async getHtml(path: string): Promise<HtmlPage> {
      gets.push(path);
      if (page.error) throw page.error;
      return { $: cheerio.load(PAGE), url: `https://fs.example${path}`, status: 200 };
    },
    async ajaxPost<T>(_path: string, form: Record<string, unknown>): Promise<T> {
      posts.push(form);
      times.push(Date.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const a = answers[Math.min(posts.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
  return { port, gets, posts, times, maxInFlight: () => maxInFlight };
}

const asStats = (r: unknown) => {
  if (!(r as AgentStats).available) throw new Error("unavailable");
  return r as AgentStats;
};

describe("agent_stats: validation before any request", () => {
  it("more than 31 buckets, bad dates, from > to, bad ids, unknown period/week_start: nothing is requested", async () => {
    expect(MAX_AGENT_STATS_BUCKETS).toBe(31);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ from: "2026-10-01", to: "2026-11-01" }, /more than 31 buckets\. Nothing was requested/],
      [{ from: "2024-01-01", to: "2026-10-31", period: "month" }, /more than 31 buckets/],
      [{ from: "2026-02-30", to: "2026-03-01" }, /real calendar date/],
      [{ from: "2026-10-02", to: "2026-10-01" }, /must not be later/],
      [{ from: "2026-10-01", to: "2026-10-02", user_id: 0 }, /user_id must be a positive integer/],
      [{ from: "2026-10-01", to: "2026-10-02", period: "year" }, /period must be/],
      [{ from: "2026-10-01", to: "2026-10-02", period: "week", week_start: "friday" }, /week_start must be/],
      [{ from: "2026-10-01", to: "2026-10-02", type: "fax" }, /type must be/],
    ];
    for (const [input, re] of cases) {
      const s = stub([ok(ALL.report)]);
      await expect(agentStats(s.port, input as never, { delayMs: 0 }), JSON.stringify(input)).rejects.toThrow(re);
      expect(s.gets).toEqual([]);
      expect(s.posts).toEqual([]);
    }
  });

  it("exactly 31 day buckets is allowed (31 report requests, one page GET)", async () => {
    const s = stub([ok(ALL.report)]);
    const r = asStats(await agentStats(s.port, { from: "2026-10-01", to: "2026-10-31" }, { delayMs: 0 }));
    expect(r.buckets).toHaveLength(31);
    expect(s.gets).toEqual(["/reports/productivity"]);
    expect(s.posts).toHaveLength(31);
    expect(r.requests_made).toBe(31);
  });
});

describe("agent_stats: one guarded report per bucket", () => {
  it("weeks: each bucket's form is the productivity form for exactly that bucket (day chart keys), serial and paced", async () => {
    const s = stub([ok(ALL.report)]);
    const r = asStats(await agentStats(s.port, { from: "2026-10-01", to: "2026-10-31", period: "week", mailbox_id: 15, user_id: 50 }, { delayMs: 30 }));
    expect(r.buckets.map((b) => [b.start, b.end])).toEqual([
      ["2026-10-01", "2026-10-04"], ["2026-10-05", "2026-10-11"], ["2026-10-12", "2026-10-18"], ["2026-10-19", "2026-10-25"], ["2026-10-26", "2026-10-31"],
    ]);
    expect(s.posts.map((f) => [f["filters[from]"], f["filters[to]"]])).toEqual(r.buckets.map((b) => [b.start, b.end]));
    for (const f of s.posts) {
      expect(Object.keys(f)).toEqual(["action", "report_name", "filters[type]", "filters[mailbox]", "filters[user]", "filters[tag]", "filters[period]", "filters[from]", "filters[to]", "chart[group_by]", "chart[type]"]);
      expect(f).toMatchObject({ action: "report", report_name: "productivity", "chart[group_by]": "d", "chart[type]": "customers_helped", "filters[mailbox]": "15", "filters[user]": "50", "filters[period]": "custom" });
    }
    expect(s.maxInFlight()).toBe(1);
    for (let i = 1; i < s.times.length; i++) expect(s.times[i]! - s.times[i - 1]!).toBeGreaterThanOrEqual(28);
    expect(r.filters).toEqual({ from: "2026-10-01", to: "2026-10-31", period: "week", week_start: "monday", mailbox_id: 15, user_id: 50 });
  });

  it("sunday weeks and months", async () => {
    const sun = asStats(await agentStats(stub([ok(ALL.report)]).port, { from: "2026-10-01", to: "2026-10-31", period: "week", week_start: "sunday" }, { delayMs: 0 }));
    expect(sun.buckets.map((b) => b.end)).toEqual(["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"]);
    const mon = asStats(await agentStats(stub([ok(ALL.report)]).port, { from: "2026-09-15", to: "2026-11-02", period: "month" }, { delayMs: 0 }));
    expect(mon.buckets.map((b) => [b.start, b.end])).toEqual([["2026-09-15", "2026-09-30"], ["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-11-02"]]);
    expect(mon.filters).not.toHaveProperty("week_start");
  });

  it("per bucket: metrics and the users table; totals of the additive metrics; per-user totals", async () => {
    // Bucket 1: all users (86/214/8/364/14; users 50 and 49). Bucket 2: one user (user 50 only).
    const s = stub([ok(ALL.report), ok(USER.report)]);
    const r = asStats(await agentStats(s.port, { from: "2026-10-27", to: "2026-10-28" }, { delayMs: 0 }));
    expect(r.buckets[0]!.metrics.map((m) => m.key)).toEqual(["customers_helped", "replies_sent", "replies_per_day", "closed", "resolved_on_first_reply"]);
    expect(r.buckets[0]!.users!.map((u) => u.user_id)).toEqual([50, 49]);
    const v = (i: number, k: string) => r.buckets[i]!.metrics.find((m) => m.key === k)!.value!;
    // customers_helped is a distinct-customer count: per bucket only, never summed.
    expect(r.totals).toEqual({
      replies_sent: v(0, "replies_sent") + v(1, "replies_sent"),
      closed: v(0, "closed") + v(1, "closed"),
      resolved_on_first_reply: v(0, "resolved_on_first_reply") + v(1, "resolved_on_first_reply"),
    });
    expect(r.totals).not.toHaveProperty("replies_per_day");
    expect(r.totals).not.toHaveProperty("customers_helped");
    expect(r.buckets[0]!.metrics.find((m) => m.key === "customers_helped")!.value).toBe(86);
    expect(r.user_totals).toEqual([
      { user_id: 50, name: "User 50", replies_sent: 170 + 34, closed: 288 + 36, buckets: 2 },
      { user_id: 49, name: "User 49", replies_sent: 44, closed: 77, buckets: 1 },
    ]);
    expect(r.buckets[1]!.users[0]!.customers_helped).toBe(20); // still per bucket
    expect(r.note).toMatch(/customers_helped, replies_per_day and satisfaction\s+scores are per bucket only/);
    expect(r.note).toMatch(/once per\s+bucket/);
    expect(r.note).toMatch(/overlaps from by one day/);
    expect(r.content_notice).toMatch(/display strings/);
    expect(r).not.toHaveProperty("incomplete");
  });

  it("a non-numeric metric or users cell makes the total null (never 0) with a note", async () => {
    const odd = ALL.report.replace(/(Closed[\s\S]*?rpt-metric-value">\s*)364/, "$1n/a");
    expect(odd).not.toBe(ALL.report);
    const r = asStats(await agentStats(stub([ok(ALL.report), ok(odd)]).port, { from: "2026-10-27", to: "2026-10-28" }, { delayMs: 0 }));
    expect(r.buckets[1]!.metrics.find((m) => m.key === "closed")).toMatchObject({ value: null, raw_value: "n/a" });
    expect(r.totals!.closed).toBeNull();
    expect(r.totals!.replies_sent).toBe(428);
    expect(r.note).toMatch(/Some totals are null/);
  });

  it("a failure mid-run returns the finished buckets with incomplete: true, null totals and a redacted error", async () => {
    const s = stub([ok(ALL.report), ok(ALL.report), new FreeScoutError("FreeScout returned HTTP 502")]);
    const r = asStats(await agentStats(s.port, { from: "2026-10-01", to: "2026-10-05" }, { delayMs: 0 }));
    expect(r.incomplete).toBe(true);
    expect(r.buckets.map((b) => b.start)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(r.requests_made).toBe(3);
    expect(s.posts).toHaveLength(3);
    expect(r.error).toMatch(/502/);
    // A partial sum is not the range's total: totals and user_totals are null; the buckets keep their data.
    expect(r.totals).toBeNull();
    expect(r.user_totals).toBeNull();
    expect(r.buckets[1]!.metrics.find((m) => m.key === "replies_sent")!.value).toBe(214);
    expect(r.buckets[1]!.users).toHaveLength(2);
    expect(r.note).toMatch(/INCOMPLETE: report request 3 of 5 failed/);
    expect(r.note).toMatch(/totals and user_totals are null/);
  });

  it("the first request failing: no buckets and null totals (never zeros), incomplete", async () => {
    const r = asStats(await agentStats(stub([new FreeScoutError("FreeScout returned HTTP 502")]).port, { from: "2026-10-01", to: "2026-10-03" }, { delayMs: 0 }));
    expect(r).toMatchObject({ incomplete: true, buckets: [], totals: null, user_totals: null, requests_made: 1 });
    expect(r.note).toMatch(/INCOMPLETE: report request 1 of 3 failed/);
  });

  it("a dead session or a report permission refusal mid-run is a tool error, not an incomplete success", async () => {
    const dead = stub([ok(ALL.report), new AuthError("logged_out")]);
    await expect(agentStats(dead.port, { from: "2026-10-01", to: "2026-10-05" }, { delayMs: 0 })).rejects.toThrow(AuthError);
    expect(dead.posts).toHaveLength(2);
    const refused = stub([ok(ALL.report), new PermissionError("FreeScout returned HTTP 403")]);
    // fetchReport rewords the 403 into a FreeScoutError with status 403; still thrown.
    await expect(agentStats(refused.port, { from: "2026-10-01", to: "2026-10-05" }, { delayMs: 0 })).rejects.toThrow(/HTTP 403/);
    expect(refused.posts).toHaveLength(2);
  });

  it("a bucket whose report has no users table has users: [] (never null), with a note", async () => {
    const noUsers = ALL.report.replace(/<table[^>]*>(?:(?!<\/table>)[\s\S])*rpt-user-btn[\s\S]*?<\/table>/, "");
    expect(noUsers).not.toContain("rpt-user-btn");
    const r = asStats(await agentStats(stub([ok(ALL.report), ok(noUsers)]).port, { from: "2026-10-30", to: "2026-10-31" }, { delayMs: 0 }));
    expect(r.buckets[0]!.users).toHaveLength(2);
    expect(r.buckets[1]!.users).toEqual([]);
    expect(r.user_totals!.map((u) => u.buckets)).toEqual([1, 1]);
    expect(r.note).toMatch(/no users table .*their users is \[\]/);
  });

  it("module missing: the report tools' available:false shape, no POST", async () => {
    const s = stub([ok(ALL.report)], { error: new FreeScoutError("FreeScout page not found: /reports/productivity", 404) });
    const r = await agentStats(s.port, { from: "2026-10-01", to: "2026-10-07", period: "week" }, { delayMs: 0 });
    expect(r).toMatchObject({ available: false, report: "productivity", reason: "module_not_installed" });
    expect(r.note).toMatch(/ticket_volume/);
    expect(s.posts).toEqual([]);
  });
});

describe("agent_stats through the real Session against the fake FreeScout", () => {
  let fs: FakeFreeScout | undefined;
  afterEach(async () => {
    await fs?.stop();
    fs = undefined;
  });

  it("one page GET, then one productivity request per bucket (day chart keys) with the page's CSRF token", async () => {
    fs = new FakeFreeScout();
    await fs.start();
    fs.reports = {};
    const client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
    const r = asStats(await agentStats(client, { from: "2026-10-30", to: "2026-11-01", mailbox_id: 15 }, { delayMs: 0 }));
    expect(fs.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/productivity", "POST /reports/ajax", "POST /reports/ajax", "POST /reports/ajax"]);
    const bodies = fs.reportPosts.map((p) => p.filter(([k]) => k !== "_token"));
    expect(bodies).toEqual(
      ["2026-10-30", "2026-10-31", "2026-11-01"].map((d) => [
        ...new URLSearchParams(`action=report&report_name=productivity&filters[type]=&filters[mailbox]=15&filters[tag]=&filters[period]=custom&filters[from]=${d}&filters[to]=${d}&chart[group_by]=d&chart[type]=customers_helped`).entries(),
      ]),
    );
    for (const p of fs.reportPosts) expect(p.find(([k]) => k === "_token")?.[1]).toBeTruthy();
    expect(r.requests_made).toBe(3);
    expect(r.totals!.replies_sent).toBe(3 * 214);
  });

  it("module not installed on the fake: available:false, no POST", async () => {
    fs = new FakeFreeScout();
    await fs.start();
    const client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
    expect(await agentStats(client, { from: "2026-10-01", to: "2026-10-02" }, { delayMs: 0 })).toMatchObject({ available: false, reason: "module_not_installed" });
    expect(fs.reportPosts).toEqual([]);
  });
});
