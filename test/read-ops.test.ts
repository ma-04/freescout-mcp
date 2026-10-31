import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import type { FreeScoutPort, HtmlPage } from "../src/client.js";
import { PermissionError } from "../src/errors.js";
import { capThreads, getCustomer, listConversations, searchConversations } from "../src/operations.js";
import type { ParsedConversation, ParsedThread } from "../src/parsers/conversation.js";

const BASE = "https://freescout.example.com";
const raw = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");

const SEARCH = raw("search-customers-carlos.html"); // one card: Carlos Mendes, carlos.mendes@tidepool.example
const CUSTOMER = raw("customer-9.html");
const EDIT = raw("customer-9-edit.html");
const EDIT_WITH_ALIAS = EDIT.replace(
  /(<input type="email"[^>]*name="emails\[\]" value="carlos\.mendes@tidepool\.example"[^>]*>)/,
  '$1<input type="email" name="emails[]" value="billing@tidepool.example">',
);

function customerPort(edit: string | Error): FreeScoutPort {
  return {
    async getHtml(path: string): Promise<HtmlPage> {
      let html: string;
      if (path.startsWith("/search")) html = SEARCH;
      else if (path === "/customers/9/") html = CUSTOMER;
      else if (path === "/customers/9/edit") {
        if (edit instanceof Error) throw edit;
        html = edit;
      } else throw new Error(`unexpected GET ${path}`);
      return { $: cheerio.load(html), url: new URL(path, BASE).toString(), status: 200 };
    },
    async ajaxPost<T>(): Promise<T> {
      throw new Error("no ajax expected");
    },
  };
}

describe("getCustomer by email", () => {
  it("returns the customer whose card email matches exactly (case-insensitive)", async () => {
    const r = await getCustomer(customerPort(EDIT), "Carlos.Mendes@tidepool.example");
    expect(r.id).toBe(9);
  });

  it("does not return a different customer when the only search hit is a fuzzy match", async () => {
    await expect(getCustomer(customerPort(EDIT), "mendes@tidepool.example")).rejects.toThrow(/No customer found/);
    await expect(getCustomer(customerPort(new PermissionError("denied")), "mendes@tidepool.example")).rejects.toThrow(
      /No customer found/,
    );
  });

  it("accepts a single hit whose profile lists the email as a secondary address", async () => {
    const r = await getCustomer(customerPort(EDIT_WITH_ALIAS), "billing@tidepool.example");
    expect(r.id).toBe(9);
    expect(r.profile?.emails).toContain("billing@tidepool.example");
  });
});

describe("capThreads", () => {
  it("keeps the newest N threads, oldest first, and reports the total", () => {
    const t = (id: number) => ({ thread_id: id }) as unknown as ParsedThread;
    const conv = { id: 1, threads: [t(1), t(2), t(3), t(4), t(5)] } as unknown as ParsedConversation;
    const cut = capThreads(conv, 3);
    expect(cut.threads.map((x) => x.thread_id)).toEqual([3, 4, 5]);
    expect(cut.total_threads).toBe(5);
    expect(cut.threads_truncated).toBe(true);
    const all = capThreads(conv, 50);
    expect(all.threads.map((x) => x.thread_id)).toEqual([1, 2, 3, 4, 5]);
    expect(all.threads_truncated).toBe(false);
    expect(all.total_threads).toBe(5);
  });
});

describe("searchConversations single-match redirect", () => {
  it("previews the latest customer/agent message, not an internal note", async () => {
    const $ = cheerio.load(raw("conversation-9.html"));
    $("#conv-layout-main").prepend(
      `<div class="thread thread-type-note" id="thread-99" data-thread_id="99"><div class="thread-message"><div class="thread-header"><div class="thread-title"><div class="thread-person"><strong><a href="${BASE}/users/profile/2">you</a></strong></div></div></div><div class="thread-body"><div class="thread-content"><p>INTERNAL: customer is on the churn list</p></div></div></div></div>`,
    );
    const port = {
      async getHtml(): Promise<HtmlPage> {
        return { $, url: `${BASE}/conversation/9?folder_id=17`, status: 200 };
      },
      async ajaxPost() {
        throw new Error("unused");
      },
    } as unknown as FreeScoutPort;
    const r = await searchConversations(port, "#9");
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]!.preview).toBeTruthy();
    expect(r.conversations[0]!.preview).not.toMatch(/INTERNAL|churn/);
  });
});

describe("tags in conversation rows reach every tool that lists rows", () => {
  const CUSTOMER_TAGGED = CUSTOMER.replace(
    /(<td class="conv-subject">[\s\S]*?<p>)(\s*Dashboard charts)/,
    '$1<span class="conv-tags"><span class="tag tag-c-0" data-tag-url="' + BASE + '/search?f%5Btag%5D=safari">safari</span> ' +
      '<span class="tag tag-c-1" data-tag-url="' + BASE + '/search?f%5Btag%5D=vip">vip</span></span>&nbsp;$2',
  );
  const page = (path: string, html: string): HtmlPage => ({ $: cheerio.load(html), url: new URL(path, BASE).toString(), status: 200 });
  const port = (routes: Record<string, string>): FreeScoutPort => ({
    async getHtml(path: string) {
      const html = routes[path];
      if (html === undefined) throw new Error(`unexpected GET ${path}`);
      return page(path, html);
    },
    async ajaxPost<T>(): Promise<T> {
      throw new Error("no ajax expected");
    },
  });

  it("get_customer.conversations: subject without the tag names, tags separately", async () => {
    expect(CUSTOMER_TAGGED).not.toBe(CUSTOMER);
    const r = await getCustomer(port({ "/customers/9/": CUSTOMER_TAGGED, "/customers/9/edit": EDIT }), 9);
    expect(r.conversations[0]).toMatchObject({ id: 9, subject: "Dashboard charts not loading in Safari 18", tags: ["safari", "vip"] });
  });

  it("list_conversations rows carry tags (production markup)", async () => {
    const r = await listConversations(port({ "/mailbox/1/12": raw("search-results-tags.html") }), 1, 12);
    expect(r.conversations.map((c) => [c.subject, c.tags])).toContainEqual(["Subject two", ["tag-alpha", "tag-beta"]]);
  });

  it("search_conversations: table rows and the single-match redirect both carry tags", async () => {
    const t = await searchConversations(port({ "/search?q=resize": raw("search-results-tags.html") }), "resize");
    expect(t.conversations.find((c) => c.id === 1004)).toMatchObject({ subject: "Subject four", tags: ["tag-delta", "tag-epsilon", "tag-zeta"] });
    const redirect: FreeScoutPort = {
      async getHtml() {
        return { $: cheerio.load(raw("conversation-9-tags.html")), url: `${BASE}/conversation/9?folder_id=17`, status: 200 };
      },
      async ajaxPost<T>(): Promise<T> {
        throw new Error("unused");
      },
    };
    const one = await searchConversations(redirect, "#9");
    expect(one.conversations[0]!.tags).toEqual(["safari", "Charts & Graphs", "vip"]);
  });
});
