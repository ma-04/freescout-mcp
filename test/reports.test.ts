/**
 * Reports module (docs/freescout-endpoints.md §11): parsers against every scrubbed fixture, the assertReportForm guard,
 * the exact wire body against §11.2, availability classification, date validation / cap before any request and chart
 * mismatch detection, through the real Session against the fake FreeScout. There is no live test: the demo has no
 * Reports module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { AuthError, FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import { parseReportFilterForm, parseReportHtml } from "../src/parsers/reports.js";
import {
  assertReportForm,
  buildReportForm,
  listReportUsers,
  openReportPage,
  productivityReport,
  reportWire,
  satisfactionReport,
  type ReportForm,
} from "../src/reports.js";
import { Session } from "../src/session.js";
import { registerTools } from "../src/tools/index.js";
import { FakeFreeScout } from "./fake-freescout.js";

const raw = (n: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${n}`, import.meta.url)), "utf8");
const ajax = (n: string) => JSON.parse(raw(n)) as { status: string; msg: string; report: string; chart: Record<string, unknown> };
const ALL = ajax("reports-productivity-ajax.json");
const USER = ajax("reports-productivity-ajax-user.json");
const MONTH = ajax("reports-productivity-ajax-by-month.json");
const SAT = ajax("reports-satisfaction-ajax.json");

describe("report HTML parser on the fixtures", () => {
  it("productivity metrics: keys from titles, values, signed changes, tooltips", () => {
    const p = parseReportHtml(ALL.report);
    expect(p.metrics.map((m) => m.key)).toEqual(["customers_helped", "replies_sent", "replies_per_day", "closed", "resolved_on_first_reply"]);
    expect(p.metrics.map((m) => [m.value, m.raw_value, m.change_percent, m.change_direction])).toEqual([
      [86, "86", -47, "down"],
      [214, "214", 2, "up"],
      [8, "8", -13, "down"],
      [364, "364", -12, "down"],
      [14, "14", 14, "up"],
    ]);
    expect(p.metrics[0]).toMatchObject({ title: "Customers Helped", raw_change: "-47%", description: "Number of customers who received replies from support agents." });
  });

  it("time tables: buckets with decoded </> labels, Δ, and the Avg. row; four tables on the all-users fixture", () => {
    const d = parseReportHtml(ALL.report).distributions;
    expect(Object.keys(d)).toEqual(["first_response_time", "response_time", "resolution_time", "replies_to_resolve"]);
    expect(d.first_response_time!.buckets[0]).toEqual({ label: "< 15 min", percent: 1, raw_percent: "1%", change_percent: -300, raw_change: "-300%" });
    expect(d.first_response_time!.buckets.at(-1)).toMatchObject({ label: "> 2 days", percent: 4, change_percent: 50 });
    expect(d.first_response_time!.buckets).toHaveLength(10);
    expect(d.first_response_time!.average).toBe("8 h 32 min");
    expect(d.response_time!.average).toBe("8 h 55 min");
    expect(d.resolution_time!.average).toBe("11 h 23 min");
    expect(d.replies_to_resolve).toMatchObject({ title: "Replies To Resolve", average: "1.33" });
    expect(d.replies_to_resolve!.buckets.map((b) => [b.label, b.percent])).toEqual([["1", 78], ["2", 17], ["4", 6]]);
  });

  it("one-user fixture: two time tables, 0% change is flat, a single users row", () => {
    const p = parseReportHtml(USER.report);
    expect(Object.keys(p.distributions)).toEqual(["first_response_time", "response_time"]);
    expect(p.distributions.first_response_time!.average).toBe("3 h 27 min");
    expect(p.distributions.response_time!.average).toBe("4 h 31 min");
    expect(p.distributions.response_time!.buckets.find((b) => b.label === "30-60 min")).toMatchObject({ change_percent: 0, raw_change: "0%" });
    expect(p.metrics[1]).toMatchObject({ key: "replies_sent", value: 34, change_percent: -144, change_direction: "down" });
    expect(p.users).toEqual([{ user_id: 50, name: "User 50", replies_sent: 34, closed: 36, customers_helped: 20, satisfaction_score: 0 }]);
    expect(p.chart_options).toMatchObject({ selected_type: "customers_helped", group_bys: ["d"], active_group_by: "d" });
    expect(p.chart_options!.types.map((t) => t.value)).toEqual(["customers_helped", "replies", "closed"]);
  });

  it("users table ids, names and numbers; chart options of the month fixture", () => {
    expect(parseReportHtml(ALL.report).users).toEqual([
      { user_id: 50, name: "User 50", replies_sent: 170, closed: 288, customers_helped: 61, satisfaction_score: 0 },
      { user_id: 49, name: "User 49", replies_sent: 44, closed: 77, customers_helped: 34, satisfaction_score: 0 },
    ]);
    const m = parseReportHtml(MONTH.report);
    expect(m.users).toEqual([{ user_id: 50, name: "User 50", replies_sent: 1391, closed: 1556, customers_helped: 304, satisfaction_score: 0 }]);
    expect(m.chart_options).toMatchObject({ selected_type: "replies", group_bys: ["d", "w", "m"], active_group_by: "m" });
    expect(m.metrics.map((x) => x.value)).toEqual([304, 1391, 6, 1556, 163]);
  });

  it("satisfaction: metrics and rated rows (customer, comment, rating from the span)", () => {
    const p = parseReportHtml(SAT.report);
    expect(p.metrics.map((m) => [m.key, m.value, m.change_percent, m.change_direction, m.description])).toEqual([
      ["ratings", 2, 50, "up", null],
      ["great", 1, 0, "flat", null],
      ["okay", 0, 0, "flat", null],
      ["not_good", 1, 100, "up", null],
      ["satisfaction_score", 0, 0, "flat", null],
    ]);
    expect(p.users).toBeNull();
    expect(p.chart_options).toBeNull();
    expect(p.ratings).toEqual([
      { conversation_id: 1001, number: 1001, rated_at: "Oct 11, 2026 10:04pm", user_id: 50, user_name: "User 50", rating: "not_good", customer: { id: 201, name: "Customer 201" }, comment: "Comment text" },
      { conversation_id: 1002, number: 1002, rated_at: "Oct 9, 2026 03:38pm", user_id: 49, user_name: "User 49", rating: "great", customer: { id: 202, name: "Customer 202" }, comment: "Comment text" },
    ]);
  });

  it("non-plain numbers keep raw_value and parse to null (thousands separators / locale unverified)", () => {
    const html = `<div class="rpt-metrics"><div class="rpt-metric"><div class="rpt-metric-title">Closed</div><div class="rpt-metric-value">1,234<span class="rpt-metric-change text-help">n/a</span></div></div></div>`;
    expect(parseReportHtml(html).metrics[0]).toMatchObject({ value: null, raw_value: "1,234", change_percent: null, change_direction: null, raw_change: "n/a" });
  });

  it("page form#rpt-filters: users with mailbox ids (disabled ignored), mailboxes, types, tags, current user", () => {
    const f = parseReportFilterForm(cheerio.load(raw("reports-productivity-page.html")));
    expect(f.current_user_id).toBe(50);
    expect(f.mailboxes).toEqual([{ id: 18, name: "Mailbox 18" }, { id: 15, name: "Mailbox 15" }, { id: 21, name: "Mailbox 21" }]);
    expect(f.types).toEqual([{ id: 1, name: "Email" }, { id: 3, name: "Chat" }, { id: 2, name: "Phone" }]);
    expect(f.tags_count).toBe(3);
    expect(f.users).toHaveLength(25);
    expect(f.users[0]).toEqual({ id: 34, name: "User 34", mailbox_ids: [15] });
    expect(f.users.find((u) => u.id === 57)).toEqual({ id: 57, name: "User 57", mailbox_ids: [21] }); // disabled in the browser
    expect(f.users.find((u) => u.id === 50)!.mailbox_ids).toEqual([18, 15, 21]);
  });
});

const okForm = (): ReportForm => ({
  action: "report",
  report_name: "productivity",
  filters: { type: "", mailbox: "15", tag: "", period: "custom", from: "2026-10-01", to: "2026-10-28" },
  chart: { group_by: "d", type: "replies" },
});

describe("assertReportForm", () => {
  it("accepts the §11.2 shapes", () => {
    expect(() => assertReportForm(okForm())).not.toThrow();
    const { chart: _c, ...noChart } = okForm();
    expect(() => assertReportForm(noChart)).not.toThrow();
    expect(() => assertReportForm({ ...noChart, report_name: "satisfaction" })).not.toThrow();
    expect(() => assertReportForm({ ...okForm(), filters: { ...okForm().filters, user: "50" } })).not.toThrow();
  });

  it("refuses other actions, names, extra keys, bad values, chart on satisfaction, and bad ranges", () => {
    const f = okForm();
    const bad: unknown[] = [
      null, "x", [], { ...f, action: "delete" }, { ...f, action: "export" }, { ...f, report_name: "conversations" },
      { ...f, report_name: "time-tracking" }, { ...f, report_name: "satisfaction" }, { ...f, extra: "1" }, { ...f, _token: "t" },
      { ...f, filters: { ...f.filters, period: "last_7" } }, { ...f, filters: { ...f.filters, user: "" } },
      { ...f, filters: { ...f.filters, user: "0" } }, { ...f, filters: { ...f.filters, user: 50 } },
      { ...f, filters: { ...f.filters, mailbox: "1,2" } }, { ...f, filters: { ...f.filters, mailbox: ["15"] } },
      { ...f, filters: { ...f.filters, type: "4" } }, { ...f, filters: { ...f.filters, tag: "-1" } },
      { ...f, filters: { ...f.filters, status: "3" } }, { ...f, filters: { ...f.filters, from: "2026-02-30" } },
      { ...f, filters: { ...f.filters, from: "10/01/2026" } }, { ...f, filters: { ...f.filters, from: "2026-10-29" } },
      { ...f, filters: { ...f.filters, from: "2025-10-27", to: "2026-10-28" } }, // 367 days
      { ...f, chart: { group_by: "y", type: "replies" } }, { ...f, chart: { group_by: "d", type: "export" } },
      { ...f, chart: { group_by: "d", type: "replies", extra: "1" } }, { ...f, chart: "d" },
      { action: "report", report_name: "productivity" },
    ];
    for (const b of bad) expect(() => assertReportForm(b), JSON.stringify(b)).toThrow(FreeScoutError);
    expect(() => assertReportForm({ ...f, filters: { ...f.filters, from: "2025-10-28", to: "2026-10-28" } })).not.toThrow(); // 366 days
  });

  it("wire pairs follow rptRefresh() order; filters[user] only when requested; satisfaction has no chart keys", () => {
    expect(Object.entries(reportWire(buildReportForm("productivity", { from: "2026-10-21", to: "2026-10-30", mailbox_id: 15, user_id: 50, chart_metric: "replies" })))).toEqual([
      ["action", "report"], ["report_name", "productivity"], ["filters[type]", ""], ["filters[mailbox]", "15"], ["filters[user]", "50"],
      ["filters[tag]", ""], ["filters[period]", "custom"], ["filters[from]", "2026-10-21"], ["filters[to]", "2026-10-30"],
      ["chart[group_by]", "d"], ["chart[type]", "replies"],
    ]);
    const sat = reportWire(buildReportForm("satisfaction", { from: "2026-10-01", to: "2026-10-28", mailbox_id: 15 }));
    expect(new URLSearchParams(sat).toString()).toBe(
      new URLSearchParams("action=report&report_name=satisfaction&filters[type]=&filters[mailbox]=15&filters[tag]=&filters[period]=custom&filters[from]=2026-10-01&filters[to]=2026-10-28").toString(),
    );
    expect(() => buildReportForm("satisfaction", { from: "2026-10-01", to: "2026-10-28", group_by: "week" })).toThrow(/productivity-only/);
  });

  it("I1: chart keys are always sent for productivity (day series), even for the default metric", () => {
    expect(buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28" }).chart).toEqual({ group_by: "d", type: "customers_helped" });
    expect(buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28", chart_metric: "customers_helped", group_by: "day" }).chart).toEqual({ group_by: "d", type: "customers_helped" });
    // week/month are summed client-side from the DAY series; w/m are never sent, and the day series is asked for explicitly.
    expect(buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28", group_by: "month" }).chart).toEqual({ group_by: "d", type: "customers_helped" });
    expect(buildReportForm("productivity", { from: "2025-11-01", to: "2026-10-31", group_by: "month" }).chart).toEqual({ group_by: "d", type: "customers_helped" });
    expect(buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28", group_by: "week", chart_metric: "replies" }).chart).toEqual({ group_by: "d", type: "replies" });
    expect(() => assertReportForm({ ...okForm(), chart: { group_by: "w", type: "replies" } })).toThrow(/only the day series/);
    expect(() => assertReportForm({ ...okForm(), chart: { group_by: "m", type: "replies" } })).toThrow(FreeScoutError);
    expect(() => buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28", group_by: "week", week_start: "friday" as never })).toThrow(/week_start/);
    expect(() => buildReportForm("satisfaction", { from: "2026-10-01", to: "2026-10-28", week_start: "sunday" })).toThrow(/productivity-only/);
    expect(buildReportForm("productivity", { from: "2026-10-01", to: "2026-10-28", chart_metric: "closed" }).chart).toEqual({ group_by: "d", type: "closed" });
  });

  it("I5: null-prototype objects, class instances and symbol keys are refused", () => {
    const nullProto = Object.assign(Object.create(null) as object, okForm());
    expect(() => assertReportForm(nullProto)).toThrow(/not a plain object/);
    const filtersNull = { ...okForm(), filters: Object.assign(Object.create(null) as object, okForm().filters) };
    expect(() => assertReportForm(filtersNull)).toThrow(/filters is not a plain object/);
    expect(() => assertReportForm({ ...okForm(), [Symbol("x")]: "1" })).toThrow(/not a plain object/);
    expect(() => assertReportForm({ ...okForm(), chart: { group_by: "d", type: "replies", [Symbol("x")]: 1 } })).toThrow(/chart is not a plain object/);
    class Form { action = "report"; }
    expect(() => assertReportForm(Object.assign(new Form(), okForm()))).toThrow(/not a plain object/);
  });

  it("I6: years before 1970 are refused by the guard and the builder", () => {
    expect(() => assertReportForm({ ...okForm(), filters: { ...okForm().filters, from: "0000-01-01" } })).toThrow(FreeScoutError);
    expect(() => buildReportForm("productivity", { from: "1969-12-31", to: "1970-01-02" })).toThrow(/1970 or later.*Nothing was sent/);
    expect(() => buildReportForm("productivity", { from: "1970-01-01", to: "1970-01-02" })).not.toThrow();
  });
});

/** Stub port: serves one page (or throws) and records POSTs. */
function stub(page: { html?: string; url?: string; error?: Error; base?: string; postError?: Error }, answer: unknown = ALL) {
  const gets: string[] = [];
  const posts: Array<{ path: string; form: Record<string, unknown> }> = [];
  const port: FreeScoutPort = {
    ...(page.base ? { baseUrl: new URL(page.base) } : {}),
    async getHtml(path: string): Promise<HtmlPage> {
      gets.push(path);
      if (page.error) throw page.error;
      return { $: cheerio.load(page.html ?? ""), url: page.url ?? `https://fs.example${path}`, status: 200 };
    },
    async ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
      posts.push({ path, form });
      if (page.postError) throw page.postError;
      return answer as T;
    },
  };
  return { port, gets, posts };
}

describe("availability classification (stub port)", () => {
  const PAGE = raw("reports-productivity-page.html");
  const cases: Array<[string, Parameters<typeof stub>[0], string]> = [
    ["404", { error: new FreeScoutError("FreeScout page not found: /reports/productivity", 404) }, "module_not_installed"],
    ["403", { error: new PermissionError("FreeScout denied access to /reports/productivity (HTTP 403)") }, "not_available_to_this_account"],
    ["redirect to dashboard", { html: PAGE, url: "https://fs.example/" }, "not_available_to_this_account"],
    ["login page", { html: `<form action="https://fs.example/login" method="POST"><input name="email"><input name="password"></form>`, url: "https://fs.example/reports/productivity" }, "not_available_to_this_account"],
    ["200 without form", { html: "<p>Reports</p>", url: "https://fs.example/reports/productivity" }, "not_available_to_this_account"],
  ];
  for (const [what, page, reason] of cases) {
    it(`${what} -> ${reason}, no POST`, async () => {
      const { port, posts } = stub(page);
      const r = await productivityReport(port, { from: "2026-10-01", to: "2026-10-28" });
      expect(r).toMatchObject({ available: false, reason });
      expect(String(r.note)).toMatch(/ticket_volume/);
      expect(r).not.toHaveProperty("metrics");
      expect(posts).toEqual([]);
    });
  }

  it("a page for another report is not available; a sub-path install is fine", async () => {
    const { port } = stub({ html: PAGE, url: "https://fs.example/reports/satisfaction" });
    expect(await openReportPage(port, "satisfaction")).toMatchObject({ available: false, reason: "not_available_to_this_account" });
    const sub = stub({ html: PAGE, url: "https://fs.example/helpdesk/reports/productivity/", base: "https://fs.example/helpdesk/" });
    expect(await openReportPage(sub.port, "productivity")).toHaveProperty("$");
  });

  it("L6: the final path must be exactly <base path>/reports/<name>", async () => {
    // A satisfaction page redirected to /reports/productivity (no POST, with the observed path in detail).
    const sat = stub({ html: PAGE, url: "https://fs.example/reports/productivity" });
    const r = await satisfactionReport(sat.port, { from: "2026-10-01", to: "2026-10-28" });
    expect(r).toMatchObject({ available: false, reason: "not_available_to_this_account", detail: "/reports/satisfaction redirected to /reports/productivity" });
    expect(sat.posts).toEqual([]);
    // A sub-path install redirected to the root /reports/productivity is not its report page.
    const root = stub({ html: PAGE, url: "https://fs.example/reports/productivity", base: "https://fs.example/helpdesk/" });
    expect(await openReportPage(root.port, "productivity")).toMatchObject({ available: false, detail: "/reports/productivity redirected to /reports/productivity" });
    // Without a sub-path, a prefixed path is not accepted either.
    const prefixed = stub({ html: PAGE, url: "https://fs.example/x/reports/productivity" });
    expect(await openReportPage(prefixed.port, "productivity")).toMatchObject({ available: false, reason: "not_available_to_this_account" });
  });

  it("L5: a satisfaction 404 names the Satisfaction Ratings module too", async () => {
    const { port } = stub({ error: new FreeScoutError("FreeScout page not found: /reports/satisfaction", 404) });
    const r = await satisfactionReport(port, { from: "2026-10-01", to: "2026-10-28" });
    expect(r).toMatchObject({ available: false, reason: "module_not_installed" });
    expect(r.note).toMatch(/Reports module is not installed, or the Satisfaction Ratings module it needs is missing/);
    const p = await productivityReport(stub({ error: new FreeScoutError("not found", 404) }).port, { from: "2026-10-01", to: "2026-10-28" });
    expect(p.note).not.toMatch(/Satisfaction Ratings/);
  });

  it("I3: a 403 on the report POST is a tool error about the Reports permission, not a mailbox", async () => {
    const { port, posts } = stub({ html: PAGE, url: "https://fs.example/reports/productivity", postError: new PermissionError("FreeScout denied /reports/ajax (HTTP 403)") });
    const err = await productivityReport(port, { from: "2026-10-01", to: "2026-10-28" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreeScoutError);
    expect(err).not.toBeInstanceOf(PermissionError);
    expect((err as Error).message).toMatch(/HTTP 403.*Reports module.*not a mailbox/);
    expect(posts).toHaveLength(1);
  });

  it("other errors propagate (never an unavailable result or zeros)", async () => {
    const { port } = stub({ error: new FreeScoutError("returned HTTP 500", 500) });
    await expect(productivityReport(port, { from: "2026-10-01", to: "2026-10-28" })).rejects.toThrow(/500/);
  });

  it("envelope errors and a missing report are tool errors", async () => {
    const page = { html: PAGE, url: "https://fs.example/reports/productivity" };
    await expect(productivityReport(stub(page, { status: "error", msg: "Something broke" }).port, { from: "2026-10-01", to: "2026-10-28" })).rejects.toThrow(/Something broke/);
    await expect(productivityReport(stub(page, { status: "success", msg: "" }).port, { from: "2026-10-01", to: "2026-10-28" })).rejects.toThrow(/no report HTML/);
    await expect(productivityReport(stub(page, { status: "success", report: "<p>?</p>" }).port, { from: "2026-10-01", to: "2026-10-28" })).rejects.toThrow(/no metrics/);
  });
});

describe("reports through the real Session against the fake FreeScout", () => {
  let fs: FakeFreeScout | undefined;
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await close?.();
    await fs?.stop();
    fs = undefined;
    close = undefined;
  });
  async function setup(reports: FakeFreeScout["reports"] | "uninstalled" = {}) {
    fs = new FakeFreeScout();
    await fs.start();
    fs.reports = reports === "uninstalled" ? undefined : reports;
    const client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
    return client;
  }
  const posted = () => fs!.reportPosts.map((p) => p.filter(([k]) => k !== "_token"));
  const decoded = (s: string) => [...new URLSearchParams(s).entries()];

  it("§11.2 item 4 (all users) and the productivity result shape; _token is the page's CSRF token", async () => {
    const client = await setup();
    const r = await productivityReport(client, { from: "2026-10-01", to: "2026-10-28", mailbox_id: 15 });
    expect(fs!.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/productivity", "POST /reports/ajax"]);
    expect(posted()).toEqual([
      // I1: the default chart still sends both chart keys (day series), like the browser body after a chart pick.
      decoded("action=report&report_name=productivity&filters[type]=&filters[mailbox]=15&filters[tag]=&filters[period]=custom&filters[from]=2026-10-01&filters[to]=2026-10-28&chart[group_by]=d&chart[type]=customers_helped"),
    ]);
    expect(fs!.reportPosts[0]!.find(([k]) => k === "_token")?.[1]).toBeTruthy();
    expect(r).toMatchObject({
      available: true,
      report: "productivity",
      filters: { from: "2026-10-01", to: "2026-10-28", period: "custom", mailbox_id: 15, chart_metric: "customers_helped", group_by: "day" },
      first_response_time: { average: "8 h 32 min" },
      response_time: { average: "8 h 55 min" },
      resolution_time: { average: "11 h 23 min" },
      replies_to_resolve: { average: "1.33" },
      chart: { metric: "customers_helped", group_by: "day", available_group_bys: ["day", "week"] },
    });
    if (!r.available) throw new Error("unavailable");
    expect(r.users!.map((u) => u.user_id)).toEqual([50, 49]);
    expect(r.chart!.labels).toHaveLength(28);
    expect(r.chart!.current).toHaveLength(28);
    expect(r.chart!.previous).toHaveLength(28);
    expect(r.chart!.labels[0]).toBe("Oct 1");
    expect(r).not.toHaveProperty("mismatch");
    expect(r.note).toMatch(/previous period/);
    expect(r.note).toMatch(/never\s+requested/);
    expect(r.note).toMatch(/overlaps from by one day/);
    expect(r.chart).not.toHaveProperty("periods");
    expect(r.note).toMatch(/opaque display strings/);
  });

  it("§11.2 items 1/2 (one user): filters[user] present; 10-point chart", async () => {
    const client = await setup();
    const r = await productivityReport(client, { from: "2026-10-21", to: "2026-10-30", mailbox_id: 15, user_id: 50, chart_metric: "replies" });
    expect(posted()[0]).toEqual(
      decoded("action=report&report_name=productivity&filters[type]=&filters[mailbox]=15&filters[user]=50&filters[tag]=&filters[period]=custom&filters[from]=2026-10-21&filters[to]=2026-10-30&chart[group_by]=d&chart[type]=replies"),
    );
    if (!r.available) throw new Error("unavailable");
    expect(r.chart!.labels).toHaveLength(10);
    expect(r.users).toHaveLength(1);
    expect(r.note).not.toMatch(/non-English|no users table/);
    // The fixture answers customers_helped: the requested metric differs.
    expect(r.mismatch).toEqual({
      requested: { metric: "replies", group_by: "day" },
      received: { metric: "customers_helped", group_by: "day", available_group_bys: ["day"] },
    });
    expect(r.note).toMatch(/MISMATCH/);
  });

  it("week on a 10-day range: the day series is requested explicitly and summed into clipped ISO weeks", async () => {
    const client = await setup();
    const r = await productivityReport(client, { from: "2026-10-21", to: "2026-10-30", user_id: 50, group_by: "week" });
    expect(posted()[0]).toEqual(
      decoded("action=report&report_name=productivity&filters[type]=&filters[mailbox]=&filters[user]=50&filters[tag]=&filters[period]=custom&filters[from]=2026-10-21&filters[to]=2026-10-30&chart[group_by]=d&chart[type]=customers_helped"),
    );
    if (!r.available) throw new Error("unavailable");
    expect(r).not.toHaveProperty("mismatch");
    expect(r.filters).toMatchObject({ group_by: "week", week_start: "monday" });
    const c = r.chart!;
    expect(c.week_start).toBe("monday");
    const sum = (a: Array<number | null>) => a.reduce((x, y) => x! + y!, 0);
    expect(c.periods).toEqual([
      { start: "2026-10-21", end: "2026-10-25", value: sum(c.current.slice(0, 5)), previous_start: "2026-10-12", previous_end: "2026-10-16", previous_value: sum(c.previous.slice(0, 5)) },
      { start: "2026-10-26", end: "2026-10-30", value: sum(c.current.slice(5)), previous_start: "2026-10-17", previous_end: "2026-10-21", previous_value: sum(c.previous.slice(5)) },
    ]);
    expect(r.note).toMatch(/chart\.periods are computed by this server/);
  });

  it("a day series whose length does not match the range gives no periods and a warning (never guessed dates)", async () => {
    const client = await setup();
    // The fake answers the 28-day fixture for any productivity request: 28 points for a 365-day range.
    const r = await productivityReport(client, { from: "2025-10-01", to: "2026-09-30", chart_metric: "replies", group_by: "month" });
    expect(fs!.reportPosts[0]!.find(([k]) => k === "chart[group_by]")?.[1]).toBe("d");
    if (!r.available) throw new Error("unavailable");
    expect(r.chart!.periods).toBeNull();
    expect(r.note).toMatch(/WARNING: no month periods: .*exactly 365 points.*got 28 day points/);
  });

  it("live October replies series (fs.reports.answer): Monday and Sunday weeks, months, previous dated from - (N-1)", async () => {
    const OCT = [9, 4, 9, 11, 9, 10, 23, 10, 16, 5, 13, 22, 24, 47, 17, 6, 1, 9, 18, 45, 8, 20, 1, 7, 2, 13, 1, 52, 15, 10, 0];
    const PREV = OCT.map((_, i) => i + 1);
    const answer = {
      status: "success",
      msg: "",
      report: ALL.report,
      chart: { type: "replies", group_bys: ["d", "w"], group_by: "d", labels: OCT.map((_, i) => `Oct ${i + 1}`), datasets: [{ label: "Current", data: OCT }, { label: "Previous", data: PREV }] },
    };
    const client = await setup({ answer });
    const mon = await productivityReport(client, { from: "2026-10-01", to: "2026-10-31", chart_metric: "replies", group_by: "week" });
    const sun = await productivityReport(client, { from: "2026-10-01", to: "2026-10-31", chart_metric: "replies", group_by: "week", week_start: "sunday" });
    const month = await productivityReport(client, { from: "2026-10-01", to: "2026-10-31", chart_metric: "replies", group_by: "month" });
    if (!mon.available || !sun.available || !month.available) throw new Error("unavailable");
    expect(mon.chart!.periods!.map((p) => [p.start, p.end, p.value])).toEqual([
      ["2026-10-01", "2026-10-04", 33], ["2026-10-05", "2026-10-11", 86], ["2026-10-12", "2026-10-18", 126], ["2026-10-19", "2026-10-25", 101], ["2026-10-26", "2026-10-31", 91],
    ]);
    // FreeScout's own week labels end on these Saturdays.
    expect(sun.chart!.periods!.map((p) => [p.end, p.value])).toEqual([["2026-10-03", 22], ["2026-10-10", 84], ["2026-10-17", 130], ["2026-10-24", 108], ["2026-10-31", 93]]);
    expect(month.chart!.periods).toEqual([
      { start: "2026-10-01", end: "2026-10-31", value: 437, previous_start: "2026-09-01", previous_end: "2026-10-01", previous_value: (31 * 32) / 2 },
    ]);
    expect(mon.chart!.periods![0]).toMatchObject({ previous_start: "2026-09-01", previous_end: "2026-09-04", previous_value: 1 + 2 + 3 + 4 });
    for (const r of [mon, sun, month]) expect(r).not.toHaveProperty("mismatch");
    // Every request asked for the day series only.
    for (const p of fs!.reportPosts) expect(p.filter(([k]) => k.startsWith("chart["))).toEqual([["chart[group_by]", "d"], ["chart[type]", "replies"]]);
  });

  it("a null day point makes its period null; a previous series of the wrong length nulls previous_value", async () => {
    const cur = [1, null, 3, 4, 5, 6, 7];
    const answer = { status: "success", msg: "", report: ALL.report, chart: { type: "customers_helped", group_by: "d", labels: cur.map(String), datasets: [{ label: "Current", data: cur }, { label: "Previous", data: [1, 2] }] } };
    const client = await setup({ answer });
    const r = await productivityReport(client, { from: "2026-10-01", to: "2026-10-07", group_by: "week" }); // Oct 1-4, Oct 5-7
    if (!r.available) throw new Error("unavailable");
    expect(r.chart!.periods!.map((p) => [p.value, p.previous_value])).toEqual([[null, null], [18, null]]);
    expect(r.note).toMatch(/previous series has 2 points, not 7/);
  });

  it("a metric-only mismatch (right day series, wrong metric): no periods, and the warning names the metric, not the length", async () => {
    const cur = [1, 2, 3, 4, 5, 6, 7];
    const answer = { status: "success", msg: "", report: ALL.report, chart: { type: "closed", group_by: "d", labels: cur.map(String), datasets: [{ label: "Current", data: cur }, { label: "Previous", data: cur }] } };
    const client = await setup({ answer });
    const r = await productivityReport(client, { from: "2026-10-01", to: "2026-10-07", group_by: "week" });
    if (!r.available) throw new Error("unavailable");
    expect(r.mismatch).toBeDefined();
    expect(r.chart!.periods).toBeNull();
    expect(r.note).toMatch(/WARNING: no week periods: FreeScout returned another chart than the requested one/);
    expect(r.note).not.toMatch(/cannot be dated/);
  });

  it("§11.2 item 5 (satisfaction): no chart keys; comments only on request", async () => {
    const client = await setup();
    const r = await satisfactionReport(client, { from: "2026-10-01", to: "2026-10-28", mailbox_id: 15 });
    expect(fs!.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/satisfaction", "POST /reports/ajax"]);
    expect(posted()[0]).toEqual(
      decoded("action=report&report_name=satisfaction&filters[type]=&filters[mailbox]=15&filters[tag]=&filters[period]=custom&filters[from]=2026-10-01&filters[to]=2026-10-28"),
    );
    if (!r.available) throw new Error("unavailable");
    expect(r.distribution).toEqual({ good_percent: 50, okay_percent: 0, not_good_percent: 50 });
    expect(r.metrics.map((m) => m.key)).toEqual(["ratings", "great", "okay", "not_good", "satisfaction_score"]);
    expect(r.ratings).toEqual([
      { conversation_id: 1001, number: 1001, rated_at: "Oct 11, 2026 10:04pm", user_id: 50, user_name: "User 50", rating: "not_good" },
      { conversation_id: 1002, number: 1002, rated_at: "Oct 9, 2026 03:38pm", user_id: 49, user_name: "User 49", rating: "great" },
    ]);
    expect(r.content_notice).toMatch(/omitted/);
    const withComments = await satisfactionReport(client, { from: "2026-10-01", to: "2026-10-28", type: "email", include_comments: true });
    expect(posted()[1]).toContainEqual(["filters[type]", "1"]);
    if (!withComments.available) throw new Error("unavailable");
    expect(withComments.ratings[0]).toMatchObject({ customer: { id: 201, name: "Customer 201" }, comment: "Comment text" });
    expect(withComments.content_notice).toMatch(/untrusted/);
  });

  it("list_report_users: one GET, no POST", async () => {
    const client = await setup();
    const r = await listReportUsers(client);
    expect(fs!.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/productivity"]);
    expect(r).toMatchObject({ available: true, current_user_id: 50, tags_count: 3, mailboxes: [{ id: 18 }, { id: 15 }, { id: 21 }] });
    expect(r.note).toMatch(/list_assignees/);
  });

  it("a mailbox not in the page's list is reported as a warning", async () => {
    const client = await setup();
    const r = await productivityReport(client, { from: "2026-10-01", to: "2026-10-28", mailbox_id: 99 });
    expect(r).toMatchObject({ filter_warnings: [expect.stringMatching(/mailbox_id 99/)] });
  });

  it("L8: user and tag ids not in the page's lists are warnings too (both reports); listed ids are not", async () => {
    const client = await setup();
    const p = await productivityReport(client, { from: "2026-10-01", to: "2026-10-28", user_id: 9999, tag_id: 99999 });
    expect(p.filter_warnings).toEqual([expect.stringMatching(/^user_id 9999 /), expect.stringMatching(/^tag_id 99999 /)]);
    expect(p.note).toMatch(/user_id 9999/);
    const s = await satisfactionReport(client, { from: "2026-10-01", to: "2026-10-28", user_id: 9999 });
    expect(s.filter_warnings).toEqual([expect.stringMatching(/^user_id 9999 /)]);
    const ok = await productivityReport(client, { from: "2026-10-01", to: "2026-10-28", user_id: 50, mailbox_id: 15 });
    expect(ok).not.toHaveProperty("filter_warnings");
  });

  for (const [mode, reason] of [
    ["absent", "module_not_installed"],
    ["forbidden", "not_available_to_this_account"],
    ["redirect", "not_available_to_this_account"],
    ["no_form", "not_available_to_this_account"],
  ] as const) {
    it(`mode ${mode} -> ${reason} for all three tools, never a POST`, async () => {
      const client = await setup({ mode });
      expect(await productivityReport(client, { from: "2026-10-01", to: "2026-10-28" })).toMatchObject({ available: false, reason });
      expect(await satisfactionReport(client, { from: "2026-10-01", to: "2026-10-28" })).toMatchObject({ available: false, reason, report: "satisfaction" });
      expect(await listReportUsers(client)).toMatchObject({ available: false, reason });
      expect(fs!.requests.filter((q) => q.method === "POST")).toEqual([]);
    });
  }

  it("module not configured at all on the fake (like the demo) -> module_not_installed", async () => {
    const client = await setup("uninstalled");
    expect(await listReportUsers(client)).toMatchObject({ available: false, reason: "module_not_installed" });
  });

  it("a login page through the real Session is an AuthError (dead session), not 'not available'", async () => {
    const client = await setup({ mode: "login" });
    await expect(productivityReport(client, { from: "2026-10-01", to: "2026-10-28" })).rejects.toBeInstanceOf(AuthError);
    expect(fs!.reportPosts).toEqual([]);
  });

  it("{status:'error', msg} is a tool error with the message", async () => {
    const client = await setup({ ajaxError: "Invalid date range" });
    await expect(productivityReport(client, { from: "2026-10-01", to: "2026-10-28" })).rejects.toThrow(/Invalid date range/);
  });

  it("bad dates and ranges over 366 days fail before any request", async () => {
    const client = await setup();
    for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-28", "2026-10-01"], ["2025-10-27", "2026-10-28"], ["26-10-01", "2026-10-28"]]) {
      await expect(productivityReport(client, { from: from!, to: to! })).rejects.toThrow(/Nothing was sent/);
      await expect(satisfactionReport(client, { from: from!, to: to! })).rejects.toThrow(/Nothing was sent/);
    }
    expect(fs!.requests).toEqual([]);
  });

  it("MCP tools: registered read-only, unavailable is a success result, zod rejects bad dates", async () => {
    const client = await setup({ mode: "absent" });
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { client, forwardAllow: [] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    close = () => Promise.all([mcp.close(), server.close()]);
    const { tools } = await mcp.listTools();
    for (const n of ["productivity_report", "satisfaction_report", "list_report_users", "agent_stats", "conversations_report", "time_tracking_report"]) {
      expect(tools.find((t) => t.name === n)!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
    const pr = tools.find((t) => t.name === "productivity_report")!;
    expect(Object.keys(pr.inputSchema.properties ?? {}).sort()).toEqual(["chart_metric", "from", "group_by", "mailbox_id", "tag_id", "to", "type", "user_id", "week_start"]);
    const sr = tools.find((t) => t.name === "satisfaction_report")!;
    expect(Object.keys(sr.inputSchema.properties ?? {}).sort()).toEqual(["from", "include_comments", "mailbox_id", "tag_id", "to", "type", "user_id"]);
    const r = await mcp.callTool({ name: "productivity_report", arguments: { from: "2026-10-01", to: "2026-10-28" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ available: false, reason: "module_not_installed" });
    const bad = await mcp.callTool({ name: "satisfaction_report", arguments: { from: "2026-13-01", to: "2026-10-28" } });
    expect(bad.isError).toBe(true);
    expect(fs!.requests.map((q) => q.path)).toEqual(["/reports/productivity"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes (docs/REDTEAM.md, Phase B "fixes after review"): synthetic fragments and answers.

const metricHtml = (pairs: Array<[string, string]>) =>
  `<div class="rpt-metrics">${pairs
    .map(([t, v]) => `<div class="rpt-metric"><div class="rpt-metric-title">${t}</div><div class="rpt-metric-value">${v}<span class="rpt-metric-change text-help">0%</span></div></div>`)
    .join("")}</div>`;
const distTable = (title: string) =>
  `<table class="table"><tr><th>${title}</th><th>%</th><th>Δ</th></tr><tr><td>1</td><td>50%</td><td>0%</td></tr><tr><td><i>Avg.</i></td><td colspan="2"><i>1 h</i></td></tr></table>`;
const tables = (...t: string[]) => `<div id="rpt-tables">${t.join("")}</div>`;
const ratingRow = (n: number, customerCell = `<a href="https://fs.example/customers/${n}/edit">Customer ${n}</a>`) =>
  `<tr><td><a href="https://fs.example/conversation/${n}">#${n}</a><br/><small>Oct 1, 2026</small></td><td>${customerCell}</td><td><button class="rpt-user-btn" data-uid="50">User 50</button></td><td><span class="text-success">Great</span></td><td>c</td></tr>`;
const ratingsTable = (rows: string[]) =>
  `<table class="table"><tr><th>#</th><th>Customer</th><th>User</th><th>Rating</th><th>Comment</th></tr>${rows.join("")}</table>`;
const PROD_METRICS = metricHtml([["Customers Helped", "86"], ["Replies Sent", "214"]]);
const SAT_METRICS = metricHtml([["Ratings", "2"], ["Satisfaction Score", "50%"]]);
const okChart = (over: Record<string, unknown> = {}) => ({
  type: "customers_helped", group_bys: ["d"], group_by: "d", labels: ["Oct 1", "Oct 2"],
  datasets: [{ label: "Current", data: [1, 2] }, { label: "Previous", data: [3, 4] }], ...over,
});
const PROD_PAGE = { html: raw("reports-productivity-page.html"), url: "https://fs.example/reports/productivity" };
const SAT_PAGE = { html: raw("reports-productivity-page.html").replace('data-report-name="productivity"', 'data-report-name="satisfaction"'), url: "https://fs.example/reports/satisfaction" };
const prod = async (report: string, chart: unknown = okChart(), input = {}) => {
  const r = await productivityReport(stub(PROD_PAGE, { status: "success", msg: "", report, chart }).port, { from: "2026-10-01", to: "2026-10-02", ...input });
  if (!r.available) throw new Error("unavailable");
  return r;
};
const sat = async (report: string, chart: unknown = { labels: ["Good", "Okay", "Not Good"], datasets: [{ data: [50, 0, 50] }] }, input = {}) => {
  const r = await satisfactionReport(stub(SAT_PAGE, { status: "success", msg: "", report, chart }).port, { from: "2026-10-01", to: "2026-10-02", ...input });
  if (!r.available) throw new Error("unavailable");
  return r;
};

describe("review fixes", () => {
  it("M1: null / empty / non-numeric chart points are null (never 0), with a note", async () => {
    const r = await prod(PROD_METRICS + tables(distTable("First Response Time"), distTable("Response Time")), okChart({
      datasets: [{ label: "Current", data: [null, "3"] }, { label: "Previous", data: ["", "x"] }],
    }));
    expect(r.chart!.current).toEqual([null, 3]);
    expect(r.chart!.previous).toEqual([null, null]);
    expect(r.note).toMatch(/null \(no data\), not 0/);
    const clean = await prod(PROD_METRICS + tables(distTable("First Response Time"), distTable("Response Time")));
    expect(clean.chart!.current).toEqual([1, 2]);
    expect(clean.note).not.toMatch(/not 0\./);
  });

  it("M1: satisfaction pie percentages are null when missing, with a note", async () => {
    const r = await sat(SAT_METRICS + tables(ratingsTable([])), { datasets: [{ data: [null, null, null] }] });
    expect(r.distribution).toEqual({ good_percent: null, okay_percent: null, not_good_percent: null });
    expect(r.note).toMatch(/percentages were missing.*null, not 0/);
    const short = await sat(SAT_METRICS + tables(ratingsTable([])), { datasets: [{ data: ["50", 50] }] });
    expect(short.distribution).toEqual({ good_percent: 50, okay_percent: 50, not_good_percent: null });
  });

  it("L1: no group_bys in the answer -> available_group_bys null and a note; no mismatch when type/group_by match", async () => {
    const html = PROD_METRICS + tables(distTable("First Response Time"), distTable("Response Time"));
    const r = await prod(html, okChart({ group_bys: undefined }));
    expect(r.chart!.available_group_bys).toBeNull();
    expect(r).not.toHaveProperty("mismatch");
    expect(r.note).toMatch(/did not list the allowed group-bys/);
    expect(r.note).not.toMatch(/MISMATCH/);
    const off = await prod(html, okChart({ group_bys: undefined, group_by: "w" }));
    expect(off.mismatch).toEqual({
      requested: { metric: "customers_helped", group_by: "day" },
      received: { metric: "customers_helped", group_by: "week", available_group_bys: null },
    });
    expect(off.note).toMatch(/allowed for this range: not listed/);
  });

  it("L8: no chart -> chart null with a note; label/series length mismatch -> note", async () => {
    const html = PROD_METRICS + tables(distTable("First Response Time"), distTable("Response Time"));
    const none = await prod(html, null);
    expect(none.chart).toBeNull();
    expect(none.note).toMatch(/no chart data; chart is null/);
    const uneven = await prod(html, okChart({ labels: ["Oct 1", "Oct 2", "Oct 3"] }));
    expect(uneven.note).toMatch(/different lengths/);
  });

  it("L8: an empty report (metrics only, no tables) -> nulls and notes, never zeros or empty lists", async () => {
    const r = await prod(PROD_METRICS, okChart());
    expect(r).toMatchObject({ first_response_time: null, response_time: null, users: null });
    expect(r).not.toHaveProperty("other_distributions");
    expect(r.note).toMatch(/no users table.*users is null/);
    expect(r.note).toMatch(/no First Response Time and\/or Response Time table/);
    const s = await sat(SAT_METRICS);
    expect(s.ratings).toEqual([]);
    expect(s.ratings_total).toBe(0);
    expect(s.note).toMatch(/no ratings table/);
  });

  it("L2: German time tables -> other_distributions with a non-English note; keys are slugs of the rendered titles", async () => {
    const html =
      metricHtml([["Geholfene Kunden", "86"]]) +
      tables(distTable("Erste Antwortzeit"), distTable("Antwortzeit"),
        `<table class="table"><tr><th>Benutzer</th><th>Gesendete Antworten</th></tr></table>`);
    const r = await prod(html);
    expect(r.metrics[0]!.key).toBe("geholfene_kunden");
    expect(r.first_response_time).toBeNull();
    expect(Object.keys(r.other_distributions!)).toEqual(["erste_antwortzeit", "antwortzeit"]);
    expect(r.note).toMatch(/UI language seems to be non-English/);
    // A users table with a German header and no rows has no rpt-user-btn: not recognised, so null with a note.
    expect(r.users).toBeNull();
    expect(r.note).toMatch(/no users table/);
  });

  it("L3: a customer cell without a link keeps the name (id null)", async () => {
    const r = await sat(SAT_METRICS + tables(ratingsTable([ratingRow(7, "Jane Doe")])), undefined, { include_comments: true });
    expect(r.ratings[0]!.customer).toEqual({ id: null, name: "Jane Doe" });
    expect(parseReportHtml(tables(ratingsTable([ratingRow(8, "")]))).ratings![0]!.customer).toBeNull();
  });

  it("L4: users table by header only; unknown headers go to extra_columns, never guessed by position", () => {
    const users = parseReportHtml(
      tables(`<table class="table"><tr><th>User</th><th>Replies Sent</th><th>Escalations</th><th>Closed</th><th>Kunden</th></tr>` +
        `<tr><td><button class="rpt-user-btn" data-uid="5">User 5</button></td><td>3</td><td>9</td><td>4</td><td>7</td></tr></table>`),
    ).users!;
    expect(users).toEqual([{
      user_id: 5, name: "User 5", replies_sent: 3, closed: 4, customers_helped: null, satisfaction_score: null,
      extra_columns: { escalations: "9", kunden: "7" },
    }]);
  });

  it("I7: non-plain numbers keep their raw text (metrics: raw_value; users table: raw_values)", async () => {
    const s = await sat(SAT_METRICS + tables(ratingsTable([])));
    expect(s.metrics.find((m) => m.key === "satisfaction_score")).toMatchObject({ value: null, raw_value: "50%" });
    const r = await prod(PROD_METRICS + tables(distTable("First Response Time"), distTable("Response Time"),
      `<table class="table"><tr><th>User</th><th>Replies Sent</th><th>Satisfaction Score</th></tr>` +
        `<tr><td><button class="rpt-user-btn" data-uid="5">User 5</button></td><td>3</td><td>50%</td></tr></table>`));
    expect(r.users![0]).toMatchObject({ replies_sent: 3, satisfaction_score: null, raw_values: { replies_sent: "3", satisfaction_score: "50%" } });
    expect(r.note).toMatch(/raw_values/);
  });
});

describe("review fixes through the fake FreeScout (reports.answer)", () => {
  let fs: FakeFreeScout | undefined;
  afterEach(async () => {
    await fs?.stop();
    fs = undefined;
  });

  it("L8: more than 500 rated conversations -> first 500, ratings_total and ratings_truncated", async () => {
    fs = new FakeFreeScout();
    await fs.start();
    const rows = Array.from({ length: 501 }, (_, i) => ratingRow(1000 + i));
    fs.reports = { answer: { status: "success", msg: "", report: SAT_METRICS + tables(ratingsTable(rows)), chart: SAT.chart } };
    const client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
    const r = await satisfactionReport(client, { from: "2026-10-01", to: "2026-10-28" });
    if (!r.available) throw new Error("unavailable");
    expect(r.ratings).toHaveLength(500);
    expect(r.ratings_total).toBe(501);
    expect(r.ratings_truncated).toBe(true);
    expect(r.ratings.at(-1)!.conversation_id).toBe(1499);
    expect(r.note).toMatch(/first 500 of 501/);
    expect(fs.reportPosts).toHaveLength(1);
  });
});
