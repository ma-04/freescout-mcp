/**
 * conversations_report and time_tracking_report (Phase C item 3): parsers on the scrubbed 2026-10-31 fixtures
 * (report-aware table dispatch, durations, the non-numeric Busiest Day card), the slug <-> wire name mapping of the
 * availability check, the per-report guard, include_names, and the exact wire bodies through the real Session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { silentLogger } from "../src/log.js";
import { parseDuration, parseReportFilterForm, parseReportHtml } from "../src/parsers/reports.js";
import {
  REPORT_SLUGS,
  buildReportForm,
  conversationsReport,
  openReportPage,
  reportWire,
  timeTrackingReport,
  type ConversationsReport,
  type TimeTrackingReport,
} from "../src/reports.js";
import { Session } from "../src/session.js";
import { FakeFreeScout, reportPage } from "./fake-freescout.js";

const raw = (n: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${n}`, import.meta.url)), "utf8");
const CONV = JSON.parse(raw("reports-conversations-ajax.json")) as { report: string; chart: Record<string, unknown> };
const TIME = JSON.parse(raw("reports-time-tracking-ajax.json")) as { report: string; chart: Record<string, unknown> };

describe("durations", () => {
  it("English days/hours/minutes, singular and plural, to whole minutes; anything else null with raw kept", () => {
    expect(parseDuration("2 days 22 hours 37 minutes")).toEqual({ raw: "2 days 22 hours 37 minutes", minutes: 2 * 1440 + 22 * 60 + 37 });
    expect(parseDuration("4 minutes")).toEqual({ raw: "4 minutes", minutes: 4 });
    expect(parseDuration("1 minute").minutes).toBe(1);
    expect(parseDuration("1 hour 10 minutes").minutes).toBe(70);
    expect(parseDuration(" 1 hour\n 10 minutes ")).toEqual({ raw: "1 hour 10 minutes", minutes: 70 });
    expect(parseDuration("45 seconds").minutes).toBe(1);
    for (const bad of ["", "2 jours 3 heures", "about 4 minutes", "4 minutes ago", "1.5 hours", "minutes", "4"]) {
      expect(parseDuration(bad), bad).toMatchObject({ minutes: null });
    }
  });
});

describe("conversations report fragment (scrubbed 2026-10-31 fixture)", () => {
  const p = parseReportHtml(CONV.report, "conversations");
  it("cards: numbers with signed changes; Busiest Day is not a number (value null, raw_value kept)", () => {
    expect(p.metrics.map((m) => [m.key, m.value, m.raw_value, m.change_percent])).toEqual([
      ["total_conversations", 252, "252", 33],
      ["new_conversations", 122, "122", -20],
      ["messages_received", 147, "147", -16],
      ["customers", 76, "76", -17],
      ["conversations_per_day", 15, "15", -20],
      ["busiest_day", null, "Friday", null],
    ]);
    expect(p.metrics[0]!.description).toMatch(/^Number of conversations updated/);
  });

  it("chart options: the selector (New Conversations / Messages Received) and the Day grouping", () => {
    expect(p.chart_options).toEqual({
      selected_type: "new_conv",
      types: [{ value: "new_conv", label: "New Conversations" }, { value: "messages", label: "Messages Received" }],
      group_bys: ["d"],
      active_group_by: "d",
    });
  });

  it("tables: Most Active Customers (id, name, count) and Tags (name, count); no ratings/users misreads", () => {
    expect(p.most_active_customers).toHaveLength(20);
    expect(p.most_active_customers![0]).toEqual({ customer_id: 501, name: "Customer A", count: 31 });
    expect(p.tags).toHaveLength(20);
    expect(p.tags!.slice(0, 2)).toEqual([{ name: "tag one", count: 4 }, { name: "tag-2", count: 1 }]);
    expect(p.ratings).toBeNull();
    expect(p.users).toBeNull();
    expect(p.other_tables).toEqual([]);
  });
});

describe("time tracking report fragment (scrubbed 2026-10-31 fixture)", () => {
  const p = parseReportHtml(TIME.report, "time");
  it("cards: hours with signed changes", () => {
    expect(p.metrics.map((m) => [m.key, m.value, m.change_percent])).toEqual([
      ["total_hours_spent", 76.7, 78],
      ["avg_hours_spent_per_update", 0.6, 60],
    ]);
  });

  it("users table from /users/profile links (not rpt-user-btn), both durations", () => {
    expect(p.time_users).toHaveLength(5);
    expect(p.time_users![2]).toEqual({
      user_id: 50,
      name: "Agent Three",
      time_spent: { raw: "2 days 22 hours 37 minutes", minutes: 4237 },
      avg_time_spent_per_update: { raw: "41 minutes", minutes: 41 },
    });
    expect(p.time_users!.map((u) => u.user_id)).toEqual([9, 49, 50, 58, 59]);
  });

  it("the CONVERSATION table is conversations with time (not a ratings table); subjects decoded", () => {
    expect(p.ratings).toBeNull();
    expect(p.time_conversations).toHaveLength(20);
    expect(p.time_conversations![0]).toEqual({ conversation_id: 1001, number: 1001, subject: "Subject 1", time_spent: { raw: "6 hours 9 minutes", minutes: 369 } });
    expect(p.time_conversations![12]!.subject).toBe("Subject 13 can't & won't");
    expect(p.time_customers).toHaveLength(20);
    expect(p.time_customers![0]).toEqual({ customer_id: 503, name: "Customer A", time_spent: { raw: "8 hours 41 minutes", minutes: 521 } });
    expect([...p.time_users!, ...p.time_conversations!, ...p.time_customers!].every((r) => r.time_spent?.minutes !== null)).toBe(true);
  });

  it("productivity dispatch is unchanged when no report is named (the time table would be misread there)", () => {
    expect(parseReportHtml(TIME.report).ratings).not.toBeNull();
  });

  it("an unrecognised table is reported by shape only", () => {
    const html = `${TIME.report.split('<div id="rpt-tables">')[0]}<div id="rpt-tables"><table><tr><th>Mystery</th><th>X</th></tr><tr><td>secret customer text</td><td>1</td></tr></table></div>`;
    const q = parseReportHtml(html, "time");
    expect(q.other_tables).toEqual([{ key: "mystery", title: "Mystery", headers: ["Mystery", "X"], row_count: 1 }]);
    expect(JSON.stringify(q)).not.toContain("secret customer text");
    expect(q.time_users).toBeNull();
  });
});

describe("slug <-> wire name, filter forms, guard", () => {
  it("time is /reports/time-tracking on the page and `time` on the wire", () => {
    expect(REPORT_SLUGS).toEqual({ productivity: "productivity", satisfaction: "satisfaction", conversations: "conversations", time: "time-tracking" });
  });

  it("availability: the time page is accepted at /reports/time-tracking with data-report-name=time; other paths are not", async () => {
    const port = (html: string, url: string): FreeScoutPort => ({
      async getHtml(): Promise<HtmlPage> {
        return { $: cheerio.load(html), url, status: 200 };
      },
      ajaxPost: () => Promise.reject(new Error("no")),
    });
    const time = reportPage("time-tracking", "T");
    expect(await openReportPage(port(time, "https://fs.example/reports/time-tracking"), "time")).toHaveProperty("$");
    expect(await openReportPage(port(time, "https://fs.example/reports/time"), "time")).toMatchObject({ available: false, detail: "/reports/time-tracking redirected to /reports/time" });
    // A page that renders another report is refused.
    expect(await openReportPage(port(reportPage("conversations", "T"), "https://fs.example/reports/time-tracking"), "time")).toMatchObject({
      available: false,
      detail: "/reports/time-tracking rendered the conversations report",
    });
    expect(await openReportPage(port(reportPage("conversations", "T"), "https://fs.example/reports/conversations"), "conversations")).toHaveProperty("$");
  });

  it("the conversations / time filter forms have no user select", () => {
    for (const n of ["conversations", "time-tracking"]) {
      const f = parseReportFilterForm(cheerio.load(reportPage(n, "T")));
      expect(f.users).toEqual([]);
      expect(f.mailboxes.length).toBeGreaterThan(0);
    }
  });

  it("wire bodies: exactly the observed browser body, no user and no chart keys; user_id refused before any request", () => {
    const body = (n: "conversations" | "time") => new URLSearchParams(reportWire(buildReportForm(n, { from: "2026-10-24", to: "2026-10-31" }))).toString();
    expect(body("conversations")).toBe(
      new URLSearchParams("action=report&report_name=conversations&filters[type]=&filters[mailbox]=&filters[tag]=&filters[period]=custom&filters[from]=2026-10-24&filters[to]=2026-10-31").toString(),
    );
    expect(body("time")).toBe(
      new URLSearchParams("action=report&report_name=time&filters[type]=&filters[mailbox]=&filters[tag]=&filters[period]=custom&filters[from]=2026-10-24&filters[to]=2026-10-31").toString(),
    );
    expect(() => buildReportForm("time", { from: "2026-10-24", to: "2026-10-31", user_id: 50 })).toThrow(/not a filter of the time-tracking report/);
  });
});

describe("conversations_report / time_tracking_report through the real Session against the fake FreeScout", () => {
  let fs: FakeFreeScout | undefined;
  afterEach(async () => {
    await fs?.stop();
    fs = undefined;
  });
  async function setup(reports: FakeFreeScout["reports"] = {}) {
    fs = new FakeFreeScout();
    await fs.start();
    fs.reports = reports;
    return new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
  }
  const posted = () => fs!.reportPosts.map((p) => p.filter(([k]) => k !== "_token"));
  const decoded = (s: string) => [...new URLSearchParams(s).entries()];

  it("conversations: page GET + one request; names omitted by default", async () => {
    const client = await setup();
    const r = (await conversationsReport(client, { from: "2026-10-24", to: "2026-10-31", mailbox_id: 15, tag_id: 1302, type: "email" })) as ConversationsReport;
    expect(fs!.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/conversations", "POST /reports/ajax"]);
    expect(posted()).toEqual([
      decoded("action=report&report_name=conversations&filters[type]=1&filters[mailbox]=15&filters[tag]=1302&filters[period]=custom&filters[from]=2026-10-24&filters[to]=2026-10-31"),
    ]);
    expect(r).toMatchObject({ available: true, report: "conversations", filters: { from: "2026-10-24", to: "2026-10-31", mailbox_id: 15, tag_id: 1302, type: "email", include_names: false } });
    expect(r.metrics.find((m) => m.key === "busiest_day")).toMatchObject({ value: null, raw_value: "Friday" });
    expect(r.most_active_customers![0]).toEqual({ customer_id: 501, count: 31 });
    expect(JSON.stringify(r)).not.toContain("Customer A");
    expect(r.tags![0]).toEqual({ name: "tag one", count: 4 });
    expect(r.chart).toMatchObject({ metric: "new_conv", group_by: "day", available_group_bys: ["day"] });
    expect(r.chart!.current).toEqual([10, 12, 17, 14, 12, 19, 31, 7]);
    expect(r.chart!.current.reduce((a, b) => a! + b!, 0)).toBe(122); // = New Conversations
    expect(r.chart_options!.types.map((t) => t.value)).toEqual(["new_conv", "messages"]);
    expect(r.content_notice).toMatch(/omitted \(include_names: false\)/);
    expect(r.note).toMatch(/Busiest Day/);
  });

  it("conversations with include_names: names present and labelled untrusted", async () => {
    const client = await setup();
    const r = (await conversationsReport(client, { from: "2026-10-24", to: "2026-10-31", include_names: true })) as ConversationsReport;
    expect(r.most_active_customers![0]).toEqual({ customer_id: 501, name: "Customer A", count: 31 });
    expect(r.content_notice).toMatch(/untrusted/);
  });

  it("time tracking: GET /reports/time-tracking, report_name=time; subjects and customer names only with include_names", async () => {
    const client = await setup();
    const r = (await timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31" })) as TimeTrackingReport;
    expect(fs!.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /reports/time-tracking", "POST /reports/ajax"]);
    expect(posted()).toEqual([
      decoded("action=report&report_name=time&filters[type]=&filters[mailbox]=&filters[tag]=&filters[period]=custom&filters[from]=2026-10-24&filters[to]=2026-10-31"),
    ]);
    expect(r).toMatchObject({ available: true, report: "time", filters: { include_names: false } });
    expect(r.metrics.map((m) => m.value)).toEqual([76.7, 0.6]);
    expect(r.users![2]).toMatchObject({ user_id: 50, name: "Agent Three", time_spent: { minutes: 4237 } });
    expect(r.conversations![0]).toEqual({ conversation_id: 1001, number: 1001, time_spent: { raw: "6 hours 9 minutes", minutes: 369 } });
    expect(r.customers![0]).toEqual({ customer_id: 503, time_spent: { raw: "8 hours 41 minutes", minutes: 521 } });
    expect(JSON.stringify(r)).not.toMatch(/Subject \d|Customer [A-Z]/);
    expect(r.chart).toEqual({
      y_title: "Hours",
      bars: [
        { label: "Agent One", value: 0.1 }, { label: "Agent Two", value: 4.1 }, { label: "Agent Three", value: 70.6 },
        { label: "Agent Four", value: 0.7 }, { label: "Agent Five", value: 1.2 },
      ],
    });
    const withNames = (await timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31", include_names: true })) as TimeTrackingReport;
    expect(withNames.conversations![0]!.subject).toBe("Subject 1");
    expect(withNames.customers![0]!.name).toBe("Customer A");
    expect(withNames.content_notice).toMatch(/untrusted/);
  });

  it("include_names false drops unrecognised columns (extra_columns) from every time table: no customer text leaks", async () => {
    // An extra "Customer" column in the conversations and users tables and an "Email" column in the customers table.
    let report = TIME.report;
    const addCol = (afterHeader: string, header: string, cell: string) => {
      const start = report.indexOf(`<th>${afterHeader}</th>`);
      expect(start).toBeGreaterThan(-1);
      const end = report.indexOf("</table>", start);
      const table = report
        .slice(start, end)
        .replace(/<\/th>(\s*)<\/tr>/, `</th><th>${header}</th>$1</tr>`)
        .replace(/<\/td>(\s*)<\/tr>/g, `</td><td>${cell}</td>$1</tr>`);
      report = report.slice(0, start) + table + report.slice(end);
    };
    addCol("Customer", "Email", "leaky@customer.example"); // first: the others add a <th>Customer</th>
    addCol("Conversation", "Customer", "Leaky Customer Name");
    addCol("User", "Customer", "Leaky User Cell");
    const client = await setup({ answer: { ...TIME, report } });
    const r = (await timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31" })) as TimeTrackingReport;
    expect(r.conversations!.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/Leaky|leaky@/);
    expect(JSON.stringify([r.users, r.conversations, r.customers])).not.toMatch(/extra_columns/);
    expect(r.note).toMatch(/columns were not recognised; their cells were omitted/);
    expect(r.content_notice).toMatch(/unrecognised table columns were omitted/);
    const withNames = (await timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31", include_names: true })) as TimeTrackingReport;
    expect(withNames.conversations![0]!.extra_columns).toEqual({ customer: "Leaky Customer Name" });
    expect(withNames.users![0]!.extra_columns).toEqual({ customer: "Leaky User Cell" });
    expect(withNames.customers![0]!.extra_columns).toEqual({ email: "leaky@customer.example" });
    expect(withNames.note).toMatch(/verbatim under extra_columns/);
  });

  it("user_id is refused before any request; module missing is available:false with the time report name", async () => {
    const client = await setup();
    await expect(timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31", user_id: 50 })).rejects.toThrow(/user_id is not a filter/);
    await expect(conversationsReport(client, { from: "2026-10-24", to: "2026-10-31", user_id: 50 })).rejects.toThrow(/user_id is not a filter/);
    expect(fs!.requests).toEqual([]);
    fs!.reports = undefined;
    expect(await timeTrackingReport(client, { from: "2026-10-24", to: "2026-10-31" })).toMatchObject({ available: false, report: "time", reason: "module_not_installed", detail: "HTTP 404 on /reports/time-tracking" });
    fs!.reports = { mode: "forbidden" };
    expect(await conversationsReport(client, { from: "2026-10-24", to: "2026-10-31" })).toMatchObject({ available: false, reason: "not_available_to_this_account" });
    expect(fs!.reportPosts).toEqual([]);
  });
});
