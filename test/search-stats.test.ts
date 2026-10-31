/**
 * Search filters, list_assignees and ticket_volume (docs/freescout-endpoints.md §10): parsers against the real demo
 * fixtures, the wire form of every filter, strict date rejection before any request, dropped-mailbox detection and
 * bucket generation / caps / serial requests against the fake FreeScout's GET /search.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { isStrictDate } from "../src/dates.js";
import { FreeScoutError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import { buildSearchParams, listAssignees, searchConversations } from "../src/operations.js";
import { DEFAULT_STATS_DELAY_MS, loadBaseConfig } from "../src/config.js";
import { parseConversationTable } from "../src/parsers/conversation-table.js";
import { offeredFilters, parseSearchFilters } from "../src/parsers/search-filters.js";
import { Session } from "../src/session.js";
import { makeBuckets, ticketVolume } from "../src/stats.js";
import { registerTools } from "../src/tools/index.js";
import { CORE_SEARCH_FILTERS, FakeFreeScout, searchPage } from "./fake-freescout.js";

const BASE = "https://freescout.example.com";
/** ticket_volume without the production pause between requests. */
const tv = (port: FreeScoutPort, input: Parameters<typeof ticketVolume>[1]) => ticketVolume(port, input, { delayMs: 0 });
const ST = "f%5Bstate%5D%5B%5D=2"; // ticket_volume pins state=published on every request
const raw = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");
const load = (name: string) => cheerio.load(raw(name));

describe("search page parsers on the real fixtures", () => {
  it("reads the assignee and mailbox dropdowns (disabled selects still carry options)", () => {
    expect(parseSearchFilters(load("search-filters-only.html"))).toEqual({
      assignees: [{ id: 2, name: "Demo Agent" }],
      mailboxes: [{ id: 1, name: "Support" }],
    });
    expect(parseSearchFilters(cheerio.load("<p>no form</p>"))).toEqual({ assignees: null, mailboxes: null });
  });

  it("totals come from the tfoot, and an empty result (no tfoot) is 0", () => {
    const t = (n: string) => parseConversationTable(load(n), BASE, null);
    expect(t("search-filters-only.html")).toMatchObject({ total: 9, range: { from: 1, to: 9 } });
    const day = t("search-day-2026-10-26.html");
    expect(day.total).toBe(4);
    expect(day.conversations.map((r) => r.id).sort()).toEqual([1, 4, 6, 9]);
    expect(t("search-empty-result.html")).toMatchObject({ total: 0, conversations: [] });
    expect(t("search-assigned-unassigned.html").conversations.map((r) => r.id)).toEqual([1, 4, 7]);
  });
});

describe("buildSearchParams wire form", () => {
  const wire = (o: Parameters<typeof buildSearchParams>[0]) => [...buildSearchParams(o).params.entries()];

  it('maps "unassigned" to -1, statuses/states to repeated [] arrays and the scalar filters to FreeScout values', () => {
    expect(wire({ assigned: "unassigned" })).toEqual([["f[assigned]", "-1"]]);
    expect(wire({ assigned: 7 })).toEqual([["f[assigned]", "7"]]);
    expect(wire({ status: ["active", "closed"], state: ["deleted"] })).toEqual([
      ["f[status][]", "1"],
      ["f[status][]", "3"],
      ["f[state][]", "3"],
    ]);
    expect(wire({ status: ["spam", "pending", "spam"] })).toEqual([
      ["f[status][]", "4"],
      ["f[status][]", "2"],
    ]);
    expect(wire({ type: "chat", has_attachments: false, customer_id: 9, subject: " Refund ", body: "invoice" })).toEqual([
      ["f[customer]", "9"],
      ["f[type]", "3"],
      ["f[attachments]", "no"],
      ["f[subject]", "Refund"],
      ["f[body]", "invoice"],
    ]);
    expect(wire({ has_attachments: true })).toEqual([["f[attachments]", "yes"]]);
    expect(wire({ q: "x", mailbox_id: 1, after: "2026-10-01", before: "2026-10-31", page: 2 })).toEqual([
      ["q", "x"],
      ["f[mailbox]", "1"],
      ["f[after]", "2026-10-01"],
      ["f[before]", "2026-10-31"],
      ["page", "2"],
    ]);
  });

  it("rejects anything but a real YYYY-MM-DD date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-2-3", "notadate", "10/26/2026", "2026-10-26T00:00", " 2026-10-26", "2026-00-10"]) {
      expect(isStrictDate(bad)).toBe(false);
      expect(() => buildSearchParams({ after: bad })).toThrow(/real calendar date in YYYY-MM-DD.*1970-01-01/);
      expect(() => buildSearchParams({ before: bad })).toThrow(/before must be a real calendar date/);
    }
    expect(isStrictDate("2028-02-29")).toBe(true);
    expect(isStrictDate("2026-02-29")).toBe(false);
    expect(() => buildSearchParams({ after: "2026-10-27", before: "2026-10-26" })).toThrow(/must not be later/);
  });

  it("the demo's filter menu has the core filters and no tag (no Tags module); a page without a menu is null", () => {
    expect(offeredFilters(load("search-empty-result.html"))?.sort()).toEqual([...CORE_SEARCH_FILTERS, "company"].sort());
    expect(offeredFilters(cheerio.load("<p>x</p>"))).toBeNull();
    // Only the filter menu and the filter form count: a stray data-filter elsewhere on the page does not.
    expect(offeredFilters(cheerio.load('<div data-filter="tag">x</div>'))).toBeNull();
    expect(
      offeredFilters(cheerio.load('<ul class="sidebar-menu"><li><a data-filter="status">s</a></li></ul><span data-filter="tag"></span>')),
    ).toEqual(["status"]);
  });

  it("needs q or a filter; mailbox_id alone is not enough", () => {
    expect(() => buildSearchParams({})).toThrow(/Give q or at least one filter/);
    expect(() => buildSearchParams({ q: "   " })).toThrow(/Give q or at least one filter/);
    expect(() => buildSearchParams({ mailbox_id: 1 })).toThrow(/Give q or at least one filter/);
    expect(() => buildSearchParams({ status: [] })).toThrow(/non-empty array/);
    expect(() => buildSearchParams({ assigned: 0 as never })).toThrow(/assigned/);
    expect(() => buildSearchParams({ status: ["open" as never] })).toThrow(/status must only contain/);
  });
});

describe("against the fake FreeScout", () => {
  let fs: FakeFreeScout;
  let client: FreeScoutClient;
  const searches = () => fs.searchRequests.map((p) => p.toString());

  beforeEach(async () => {
    fs = new FakeFreeScout();
    await fs.start();
    client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
  });
  afterEach(async () => {
    await fs?.stop();
  });

  it("filters-only search returns the table and total; unassigned and status filters are wired", async () => {
    const r = await searchConversations(client, { after: "2026-10-01", before: "2026-10-31" });
    expect(r).toMatchObject({ query: null, total: 9, filters: { after: "2026-10-01", before: "2026-10-31" } });
    expect(r.mailbox_filter_ignored).toBeUndefined();
    const u = await searchConversations(client, { assigned: "unassigned" });
    expect(u.conversations.map((c) => c.id).sort()).toEqual([1, 4, 7]);
    const s = await searchConversations(client, { status: ["pending", "closed"] });
    expect(s.conversations.map((c) => c.id).sort()).toEqual([3, 5, 7, 8]);
    expect(searches()).toEqual([
      "f%5Bafter%5D=2026-10-01&f%5Bbefore%5D=2026-10-31",
      "f%5Bassigned%5D=-1",
      "f%5Bstatus%5D%5B%5D=2&f%5Bstatus%5D%5B%5D=3",
    ]);
  });

  it("a bad date is refused before any request", async () => {
    await expect(searchConversations(client, { after: "notadate" })).rejects.toThrow(/1970-01-01/);
    await expect(tv(client, { from: "2026-02-30", to: "2026-03-01" })).rejects.toThrow(/from must be a real calendar date/);
    expect(fs.requests).toEqual([]);
  });

  it("detects a mailbox filter FreeScout silently dropped", async () => {
    fs.searchConvs.push({ id: 10, mailbox_id: 2, created_at: "2026-10-26 09:00", status: 1, user_id: null, subject: "Billing only" });
    const dropped = await searchConversations(client, { q: "subject", mailbox_id: 2 });
    expect(dropped).toMatchObject({ mailbox_id: 2, mailbox_filter_ignored: true });
    expect(dropped.note).toMatch(/searched all mailboxes it can view/);
    expect(dropped.conversations.map((c) => c.id)).not.toContain(10);
    const ok = await searchConversations(client, { q: "subject", mailbox_id: 1 });
    expect(ok.mailbox_filter_ignored).toBeUndefined();
    expect(ok.total).toBe(9);
  });

  it("list_assignees parses the dropdown from GET /search without parameters", async () => {
    fs.searchAssignees = [[2, "Demo Agent"], [5, "Zed O'Neil"]];
    expect(await listAssignees(client)).toEqual({
      assignees: [{ id: 2, name: "Demo Agent" }, { id: 5, name: "Zed O'Neil" }],
      unassigned_value: "unassigned",
      note: expect.stringMatching(/admins .* may be missing.*any numeric user id still works/i),
    });
    expect(searches()).toEqual([""]);
  });

  it("ticket_volume by day: one serial search per day, totals from the tfoot, 0 for an empty page", async () => {
    const r = await tv(client, { from: "2026-10-23", to: "2026-10-27" });
    expect(r.buckets).toEqual([
      { start: "2026-10-23", end: "2026-10-23", total: 1 },
      { start: "2026-10-24", end: "2026-10-24", total: 1 },
      { start: "2026-10-25", end: "2026-10-25", total: 1 },
      { start: "2026-10-26", end: "2026-10-26", total: 4 },
      { start: "2026-10-27", end: "2026-10-27", total: 0 },
    ]);
    expect(r).toMatchObject({ period: "day", breakdown: "none", totals: { total: 7 }, requests_made: 5 });
    expect(r.note).toMatch(/CREATED/);
    expect(r.note).toMatch(/CURRENT/);
    expect(r.note).toMatch(/no response or resolution times and no satisfaction ratings/);
    expect(searches()).toEqual(
      ["23", "24", "25", "26", "27"].map((d) => `${ST}&f%5Bafter%5D=2026-10-${d}&f%5Bbefore%5D=2026-10-${d}`),
    );
  });

  it("ticket_volume by ISO week clips the first and last bucket", async () => {
    // 2026-10-23 is a Friday; 2026-10-26 a Monday.
    const r = await tv(client, { from: "2026-10-23", to: "2026-10-26", period: "week" });
    expect(r.buckets).toEqual([
      { start: "2026-10-23", end: "2026-10-25", total: 3 },
      { start: "2026-10-26", end: "2026-10-26", total: 4 },
    ]);
  });

  it("status breakdown: four requests per bucket in a fixed order, totals summed", async () => {
    const r = await tv(client, { from: "2026-10-01", to: "2026-10-31", period: "month", breakdown: "status", assigned: 2 });
    expect(r.buckets).toEqual([
      { start: "2026-10-01", end: "2026-10-31", total: 4, by: { active: 2, pending: 1, closed: 1, spam: 0 } },
    ]);
    expect(r.totals).toEqual({ total: 4, by: { active: 2, pending: 1, closed: 1, spam: 0 } });
    expect(r.filters).toEqual({ assigned: 2, state: ["published"] });
    expect(r.requests_made).toBe(4);
    expect(searches()).toEqual(
      [1, 2, 3, 4].map((s) => `f%5Bassigned%5D=2&f%5Bstatus%5D%5B%5D=${s}&${ST}&f%5Bafter%5D=2026-10-01&f%5Bbefore%5D=2026-10-31`),
    );
  });

  it("assignee breakdown: listed users + unassigned + other (users missing from the list)", async () => {
    const r = await tv(client, { from: "2026-10-25", to: "2026-10-26", breakdown: "assignee" });
    expect(r.breakdown_values).toEqual([
      { key: "2", label: "Demo Agent" },
      { key: "unassigned", label: "Unassigned" },
      { key: "other", label: "Other users" },
    ]);
    expect(r.buckets).toEqual([
      { start: "2026-10-25", end: "2026-10-25", total: 1, by: { "2": 1, unassigned: 0, other: 0 } },
      { start: "2026-10-26", end: "2026-10-26", total: 4, by: { "2": 1, unassigned: 2, other: 1 } },
    ]);
    expect(r.totals).toEqual({ total: 5, by: { "2": 2, unassigned: 2, other: 1 } });
    expect(r.requests_made).toBe(6); // first total request doubles as discovery
    expect(r.note).toMatch(/"other"/);
    expect(searches()).toEqual([
      `${ST}&f%5Bafter%5D=2026-10-25&f%5Bbefore%5D=2026-10-25`,
      `f%5Bassigned%5D=2&${ST}&f%5Bafter%5D=2026-10-25&f%5Bbefore%5D=2026-10-25`,
      `f%5Bassigned%5D=-1&${ST}&f%5Bafter%5D=2026-10-25&f%5Bbefore%5D=2026-10-25`,
      `${ST}&f%5Bafter%5D=2026-10-26&f%5Bbefore%5D=2026-10-26`,
      `f%5Bassigned%5D=2&${ST}&f%5Bafter%5D=2026-10-26&f%5Bbefore%5D=2026-10-26`,
      `f%5Bassigned%5D=-1&${ST}&f%5Bafter%5D=2026-10-26&f%5Bbefore%5D=2026-10-26`,
    ]);
  });

  it("mailbox breakdown uses the dashboard's mailboxes", async () => {
    fs.dashboardMailboxes = [[1, "Support"]];
    const r = await tv(client, { from: "2026-10-26", to: "2026-10-26", breakdown: "mailbox" });
    expect(r.breakdown_values).toEqual([{ key: "1", label: "Support" }]);
    expect(r.buckets).toEqual([{ start: "2026-10-26", end: "2026-10-26", total: 4, by: { "1": 4 } }]);
    expect(r.requests_made).toBe(2);
    expect(fs.requests.map((q) => q.path)).toEqual(["/", "/search"]);
  });

  it("surfaces a widened mailbox filter", async () => {
    const r = await tv(client, { from: "2026-10-26", to: "2026-10-26", mailbox_id: 2 });
    expect(r.mailbox_filter_ignored).toBe(true);
    expect(r.note).toMatch(/^FreeScout ignored mailbox_id/);
    expect(r.buckets[0]!.total).toBe(4);
  });

  it("caps: too many assignees or requests fail after the single discovery request", async () => {
    fs.searchAssignees = Array.from({ length: 10 }, (_, i) => [i + 1, `User ${i + 1}`]);
    await expect(tv(client, { from: "2026-10-26", to: "2026-10-26", breakdown: "assignee" })).rejects.toThrow(
      /11 values, over the cap of 10.*assigned=<id>/,
    );
    expect(fs.searchRequests).toHaveLength(1);
    fs.searchRequests = [];
    fs.searchAssignees = [1, 2, 3].map((i) => [i, `User ${i}`]);
    // 31 days x (3 users + unassigned + total) = 155 > 64
    await expect(tv(client, { from: "2026-10-01", to: "2026-10-31", breakdown: "assignee" })).rejects.toThrow(
      /155 requests, over the cap of 64 per call \(buckets x \(values \+ 1\) must be <= 64\).*coarser period.*assigned=<id>.*mailbox_id/,
    );
    expect(fs.searchRequests).toHaveLength(1);
    // 9 values (8 users + unassigned) are fine for a single bucket: 10 requests.
    fs.searchRequests = [];
    fs.searchAssignees = Array.from({ length: 8 }, (_, i) => [i + 1, `User ${i + 1}`]);
    const ok = await tv(client, { from: "2026-10-26", to: "2026-10-26", breakdown: "assignee" });
    expect(ok.requests_made).toBe(10);
  });

  it("caps known up front are enforced before any request", async () => {
    await expect(tv(client, { from: "2026-10-01", to: "2026-11-01" })).rejects.toThrow(/more than 31 buckets.*coarser period/);
    await expect(tv(client, { from: "2026-10-27", to: "2026-10-26" })).rejects.toThrow(/must not be later/);
    await expect(tv(client, { from: "2026-10-01", to: "2026-10-02", breakdown: "mailbox", mailbox_id: 1 })).rejects.toThrow(/cannot be combined/);
    await expect(tv(client, { from: "2026-10-01", to: "2026-10-02", breakdown: "assignee", assigned: 2 })).rejects.toThrow(/cannot be combined/);
    expect(fs.requests).toEqual([]);
    // 17 days x 4 statuses = 68 > 64: refused before any request.
    await expect(tv(client, { from: "2026-10-01", to: "2026-10-17", breakdown: "status" })).rejects.toThrow(
      /68 requests, over the cap of 64 per call \(buckets x values must be <= 64\)/,
    );
    expect(fs.requests).toEqual([]);
    // 16 days x 4 statuses = 64: exactly at the cap.
    const r = await tv(client, { from: "2026-10-12", to: "2026-10-27", breakdown: "status" });
    expect(r.requests_made).toBe(64);
    expect(r.totals.total).toBe(9);
    // 31 days without a breakdown: 31 requests.
    expect((await tv(client, { from: "2026-10-01", to: "2026-10-31" })).requests_made).toBe(31);
  });
});

describe("makeBuckets", () => {
  it("days, ISO weeks (Monday start) and calendar months, clipped to from/to", () => {
    expect(makeBuckets("2026-10-30", "2026-11-01", "day").map((b) => b.start)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(makeBuckets("2026-10-23", "2026-11-04", "week")).toEqual([
      { start: "2026-10-23", end: "2026-10-25" },
      { start: "2026-10-26", end: "2026-11-01" },
      { start: "2026-11-02", end: "2026-11-04" },
    ]);
    // A Monday start and a Sunday end give whole weeks.
    expect(makeBuckets("2026-10-26", "2026-11-08", "week")).toEqual([
      { start: "2026-10-26", end: "2026-11-01" },
      { start: "2026-11-02", end: "2026-11-08" },
    ]);
    // A Sunday is the last day of its ISO week.
    expect(makeBuckets("2026-11-01", "2026-11-02", "week")).toEqual([
      { start: "2026-11-01", end: "2026-11-01" },
      { start: "2026-11-02", end: "2026-11-02" },
    ]);
    expect(makeBuckets("2028-01-15", "2028-03-10", "month")).toEqual([
      { start: "2028-01-15", end: "2028-01-31" },
      { start: "2028-02-01", end: "2028-02-29" },
      { start: "2028-03-01", end: "2028-03-10" },
    ]);
    expect(makeBuckets("2026-12-20", "2027-01-05", "month")).toEqual([
      { start: "2026-12-20", end: "2026-12-31" },
      { start: "2027-01-01", end: "2027-01-05" },
    ]);
    expect(makeBuckets("2026-10-26", "2026-10-26", "month")).toEqual([{ start: "2026-10-26", end: "2026-10-26" }]);
  });

  it("refuses more than 31 buckets", () => {
    expect(makeBuckets("2026-10-01", "2026-10-31", "day")).toHaveLength(31);
    expect(() => makeBuckets("2026-10-01", "2026-11-01", "day")).toThrow(/more than 31 buckets/);
    expect(() => makeBuckets("2026-01-01", "2026-12-31", "week")).toThrow(/more than 31 buckets/);
    expect(makeBuckets("2024-01-01", "2026-07-31", "month")).toHaveLength(31);
    expect(() => makeBuckets("2000-01-01", "2026-12-31", "month")).toThrow(/more than 31 buckets/);
  });
});

describe("ticket_volume runs requests serially", () => {
  it("never has two searches in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const port: FreeScoutPort = {
      async getHtml(path: string): Promise<HtmlPage> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(path);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        const p = new URL(path, BASE).searchParams;
        return { $: cheerio.load(searchPage(BASE, "t", p, [], [[2, "Demo Agent"]], [[1, "Support"]])), url: new URL(path, BASE).toString(), status: 200 };
      },
      async ajaxPost<T>(): Promise<T> {
        throw new Error("no POST expected");
      },
    };
    const r = await tv(port, { from: "2026-10-01", to: "2026-10-07", breakdown: "status" });
    expect(maxInFlight).toBe(1);
    expect(order).toHaveLength(28);
    expect(r.totals.total).toBe(0);
    expect(r.buckets.every((b) => b.total === 0)).toBe(true);
  });
});

describe("tool layer", () => {
  let cleanup: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function connect(getHtml: (path: string) => Promise<HtmlPage>) {
    const client = new FreeScoutClient(new Session({ baseUrl: "http://127.0.0.1:9", cookie: "laravel_session=x", logger: silentLogger, timeoutMs: 500 }));
    client.getHtml = getHtml;
    client.ajaxPost = async () => {
      throw new Error("no POST expected");
    };
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { client, forwardAllow: [] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    cleanup = () => Promise.all([mcp.close(), server.close()]);
    return mcp;
  }

  it("rejects bad arguments before any request", async () => {
    let calls = 0;
    const mcp = await connect(async () => {
      calls++;
      throw new Error("unexpected");
    });
    for (const [name, args] of [
      ["search_conversations", {}],
      ["search_conversations", { q: "" }],
      ["search_conversations", { q: "   " }],
      ["search_conversations", { mailbox_id: 1 }],
      ["search_conversations", { after: "2026-02-30" }],
      ["search_conversations", { before: "26-10-2026" }],
      ["search_conversations", { assigned: "nobody" }],
      ["search_conversations", { assigned: -1 }],
      ["search_conversations", { status: "active" }],
      ["search_conversations", { status: ["open"] }],
      ["search_conversations", { after: "2026-10-27", before: "2026-10-26" }],
      ["search_conversations", { following: false }],
      ["search_conversations", { number: 0 }],
      ["search_conversations", { id: -3 }],
      ["search_conversations", { tag: "" }],
      ["search_conversations", { tag: "x".repeat(101) }],
      ["search_conversations", { attachment_name: "  " }],
      ["search_conversations", { q: "#8", number: 7 }],
      ["ticket_volume", { from: "2026-10-01", to: "2026-11-15" }],
      ["ticket_volume", { from: "2026-10-01", to: "2026-10-1" }],
      ["ticket_volume", { from: "2026-10-01", to: "2026-10-02", period: "year" }],
      ["ticket_volume", { from: "2026-10-01", to: "2026-10-02", breakdown: "tag" }],
    ] as const) {
      const r = await mcp.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it("search_conversations with filters only, and the descriptions state what is measured", async () => {
    const paths: string[] = [];
    const mcp = await connect(async (path) => {
      paths.push(path);
      return { $: load("search-assigned-unassigned.html"), url: `${BASE}${path}`, status: 200 };
    });
    const r = await mcp.callTool({ name: "search_conversations", arguments: { assigned: "unassigned" } });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { conversations: { id: number }[]; content_notice: string; query: null };
    expect(sc.conversations.map((c) => c.id)).toEqual([1, 4, 7]);
    expect(sc.content_notice).toMatch(/untrusted/);
    expect(paths).toEqual(["/search?f%5Bassigned%5D=-1"]);
    const tools = (await mcp.listTools()).tools;
    const desc = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(desc("search_conversations")).toMatch(/CREATED date in the FreeScout server timezone/);
    expect(desc("search_conversations")).toMatch(/mailbox_filter_ignored/);
    expect(desc("search_conversations")).toMatch(/untrusted/);
    expect(desc("ticket_volume")).toMatch(/CREATED/);
    expect(desc("ticket_volume")).toMatch(/CURRENT status, assignee or mailbox/);
    expect(desc("ticket_volume")).toMatch(/does NOT measure conversations resolved\/closed per day/);
    expect(desc("ticket_volume")).toMatch(/satisfaction ratings/);
    expect(desc("list_assignees")).toMatch(/admins .* may be missing/);
    expect(desc("search_conversations")).toMatch(/deleted conversations and unsent drafts are included unless state is given/);
    expect(desc("search_conversations")).toMatch(/exact conversation-number filter/);
    expect(desc("ticket_volume")).toMatch(/published conversations \(deleted and draft excluded\)/);
    expect(desc("ticket_volume")).toMatch(/at most 31 buckets, 10 breakdown values and 64 requests per call/);
    expect(desc("ticket_volume")).toMatch(/incomplete: true/);
    const tv = tools.find((t) => t.name === "ticket_volume")!;
    expect(Object.keys(tv.inputSchema.properties ?? {}).sort()).toEqual(["assigned", "breakdown", "from", "mailbox_id", "period", "to"]);
  });

  it("ticket_volume through the tool, from the real day fixture", async () => {
    const mcp = await connect(async (path) => ({
      $: load(path.includes("2026-10-26") ? "search-day-2026-10-26.html" : "search-empty-result.html"),
      url: `${BASE}${path}`,
      status: 200,
    }));
    const r = await mcp.callTool({ name: "ticket_volume", arguments: { from: "2026-10-26", to: "2026-10-27" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      buckets: [
        { start: "2026-10-26", end: "2026-10-26", total: 4 },
        { start: "2026-10-27", end: "2026-10-27", total: 0 },
      ],
      totals: { total: 4 },
      requests_made: 2,
    });
  });
});

describe("review fixes (2026-10-28)", () => {
  const wire = (o: Parameters<typeof buildSearchParams>[0]) => [...buildSearchParams(o).params.entries()];
  /** A stub port answering every GET with `html` at `url(path)`. */
  const stub = (html: string | ((path: string) => string), url: (p: string) => string = (p) => new URL(p, BASE).toString()) => {
    const paths: string[] = [];
    const port: FreeScoutPort = {
      async getHtml(path: string): Promise<HtmlPage> {
        paths.push(path);
        return { $: cheerio.load(typeof html === "function" ? html(path) : html), url: url(path), status: 200 };
      },
      async ajaxPost<T>(): Promise<T> {
        throw new Error("no POST expected");
      },
    };
    return { port, paths };
  };
  const page = (p: string) => searchPage(BASE, "t", new URL(p, BASE).searchParams, [], [[2, "Demo Agent"]], [[1, "Support"]]);

  it('H1: "#N" or "N" with a filter or mailbox_id is sent as f[number], never as q', () => {
    expect(wire({ q: "#9", status: ["active"] })).toEqual([["f[status][]", "1"], ["f[number]", "9"]]);
    expect(wire({ q: "9", after: "2026-10-01" })).toEqual([["f[after]", "2026-10-01"], ["f[number]", "9"]]);
    expect(wire({ q: "#9", mailbox_id: 1, page: 2 })).toEqual([["f[mailbox]", "1"], ["f[number]", "9"], ["page", "2"]]);
    expect(buildSearchParams({ q: "#9", status: ["active"] })).toMatchObject({ byNumber: true, query: "#9", filters: { number: 9 } });
    // Without filters the redirect path is kept; text queries are untouched.
    expect(wire({ q: "#9" })).toEqual([["q", "#9"]]);
    expect(wire({ q: "#9x", status: ["active"] })).toEqual([["q", "#9x"], ["f[status][]", "1"]]);
    expect(() => buildSearchParams({ q: "#0", status: ["active"] })).toThrow(/positive integer/);
  });

  it("L1: an empty q is treated as absent", () => {
    expect(wire({ q: "", status: ["closed"] })).toEqual([["f[status][]", "3"]]);
    expect(() => buildSearchParams({ q: "" })).toThrow(/Give q or at least one filter/);
  });

  it("I1 / Reports I6: years before 1970 are refused (FreeScout's own fallback date); leap days still checked", () => {
    for (const d of ["0000-01-01", "0099-01-01", "0004-02-29", "1969-12-31"]) expect(isStrictDate(d), d).toBe(false);
    expect(isStrictDate("1970-01-01")).toBe(true);
    expect(isStrictDate("2024-02-29")).toBe(true);
    expect(isStrictDate("2023-02-29")).toBe(false);
  });

  it("H2: FREESCOUT_STATS_DELAY_MS (default 200, 0 allowed) paces consecutive requests", async () => {
    const env = { FREESCOUT_URL: "https://x.test" };
    expect(DEFAULT_STATS_DELAY_MS).toBe(200);
    expect(loadBaseConfig(env).statsDelayMs).toBe(200);
    expect(loadBaseConfig({ ...env, FREESCOUT_STATS_DELAY_MS: "0" }).statsDelayMs).toBe(0);
    expect(loadBaseConfig({ ...env, FREESCOUT_STATS_DELAY_MS: "750" }).statsDelayMs).toBe(750);
    expect(loadBaseConfig({ ...env, FREESCOUT_STATS_DELAY_MS: "-5" }).statsDelayMs).toBe(200);
    const times: number[] = [];
    const { port } = stub((p) => {
      times.push(Date.now());
      return page(p);
    });
    await ticketVolume(port, { from: "2026-10-01", to: "2026-10-03" }, { delayMs: 40 });
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(35);
  });

  it("M1: a 200 page that is not a search result is an error, never a 0", async () => {
    const dash = stub("<html><body><h1>Dashboard</h1></body></html>", () => `${BASE}/`);
    const r = await tv(dash.port, { from: "2026-10-01", to: "2026-10-03" });
    expect(r).toMatchObject({ incomplete: true, buckets: [], totals: { total: 0 }, requests_made: 1 });
    expect(r.error).toMatch(/^FreeScoutError: unexpected page: the search ended at \/, not \/search/);
    await expect(searchConversations(dash.port, { status: ["active"] })).rejects.toThrow(/unexpected page/);
    await expect(listAssignees(dash.port)).rejects.toThrow(/unexpected page/);
    // On /search but with neither a table nor the empty-result block.
    const odd = stub('<html><body><select name="f[assigned]"></select><p>Module page</p></body></html>');
    await expect(searchConversations(odd.port, { status: ["active"] })).rejects.toThrow(/neither a results table nor an empty result/);
    // FreeScout under a sub-path is fine.
    const sub = stub(page, (p) => `https://x.test/helpdesk${p}`);
    expect((await tv(sub.port, { from: "2026-10-01", to: "2026-10-01" })).buckets).toEqual([
      { start: "2026-10-01", end: "2026-10-01", total: 0 },
    ]);
  });

  it("L2: a missing mailbox dropdown means unverified (null), not applied", async () => {
    const html = '<html><body><div class="empty-content">Nothing found</div></body></html>';
    const s = await searchConversations(stub(html).port, { status: ["active"], mailbox_id: 1 });
    expect(s.mailbox_filter_ignored).toBeNull();
    expect(s.note).toMatch(/Could not verify that FreeScout applied mailbox_id/);
    const r = await tv(stub(html).port, { from: "2026-10-01", to: "2026-10-01", mailbox_id: 1 });
    expect(r.mailbox_filter_ignored).toBeNull();
    expect(r.note).toMatch(/Could not verify/);
  });

  it("M3: a failure mid-run returns the finished buckets with incomplete, error and requests_made", async () => {
    let n = 0;
    const port: FreeScoutPort = {
      async getHtml(path: string): Promise<HtmlPage> {
        if (++n === 6) throw new FreeScoutError(`FreeScout /search returned HTTP 500 laravel_session=abcdefghijkl`, 500);
        return { $: cheerio.load(page(path)), url: new URL(path, BASE).toString(), status: 200 };
      },
      async ajaxPost<T>(): Promise<T> {
        throw new Error("no POST expected");
      },
    };
    const r = await tv(port, { from: "2026-10-01", to: "2026-10-05", breakdown: "status" });
    expect(r.incomplete).toBe(true);
    expect(r.requests_made).toBe(6);
    expect(r.buckets.map((b) => b.start)).toEqual(["2026-10-01"]);
    expect(r.error).toMatch(/^FreeScoutError: .*HTTP 500/);
    expect(r.error).not.toContain("abcdefghijkl");
    expect(r.note).toMatch(/^INCOMPLETE: a request failed after 6 of 20 planned requests.*1 of 5 bucket.*Do not retry the same call blindly/);
  });

  describe("against the fake FreeScout", () => {
    let fs: FakeFreeScout;
    let client: FreeScoutClient;
    const searches = () => fs.searchRequests.map((p) => p.toString());
    beforeEach(async () => {
      fs = new FakeFreeScout();
      await fs.start();
      client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
    });
    afterEach(async () => {
      await fs?.stop();
    });

    it('H1: the fake answers 500 to q="#N" with filters, and searchConversations never sends that shape', async () => {
      await expect(client.getHtml("/search?q=%239&f%5Bstatus%5D%5B%5D=1")).rejects.toThrow(/HTTP 500/);
      fs.searchRequests = [];
      const r = await searchConversations(client, { q: "#9", status: ["active"] });
      expect(r.conversations.map((c) => c.id)).toEqual([9]);
      expect(r.note).toBe("searched by conversation number");
      const m = await searchConversations(client, { q: "9", mailbox_id: 1 });
      expect(m.conversations.map((c) => c.id)).toEqual([9]);
      expect(searches()).toEqual(["f%5Bstatus%5D%5B%5D=1&f%5Bnumber%5D=9", "f%5Bmailbox%5D=1&f%5Bnumber%5D=9"]);
    });

    it("H3: ticket_volume counts published conversations only; search_conversations keeps FreeScout's default", async () => {
      fs.searchConvs.push(
        { id: 20, mailbox_id: 1, created_at: "2026-10-26 08:00", status: 1, user_id: null, subject: "deleted", state: 3 },
        { id: 21, mailbox_id: 1, created_at: "2026-10-26 09:00", status: 1, user_id: 2, subject: "draft", state: 1 },
      );
      const r = await tv(client, { from: "2026-10-26", to: "2026-10-26" });
      expect(r.buckets[0]!.total).toBe(4);
      expect(r.filters).toEqual({ state: ["published"] });
      expect(r.note).toMatch(/published conversations \(deleted and draft excluded\)/);
      expect(searches()[0]).toContain("f%5Bstate%5D%5B%5D=2");
      expect((await searchConversations(client, { after: "2026-10-26", before: "2026-10-26" })).total).toBe(6);
      expect((await searchConversations(client, { after: "2026-10-26", before: "2026-10-26", state: ["published"] })).total).toBe(4);
    });

    it("M2: a server-forced assigned filter is reported, and the assignee breakdown is flagged, not clamped", async () => {
      fs.searchForceAssigned = 2;
      const s = await searchConversations(client, { assigned: "unassigned" });
      expect(s.assigned_filter_forced).toBe(2);
      expect(s.note).toMatch(/FreeScout applied assigned=2 instead of the requested assignee filter/);
      const none = await searchConversations(client, { after: "2026-10-01" });
      expect(none.assigned_filter_forced).toBe(2);
      const r = await tv(client, { from: "2026-10-25", to: "2026-10-26", breakdown: "assignee" });
      // Every request is forced to user 2: total 1, "2" 1, unassigned 1 -> sum 2 > total 1 on both days.
      expect(r.buckets).toEqual([
        { start: "2026-10-25", end: "2026-10-25", total: 1, by: { "2": 1, unassigned: 1 }, inconsistent: true, note: expect.stringMatching(/add up to more than the bucket total/) },
        { start: "2026-10-26", end: "2026-10-26", total: 1, by: { "2": 1, unassigned: 1 }, inconsistent: true, note: expect.any(String) },
      ]);
      expect(r.totals.by).toEqual({ "2": 2, unassigned: 2, other: 0 });
      expect(r.assigned_filter_forced).toBe(2);
      expect(r.note).toMatch(/inconsistent/);
    });

    it("M2: no false positives (requested value selected, or an id missing from the dropdown)", async () => {
      const u = await searchConversations(client, { assigned: "unassigned" });
      expect(u.assigned_filter_forced).toBeUndefined();
      const a = await searchConversations(client, { assigned: 2 });
      expect(a.assigned_filter_forced).toBeUndefined();
      const admin = await searchConversations(client, { assigned: 1 });
      expect(admin.assigned_filter_forced).toBeUndefined();
      expect(admin.conversations.map((c) => c.id).sort()).toEqual([6, 8]);
      const real = await searchConversations(
        stub(raw("search-assigned-unassigned.html"), (p) => `${BASE}${p}`).port,
        { assigned: "unassigned" },
      );
      expect(real.assigned_filter_forced).toBeUndefined();
      const realForced = await searchConversations(stub(raw("search-assigned-unassigned.html"), (p) => `${BASE}${p}`).port, {
        assigned: 2,
      });
      expect(realForced.assigned_filter_forced).toBe("unassigned");
    });
  });
});

describe("search parity (2026-10-31): tag, following, number, id, attachment_name", () => {
  const wire = (o: Parameters<typeof buildSearchParams>[0]) => [...buildSearchParams(o).params.entries()];

  it("wire names and order; existing filters keep their place", () => {
    expect(wire({ tag: " billing ", following: true, id: 12, attachment_name: " invoice 7.pdf ", number: 7 })).toEqual([
      ["f[tag]", "billing"],
      ["f[following]", "yes"],
      ["f[id]", "12"],
      ["f[attachment name]", "invoice 7.pdf"],
      ["f[number]", "7"],
    ]);
    // Same encoding a browser GET form submit produces (application/x-www-form-urlencoded: space -> +).
    expect(buildSearchParams({ attachment_name: "a b" }).params.toString()).toBe("f%5Battachment+name%5D=a+b");
    expect(buildSearchParams({ tag: "Charts & Graphs" }).params.toString()).toBe("f%5Btag%5D=Charts+%26+Graphs");
    expect(wire({ q: "x", status: ["closed"], subject: "s", tag: "t", page: 3 })).toEqual([
      ["q", "x"],
      ["f[status][]", "3"],
      ["f[subject]", "s"],
      ["f[tag]", "t"],
      ["page", "3"],
    ]);
    expect(buildSearchParams({ tag: "t", following: true, id: 3, attachment_name: "a", number: 4 }).filters).toEqual({
      tag: "t",
      following: true,
      id: 3,
      attachment_name: "a",
      number: 4,
    });
  });

  it("each new filter alone satisfies the q-or-filter guard", () => {
    for (const o of [{ tag: "t" }, { following: true as const }, { number: 5 }, { id: 5 }, { attachment_name: "a" }]) {
      expect(() => buildSearchParams(o)).not.toThrow();
    }
    expect(() => buildSearchParams({})).toThrow(/tag, following, number, id, attachment_name/);
  });

  it("rejects bad values before any request", () => {
    expect(() => buildSearchParams({ following: false as never })).toThrow(/following/);
    expect(() => buildSearchParams({ number: 0 })).toThrow(/number/);
    expect(() => buildSearchParams({ number: 1.5 })).toThrow(/number/);
    expect(() => buildSearchParams({ id: -1 })).toThrow(/id must/);
    expect(() => buildSearchParams({ tag: "  " })).toThrow(/tag must/);
    expect(() => buildSearchParams({ tag: "x".repeat(101) })).toThrow(/tag must/);
    expect(() => buildSearchParams({ attachment_name: "" })).toThrow(/attachment_name must/);
    expect(() => buildSearchParams({ attachment_name: "x".repeat(201) })).toThrow(/attachment_name must/);
  });

  it("number and a numeric q: one f[number], never q plus a filter; conflicting numbers are refused", () => {
    expect(wire({ number: 9 })).toEqual([["f[number]", "9"]]);
    expect(wire({ q: "#9", number: 9 })).toEqual([["f[number]", "9"]]);
    expect(buildSearchParams({ q: "#9", number: 9 })).toMatchObject({ byNumber: true, filters: { number: 9 } });
    expect(wire({ q: "9", number: 9, status: ["active"] })).toEqual([["f[status][]", "1"], ["f[number]", "9"]]);
    expect(() => buildSearchParams({ q: "#8", number: 9 })).toThrow(/conflicts with number/);
    // Text q with an explicit number is a normal filtered text search.
    expect(wire({ q: "refund", number: 9 })).toEqual([["q", "refund"], ["f[number]", "9"]]);
    expect(buildSearchParams({ q: "refund", number: 9 }).byNumber).toBe(false);
  });

  it("numbers above 2^53 - 1 are refused, never rounded; a long numeric q alone stays exact text", () => {
    const big = "12345678901234567890"; // Number(big) rounds to ...7168
    expect(() => buildSearchParams({ q: big, mailbox_id: 1 })).toThrow(/too large for a conversation number/);
    expect(() => buildSearchParams({ q: `#${big}`, status: ["active"] })).toThrow(/too large/);
    expect(() => buildSearchParams({ q: big, number: 5 })).toThrow(/too large/);
    expect(() => buildSearchParams({ number: 2 ** 53 })).toThrow(/number must be a positive integer up to 9007199254740991/);
    expect(() => buildSearchParams({ id: 1.2e19 })).toThrow(/id must be a positive integer/);
    expect(() => buildSearchParams({ customer_id: 2 ** 60 })).toThrow(/customer_id/);
    expect(wire({ number: Number.MAX_SAFE_INTEGER })).toEqual([["f[number]", "9007199254740991"]]);
    expect(wire({ q: big })).toEqual([["q", big]]);
  });

  describe("against the fake FreeScout", () => {
    let fs: FakeFreeScout;
    let client: FreeScoutClient;
    const searches = () => fs.searchRequests.map((p) => p.toString());
    beforeEach(async () => {
      fs = new FakeFreeScout();
      await fs.start();
      client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
      const conv = (id: number) => fs.searchConvs.find((c) => c.id === id)!;
      conv(2).tags = ["billing", "vip"];
      conv(9).tags = ["billing"];
      conv(4).following = true;
      conv(3).attachment_names = ["Invoice-2026.pdf"];
    });
    afterEach(async () => {
      await fs?.stop();
    });

    it("each new key is sent exactly once, and rows come back with tags and clean subjects", async () => {
      const t = await searchConversations(client, { tag: "billing" });
      expect(t.conversations.map((c) => [c.id, c.subject, c.tags])).toEqual([
        [9, "Fake subject 9", ["billing"]],
        [2, "Fake subject 2", ["billing", "vip"]],
      ]);
      expect(t.filters).toEqual({ tag: "billing" });
      expect((await searchConversations(client, { following: true })).conversations.map((c) => c.id)).toEqual([4]);
      expect((await searchConversations(client, { id: 7 })).conversations.map((c) => c.id)).toEqual([7]);
      expect((await searchConversations(client, { attachment_name: "invoice" })).conversations.map((c) => c.id)).toEqual([3]);
      expect((await searchConversations(client, { number: 5, status: ["closed"] })).conversations.map((c) => c.id)).toEqual([5]);
      expect(searches()).toEqual([
        "f%5Btag%5D=billing",
        "f%5Bfollowing%5D=yes",
        "f%5Bid%5D=7",
        "f%5Battachment+name%5D=invoice",
        "f%5Bstatus%5D%5B%5D=3&f%5Bnumber%5D=5",
      ]);
      for (const q of fs.searchRequests) {
        for (const k of new Set(q.keys())) if (!k.endsWith("[]")) expect(q.getAll(k), k).toHaveLength(1);
      }
    });

    it("a module filter the install does not offer is reported, never silently treated as applied", async () => {
      const ok = await searchConversations(client, { tag: "billing", attachment_name: "x" });
      expect(ok.unsupported_filters).toBeUndefined();
      expect(ok.unverified_filters).toBeUndefined();
      fs.searchFilterNames = [...CORE_SEARCH_FILTERS]; // like the demo: no Tags module
      const r = await searchConversations(client, { tag: "billing", status: ["active"] });
      expect(r.unsupported_filters).toEqual(["tag"]);
      expect(r.note).toMatch(/does not offer tag .*NOT filtered by it/);
      // Core filters the page offers are not flagged.
      expect((await searchConversations(client, { following: true, id: 4 })).unsupported_filters).toBeUndefined();
      // following/id/number are checked too: a search page without them (older install) is reported.
      fs.searchFilterNames = CORE_SEARCH_FILTERS.filter((n) => !["following", "id", "number"].includes(n));
      const old = await searchConversations(client, { following: true, id: 4, number: 4 });
      expect(old.unsupported_filters).toEqual(["following", "id", "number"]);
      expect(old.note).toMatch(/does not offer following, id, number \(older FreeScout version\).*NOT filtered/);
      const mixed = await searchConversations(client, { tag: "billing", id: 4 });
      expect(mixed.note).toMatch(/\(module not installed or older FreeScout version\)/);
    });

    it("ticket_volume requests are unchanged by the new filters", async () => {
      await tv(client, { from: "2026-10-26", to: "2026-10-26", assigned: 2, mailbox_id: 1 });
      expect(searches()).toEqual([`f%5Bassigned%5D=2&f%5Bmailbox%5D=1&${ST}&f%5Bafter%5D=2026-10-26&f%5Bbefore%5D=2026-10-26`]);
    });
  });
});
