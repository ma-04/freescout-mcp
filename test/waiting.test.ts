/**
 * waiting_conversations (folder pages, oldest first) and customer_history (composition over get_customer).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { FreeScoutClient } from "../src/client.js";
import { silentLogger } from "../src/log.js";
import { Session } from "../src/session.js";
import { registerTools } from "../src/tools/index.js";
import type { FreeScoutPort, HtmlPage } from "../src/client.js";
import { PermissionError } from "../src/errors.js";
import { customerHistory } from "../src/operations.js";
import { WAITING_MAX_REQUESTS, parseWaitingAge, waitingConversations } from "../src/waiting.js";

const BASE = "https://freescout.example.com";
const NOW = new Date("2026-10-31T12:00:00Z");
const raw = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");

describe("parseWaitingAge (User::dateDiffForHumans labels)", () => {
  it("relative labels are floor bounds; dates older than 7 days carry timezone slack", () => {
    expect(parseWaitingAge("Just now", NOW)).toEqual({ min: 0, max: 1 / 60 });
    expect(parseWaitingAge("53 min ago", NOW)).toEqual({ min: 53 / 60, max: 54 / 60 });
    expect(parseWaitingAge("1 hour ago", NOW)).toEqual({ min: 1, max: 2 });
    expect(parseWaitingAge("5 hours ago", NOW)).toEqual({ min: 5, max: 6 });
    expect(parseWaitingAge("1 day ago", NOW)).toEqual({ min: 24, max: 48 });
    expect(parseWaitingAge("3 days ago", NOW)).toEqual({ min: 72, max: 96 });
    expect(parseWaitingAge("1 week ago", NOW)).toEqual({ min: 168, max: 192 });
    // FreeScout never shows "N weeks ago" for N > 1, but if it did the bounds must not be inverted.
    expect(parseWaitingAge("2 weeks ago", NOW)).toEqual({ min: 336, max: 504 });
    expect(parseWaitingAge("3 weeks ago", NOW)).toEqual({ min: 504, max: 672 });
    // Oct 12 00:00 UTC is 468 h before NOW; the label's day is in an unknown timezone.
    expect(parseWaitingAge("Oct 12", NOW)).toEqual({ min: 444 - 14, max: 468 + 14 });
    expect(parseWaitingAge("Oct 30", NOW)!.min).toBe(192); // never less than the 8 days FreeScout needs to show a date
    expect(parseWaitingAge("Dec 20", NOW)!.min).toBeGreaterThan(24 * 300); // last year
    expect(parseWaitingAge("Dec 20, 2024", NOW)!.min).toBeGreaterThan(24 * 600);
    for (const bad of [null, "", "hace 2 días", "yesterday", "Foo 12"]) expect(parseWaitingAge(bad, NOW)).toBeNull();
  });
});

type Row = { id: number; rel: string; by: "Customer" | "User"; active?: boolean };

function folderPage(mailbox: number, current: number, rows: Row[], opts: { next?: boolean; order?: string; folders?: Array<[number, string]> } = {}): string {
  const folders = opts.folders ?? [
    [11, "folder-open"],
    [12, "hand-right"],
    [13, "user"],
  ];
  const side = `<ul id="folders">${folders
    .map(([id, icon]) => `<li class="${icon}${id === current ? " active" : ""}" data-folder_id="${id}"><a href="${BASE}/mailbox/${mailbox}/${id}"><span class="folder-name">F${id}</span></a></li>`)
    .join("")}</ul>`;
  const trs = rows
    .map(
      (r) =>
        `<tr class="conv-row${r.active === false ? "" : " conv-active"}" data-conversation_id="${r.id}"><td class="conv-subject"><a href="/conversation/${r.id}"><p>S${r.id}</p></a></td>` +
        `<td class="conv-date"><a title="Last reply by ${r.by}&lt;br/&gt;Oct 1, 2026 10:00">${r.rel}</a></td></tr>`,
    )
    .join("");
  const pager = opts.next ? `<a class="pager-next" data-page="2"></a><a class="pager-last" data-page="9"></a>` : "";
  return `<html><body>${side}<table class="table-conversations" data-page="1" data-sorting_order="${opts.order ?? "asc"}"><tbody>${trs}</tbody><tfoot><tr><td>${pager}</td></tr></tfoot></table></body></html>`;
}

function port(routes: Record<string, string | Error>) {
  const paths: string[] = [];
  const p: FreeScoutPort = {
    async getHtml(path: string): Promise<HtmlPage> {
      paths.push(path);
      const r = routes[path.replace(/\?.*page=(\d+).*/, "?page=$1").replace(/\?sorting.*$/, "")];
      if (r === undefined) throw new Error(`unexpected GET ${path}`);
      if (r instanceof Error) throw r;
      return { $: cheerio.load(r), url: new URL(path, BASE).toString(), status: 200 };
    },
    async ajaxPost<T>(): Promise<T> {
      throw new Error("no POST expected");
    },
  };
  return { port: p, paths };
}

describe("waitingConversations", () => {
  it("keeps active rows last answered by the customer, oldest first; borderline separate; others counted", async () => {
    const { port: p, paths } = port({
      "/mailbox/1": folderPage(1, 11, []),
      "/mailbox/1/11": folderPage(1, 11, [
        { id: 1, rel: "Oct 12", by: "Customer" },
        { id: 2, rel: "3 days ago", by: "User" },
        { id: 3, rel: "2 days ago", by: "Customer", active: false },
        { id: 4, rel: "1 day ago", by: "Customer" },
        { id: 5, rel: "3 hours ago", by: "Customer" },
      ]),
      "/mailbox/1/12": folderPage(1, 12, [{ id: 6, rel: "2 days ago", by: "Customer" }]),
      "/mailbox/1/13": folderPage(1, 13, [{ id: 6, rel: "2 days ago", by: "Customer" }, { id: 7, rel: "?", by: "Customer" }]),
    });
    const r = await waitingConversations(p, { mailbox_id: 1, older_than_hours: 30 }, NOW);
    expect(r.conversations.map((c) => [c.id, c.folder, c.waiting_hours])).toEqual([
      [1, "unassigned", 430],
      [6, "mine", 48],
    ]);
    expect(r.borderline.map((c) => [c.id, c.waiting_hours, c.waiting_hours_max])).toEqual([[4, 24, 48]]);
    expect(r.counts).toEqual({ waiting: 2, borderline: 1, rows_read: 8, not_active: 1, last_reply_by_user: 1, unreadable_age: 1 });
    expect(r.truncated).toBe(false);
    expect(r.requests_made).toBe(4);
    expect(paths.slice(1)).toEqual([11, 12, 13].map((f) => `/mailbox/1/${f}?sorting%5Bsort_by%5D=date&sorting%5Border%5D=asc`));
    expect(r.note).toMatch(/viewing user's timezone/);
    expect(r.note).toMatch(/1 active row\(s\) could not be classified.*English UI/);
    expect(r.mailboxes_skipped).toEqual([]);
  });

  it("a non-English UI is not a silent empty result: every row is unreadable and the note says why", async () => {
    const { port: p } = port({
      "/mailbox/1": folderPage(1, 11, [], { folders: [[11, "folder-open"]] }),
      "/mailbox/1/11": folderPage(1, 11, [{ id: 1, rel: "hace 3 días", by: "Customer" }, { id: 2, rel: "il y a 2 jours", by: "Customer" }], { folders: [[11, "folder-open"]] }),
    });
    const r = await waitingConversations(p, { mailbox_id: 1 }, NOW);
    expect(r.conversations).toEqual([]);
    expect(r.counts.unreadable_age).toBe(2);
    expect(r.note).toMatch(/2 active row\(s\) could not be classified.*English UI/);
  });

  it("rows out of oldest-first order clear sorted_oldest_first and disable the early stop", async () => {
    const fo: Array<[number, string]> = [[11, "folder-open"]];
    const { port: p, paths } = port({
      "/mailbox/1": folderPage(1, 11, [], { folders: fo }),
      // data-sorting_order says asc, but a 5-day wait follows a 2-hour one (newest first): the order is not applied.
      "/mailbox/1/11": folderPage(1, 11, [{ id: 1, rel: "2 hours ago", by: "Customer" }, { id: 2, rel: "5 days ago", by: "Customer" }, { id: 3, rel: "1 hour ago", by: "Customer" }], { next: true, folders: fo }),
      "/mailbox/1/11?page=2": folderPage(1, 11, [{ id: 4, rel: "6 days ago", by: "Customer" }], { folders: fo }),
    });
    const r = await waitingConversations(p, { mailbox_id: 1 }, NOW);
    expect(r.folders_read[0]!.sorted_oldest_first).toBe(false);
    expect(paths).toHaveLength(3); // page 2 was still read although page 1 ended under the threshold
    expect(r.conversations.map((c) => c.id)).toEqual([4, 2]);
    expect(r.note).toMatch(/not in oldest-first order/);
    expect(r.note).not.toMatch(/did not apply the oldest-first sorting/);

    // Equal labels overlap and are not a violation; neither is the order carried across a page break when it holds.
    const ok = port({
      "/mailbox/1": folderPage(1, 11, [], { folders: fo }),
      "/mailbox/1/11": folderPage(1, 11, [{ id: 1, rel: "1 day ago", by: "Customer" }, { id: 2, rel: "1 day ago", by: "Customer" }], { next: true, folders: fo }),
      "/mailbox/1/11?page=2": folderPage(1, 11, [{ id: 3, rel: "2 hours ago", by: "Customer" }], { folders: fo }),
    });
    const o = await waitingConversations(ok.port, { mailbox_id: 1 }, NOW);
    expect(o.folders_read[0]!.sorted_oldest_first).toBe(true);
    expect(o.note).not.toMatch(/oldest-first/);
  });

  it(`never makes more than ${WAITING_MAX_REQUESTS} requests and then reports truncated`, async () => {
    const mailboxes = [1, 2, 3];
    const routes: Record<string, string> = {
      "/": mailboxes.map((m) => `<div class="dash-card" data-mailbox-id="${m}"><a class="mailbox-name" href="${BASE}/mailbox/${m}">M${m}</a></div>`).join(""),
    };
    let id = 0;
    for (const m of mailboxes) {
      routes[`/mailbox/${m}`] = folderPage(m, 11, []);
      for (const f of [11, 12, 13]) {
        // Every page is full of old waits and has a next page: 1 + 3 x (1 + 3 x 5) = 49 GETs without the cap.
        routes[`/mailbox/${m}/${f}`] = folderPage(m, f, [{ id: ++id, rel: "5 days ago", by: "Customer" }], { next: true });
        for (let pg = 2; pg <= 5; pg++) routes[`/mailbox/${m}/${f}?page=${pg}`] = folderPage(m, f, [{ id: ++id, rel: "5 days ago", by: "Customer" }], { next: true });
      }
    }
    const { port: p, paths } = port(routes);
    const r = await waitingConversations(p, {}, NOW);
    expect(r.requests_made).toBe(WAITING_MAX_REQUESTS);
    expect(paths).toHaveLength(WAITING_MAX_REQUESTS);
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/Not every page was read/);
  });

  it("stops paging once a page ends newer than the threshold, and caps pages", async () => {
    const old = (id: number): Row => ({ id, rel: "5 days ago", by: "Customer" });
    const { port: p, paths } = port({
      "/mailbox/1": folderPage(1, 11, [], { folders: [[11, "folder-open"]] }),
      "/mailbox/1/11": folderPage(1, 11, [old(1), { id: 2, rel: "2 hours ago", by: "Customer" }], { next: true, folders: [[11, "folder-open"]] }),
    });
    const r = await waitingConversations(p, { mailbox_id: 1 }, NOW);
    expect(r.conversations.map((c) => c.id)).toEqual([1]);
    expect(paths).toHaveLength(2);
    expect(r.truncated).toBe(false);
    expect(r.folders_missing.map((f) => f.folder)).toEqual(["mine", "assigned"]);

    const all = port({
      "/mailbox/1": folderPage(1, 11, [], { folders: [[11, "folder-open"]] }),
      "/mailbox/1/11": folderPage(1, 11, [old(1)], { next: true, folders: [[11, "folder-open"]] }),
      "/mailbox/1/11?page=2": folderPage(1, 11, [old(2)], { next: true, folders: [[11, "folder-open"]] }),
    });
    const c = await waitingConversations(all.port, { mailbox_id: 1, max_pages: 2 }, NOW);
    expect(c.conversations.map((x) => x.id)).toEqual([1, 2]);
    expect(c.truncated).toBe(true);
    expect(c.note).toMatch(/Not every page was read/);
    expect(all.paths[2]).toBe("/mailbox/1/11?sorting%5Bsort_by%5D=date&sorting%5Border%5D=asc&page=2");
  });

  it("flags an ignored sort order, skips forbidden mailboxes when scanning all, and validates input", async () => {
    const { port: p } = port({
      "/": `<div class="dash-card" data-mailbox-id="1"><a class="mailbox-name" href="${BASE}/mailbox/1">A</a></div><div class="dash-card" data-mailbox-id="2"><a class="mailbox-name" href="${BASE}/mailbox/2">B</a></div>`,
      "/mailbox/1": folderPage(1, 11, [], { folders: [[11, "folder-open"]] }),
      "/mailbox/1/11": folderPage(1, 11, [{ id: 1, rel: "3 days ago", by: "Customer" }], { order: "desc", folders: [[11, "folder-open"]] }),
      "/mailbox/2": new PermissionError("no"),
    });
    const r = await waitingConversations(p, {}, NOW);
    expect(r.conversations.map((c) => c.id)).toEqual([1]);
    expect(r.mailboxes_skipped).toEqual([{ mailbox_id: 2, reason: expect.stringMatching(/^no permission/) }]);
    expect(r.note).toMatch(/Skipped mailbox\(es\) 2 /);
    expect(r.folders_read[0]!.sorted_oldest_first).toBe(false);
    expect(r.note).toMatch(/did not apply the oldest-first sorting/);
    await expect(waitingConversations(p, { max_pages: 6 }, NOW)).rejects.toThrow(/max_pages/);
    await expect(waitingConversations(p, { older_than_hours: -1 }, NOW)).rejects.toThrow(/older_than_hours/);
    await expect(waitingConversations(p, { mailbox_id: 2 ** 60 }, NOW)).rejects.toThrow(/mailbox_id/);
    await expect(waitingConversations(port({ "/mailbox/2": new PermissionError("no") }).port, { mailbox_id: 2 }, NOW)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("customerHistory", () => {
  it("compact rows, counts by status, completeness from the page total", async () => {
    const pages: Record<string, string> = { "/customers/9/": raw("customer-9.html"), "/customers/9/edit": raw("customer-9-edit.html") };
    const p: FreeScoutPort = {
      async getHtml(path: string) {
        if (!(path in pages)) throw new Error(`unexpected GET ${path}`);
        return { $: cheerio.load(pages[path]!), url: `${BASE}${path}`, status: 200 };
      },
      async ajaxPost<T>(): Promise<T> {
        throw new Error("no POST expected");
      },
    };
    const h = await customerHistory(p, 9);
    expect(h.customer).toMatchObject({ id: 9, name: "Carlos Mendes" });
    expect(h.conversations).toEqual([
      expect.objectContaining({ id: 9, number: 9, subject: "Dashboard charts not loading in Safari 18", status: "active", assignee: "Demo Agent", tags: [] }),
    ]);
    expect(Object.keys(h.conversations[0]!).sort()).toEqual(["assignee", "id", "last_activity", "number", "status", "subject", "tags"]);
    expect(h.by_status).toEqual({ active: 1, pending: 0, closed: 0, spam: 0, unknown: 0 });
    expect(h).toMatchObject({ listed: 1, conversations_total: 1, complete: true });
    const cut = await customerHistory(
      { ...p, getHtml: async (path: string) => ({ ...(await p.getHtml(path)), $: cheerio.load(pages[path]!.replace("<strong>1</strong>", "<strong>7</strong>")) }) },
      9,
    );
    expect(cut.complete).toBe(false);
    expect(cut.note).toMatch(/Only 1 of 7 .*customer_id/);
    // No total on the page: never "Only N of an unknown number".
    const withPage = (html: string): FreeScoutPort => ({
      ...p,
      getHtml: async (path: string) => ({ ...(await p.getHtml(path)), $: cheerio.load(path.endsWith("/edit") ? pages[path]! : html) }),
    });
    const noTotal = await customerHistory(withPage(pages["/customers/9/"]!.replace(/<tfoot>[\s\S]*?<\/tfoot>/, "")), 9);
    expect(noTotal).toMatchObject({ listed: 1, conversations_total: null, complete: false });
    expect(noTotal.note).toMatch(/total could not be read, so 1 conversation\(s\) are listed and there may be more/);
    expect(noTotal.note).not.toMatch(/unknown number|Only/);
    const none = await customerHistory(withPage(pages["/customers/9/"]!.replace(/<tfoot>[\s\S]*?<\/tfoot>/, "").replace(/<tbody>[\s\S]*?<\/tbody>/, "<tbody></tbody>")), 9);
    expect(none).toMatchObject({ listed: 0, complete: false });
    expect(none.note).toMatch(/no conversations and no total/);
  });
});

describe("through the MCP tools", () => {
  it("waiting_conversations and customer_history run with schema defaults and reject bad input", async () => {
    const routes: Record<string, string> = {
      "/mailbox/1": folderPage(1, 11, [], { folders: [[11, "folder-open"]] }),
      "/mailbox/1/11": folderPage(1, 11, [{ id: 1, rel: "3 days ago", by: "Customer" }], { folders: [[11, "folder-open"]] }),
      "/customers/9/": raw("customer-9.html"),
      "/customers/9/edit": raw("customer-9-edit.html"),
    };
    const client = new FreeScoutClient(new Session({ baseUrl: "http://127.0.0.1:9", cookie: "laravel_session=x", logger: silentLogger, timeoutMs: 500 }));
    client.getHtml = async (path: string) => {
      const html = routes[path.replace(/\?.*$/, "")];
      if (html === undefined) throw new Error(`unexpected GET ${path}`);
      return { $: cheerio.load(html), url: `${BASE}${path}`, status: 200 };
    };
    client.ajaxPost = async () => {
      throw new Error("no POST expected");
    };
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { client, forwardAllow: [] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    try {
      const w = await mcp.callTool({ name: "waiting_conversations", arguments: { mailbox_id: 1 } });
      expect(w.isError).toBeFalsy();
      expect(w.structuredContent).toMatchObject({ older_than_hours: 24, conversations: [{ id: 1, waiting_hours: 72 }], content_notice: expect.any(String) });
      const h = await mcp.callTool({ name: "customer_history", arguments: { id: 9 } });
      expect(h.isError).toBeFalsy();
      expect(h.structuredContent).toMatchObject({ listed: 1, by_status: { active: 1 } });
      for (const [name, args] of [
        ["waiting_conversations", { max_pages: 6 }],
        ["waiting_conversations", { older_than_hours: -1 }],
        ["customer_history", {}],
      ] as const) {
        expect((await mcp.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
    } finally {
      await Promise.all([mcp.close(), server.close()]);
    }
  });
});
