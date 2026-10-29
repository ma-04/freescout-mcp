/**
 * list_tags and add_tag. The Tags module is a paid add-on that is NOT installed on the demo. The "module present"
 * pages below inject markup into real demo captures: conversation pages use the shape observed on a live install
 * (docs/freescout-endpoints.md §9, via convTagsMarkup); list chips are reconstructed from freescout-refresh v1.8.0.
 * All tag names and content are synthetic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";
import type { FreeScoutPort, HtmlPage } from "../src/client.js";
import { FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import {
  addTag,
  assertTagForm,
  assertTagRemoveForm,
  buildTagForm,
  buildTagRemoveForm,
  conversationTags,
  listTags,
  parseTagChips,
  removeTag,
  TAGS_AJAX,
  TAGS_UNAVAILABLE,
} from "../src/operations.js";
import { Session } from "../src/session.js";
import { convTagsMarkup, FakeFreeScout } from "./fake-freescout.js";

const BASE = "https://freescout.example.com";
const raw = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");
const DASHBOARD = raw("dashboard.html");
const MAILBOX = raw("mailbox-unassigned.html"); // mailbox 1 Unassigned, real capture, no Tags module
const CONV9 = raw("conversation-9.html");

/** Reconstructed list markup: chips in the subject cell of the row for conversation `id`. */
function withListTags(html: string, byConv: Record<number, string[]>): string {
  const $ = cheerio.load(html);
  for (const [id, tags] of Object.entries(byConv)) {
    const chips = tags
      .map((t, i) => `<span class="tag" data-tag-id="${10 * Number(id) + i}"><a class="tag-name" href="${BASE}/search?q=${encodeURIComponent(t)}">${t}</a></span>`)
      .join("");
    $(`tr.conv-row[data-conversation_id="${id}"] td.conv-subject`).prepend(`<div class="conv-tags">${chips}</div>`);
  }
  return $.html();
}

/** Conversation page with the module's toolbar control and #conv_tags chips in the observed markup. */
function withConvTags(html: string, tags: string[]): string {
  const $ = cheerio.load(html);
  const m = convTagsMarkup(BASE, tags);
  $(".conv-actions").first().append(m.control);
  $("#conv-subject").first().prepend(m.box);
  return $.html();
}

function port(routes: Record<string, string | Error>) {
  const gets: string[] = [];
  let posts = 0;
  const p: FreeScoutPort = {
    async getHtml(path: string): Promise<HtmlPage> {
      gets.push(path);
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?"));
      if (!key) throw new FreeScoutError(`FreeScout page not found: ${path}`, 404);
      const v = routes[key]!;
      if (v instanceof Error) throw v;
      return { $: cheerio.load(v), url: new URL(path, BASE).toString(), status: 200 };
    },
    async ajaxPost<T>(): Promise<T> {
      posts++;
      throw new Error("list_tags must not POST");
    },
  };
  return { port: p, gets, posts: () => posts };
}

describe("list_tags: module absent (real demo captures)", () => {
  it("returns available:false with the reason, after checking the mailbox list and one conversation", async () => {
    const { port: p, gets, posts } = port({ "/": DASHBOARD, "/mailbox/1": MAILBOX, "/conversation/1": raw("conversation-1-draft.html") });
    const r = await listTags(p, 1);
    expect(r).toEqual({ available: false, reason: TAGS_UNAVAILABLE, mailbox_ids: [1], query: null });
    expect(gets).toEqual(["/mailbox/1", "/conversation/1"]);
    expect(posts()).toBe(0);
  });

  it("without mailbox_id scans the dashboard's mailboxes and skips ones it cannot open", async () => {
    // Real dashboard (agent sees mailbox 1) plus a cloned card for a mailbox 2 that 403s.
    const dash = cheerio.load(DASHBOARD);
    const card = dash(".dash-card[data-mailbox-id='1']").first();
    card.after(card.clone().attr("data-mailbox-id", "2"));
    const { port: p, gets } = port({
      "/": dash.html(),
      "/mailbox/1": MAILBOX,
      "/mailbox/2": new PermissionError("HTTP 403"),
      "/conversation/1": CONV9,
    });
    const r = await listTags(p);
    expect(r).toMatchObject({ available: false, mailbox_ids: [1] });
    expect(gets).toEqual(["/", "/mailbox/1", "/mailbox/2", "/conversation/1"]);
  });

  it("an explicit mailbox the user cannot open is a PermissionError", async () => {
    const { port: p } = port({ "/mailbox/2": new PermissionError("FreeScout denied access to /mailbox/2 (HTTP 403)") });
    await expect(listTags(p, 2)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("list_tags: module present (reconstructed markup)", () => {
  it("collects tags from the list, de-duplicated case-insensitively, with counts, ids and links; no conversation fetch", async () => {
    const page = withListTags(MAILBOX, { 1: ["billing", "vip"], 4: ["VIP", "sso"], 7: ["billing"] });
    const { port: p, gets, posts } = port({ "/mailbox/1": page });
    const r = await listTags(p, 1);
    expect(r.available).toBe(true);
    expect(r.tags!.map((t) => [t.name, t.conversations_seen])).toEqual([
      ["billing", 2],
      ["sso", 1],
      ["vip", 2],
    ]);
    expect(r.tags![0]).toMatchObject({ id: 10, url: `${BASE}/search?q=billing` });
    expect(gets).toEqual(["/mailbox/1"]);
    expect(posts()).toBe(0);
  });

  it("q without a working autocomplete falls back to filtering the page scan case-insensitively", async () => {
    const page = withListTags(MAILBOX, { 1: ["billing", "vip"], 4: ["sso"] });
    const p = port({ "/mailbox/1": page });
    p.port.ajaxPost = async () => {
      throw new FreeScoutError("FreeScout /tags/ajax returned HTTP 404", 404);
    };
    const r = await listTags(p.port, 1, "  BILL ");
    expect(r.query).toBe("BILL");
    expect(r.tags!.map((t) => t.name)).toEqual(["billing"]);
    expect(r.source).toMatch(/first page/);
  });

  it("q uses the module's autocomplete (id = tag name), following pagination", async () => {
    const calls: Array<[string, unknown]> = [];
    const p: FreeScoutPort = {
      async getHtml() {
        throw new Error("no page fetch expected");
      },
      async ajaxPost<T>(path: string, form: unknown): Promise<T> {
        calls.push([path, form]);
        const page = (form as { page: string }).page;
        return (page === "1"
          ? { results: [{ id: "billing", text: "billing" }, { id: "Billing-EU", text: "Billing-EU" }], pagination: { more: true } }
          : { results: [{ id: "billing", text: "billing" }, { id: "rebill", text: "rebill" }], pagination: { more: false } }) as T;
      },
    };
    const r = await listTags(p, undefined, " bill ");
    expect(r).toMatchObject({ available: true, query: "bill", source: "Tags module autocomplete" });
    expect(r.tags).toEqual([
      { name: "billing", id: null, url: null, conversations_seen: null },
      { name: "Billing-EU", id: null, url: null, conversations_seen: null },
      { name: "rebill", id: null, url: null, conversations_seen: null },
    ]);
    expect(calls).toEqual([
      [TAGS_AJAX, { action: "autocomplete", q: "bill", page: "1" }],
      [TAGS_AJAX, { action: "autocomplete", q: "bill", page: "2" }],
    ]);
  });

  it("no chips on the list but the conversation shows the module: available, tags from #conv_tags without the × link", async () => {
    const { port: p, gets } = port({ "/mailbox/1": MAILBOX, "/conversation/1": withConvTags(CONV9, ["refund", "urgent"]) });
    const r = await listTags(p, 1);
    expect(r.available).toBe(true);
    expect(r.tags!.map((t) => t.name)).toEqual(["refund", "urgent"]);
    expect(r.source).toMatch(/conversation 1/);
    expect(gets).toEqual(["/mailbox/1", "/conversation/1"]);
  });

  it("module present with no tags at all: available with an empty list", async () => {
    const r = await listTags(port({ "/mailbox/1": MAILBOX, "/conversation/1": withConvTags(CONV9, []) }).port, 1);
    expect(r).toMatchObject({ available: true, tags: [] });
  });

  it("parseTagChips handles the .fs-tag variant and chips without a name element", () => {
    const $ = cheerio.load(
      '<div id="conv_tags"><span class="fs-tag" data-tag-id="7"><span class="fs-tag-name">a&amp;b</span></span><span class="tag">plain <a class="tag-remove">×</a></span><span class="tag"> </span></div>',
    );
    expect(parseTagChips($, "#conv_tags", BASE)).toEqual([
      { name: "a&b", id: 7, url: null },
      { name: "plain", id: null, url: null },
    ]);
  });
});

describe("parseTagChips: observed conversation markup", () => {
  const FIX = raw("conversation-9-tags.html"); // synthetic: demo capture + observed module markup, invented names
  it("reads names and search links from #conv_tags (tag-c-N chips, × remove links ignored, no ids exposed)", () => {
    const $ = cheerio.load(FIX);
    expect(parseTagChips($, "#conv_tags", BASE)).toEqual([
      { name: "safari", id: null, url: `${BASE}/search?f%5Btag%5D=safari` },
      { name: "Charts & Graphs", id: null, url: `${BASE}/search?f%5Btag%5D=Charts%20%26%20Graphs` },
      { name: "vip", id: null, url: `${BASE}/search?f%5Btag%5D=vip` },
    ]);
    expect(conversationTags({ $, url: BASE, status: 200 })).toEqual(["safari", "Charts & Graphs", "vip"]);
    // The add control's dropdown (#add-tag-wrap, select.tag-input) is not mistaken for a chip.
    expect($("#add-tag-wrap select.tag-input[multiple]").length).toBe(1);
  });
  it("module markup absent: null; module present with no tags: []", () => {
    expect(conversationTags({ $: cheerio.load(CONV9), url: BASE, status: 200 })).toBeNull();
    expect(conversationTags({ $: cheerio.load(withConvTags(CONV9, [])), url: BASE, status: 200 })).toEqual([]);
  });
});

describe("assertTagForm", () => {
  const ok = { action: "add", tag_names: ["vip", "billing"], conversation_id: "9" };
  it("accepts exactly {action:'add', conversation_id, tag_names}", () => {
    expect(() => assertTagForm(ok)).not.toThrow();
    expect(buildTagForm(9, ["vip"])).toEqual({ action: "add", tag_names: ["vip"], conversation_id: "9" });
  });
  it.each([
    ["conversation_id array (bulk tagging)", { ...ok, conversation_id: ["9", "10"] }, /array \(bulk/],
    ["conversation_id number", { ...ok, conversation_id: 9 }, /single positive integer/],
    ["conversation_id 0", { ...ok, conversation_id: "0" }, /single positive integer/],
    ["conversation_id with junk", { ...ok, conversation_id: "9&conversation_id[]=10" }, /single positive integer/],
    ["extra key", { ...ok, status: "3" }, /unexpected field status/],
    ["extra bracket key", { ...ok, "conversation_id[]": ["10"] }, /unexpected field conversation_id\[\]/],
    ["missing key", { action: "add", tag_names: ["vip"] }, /conversation_id missing/],
    ["remove action", { ...ok, action: "remove" }, /action is not 'add'/],
    ["tag_names not array", { ...ok, tag_names: "vip" }, /not an array/],
    ["no names", { ...ok, tag_names: [] }, /1\.\.10 entries/],
    ["11 names", { ...ok, tag_names: Array.from({ length: 11 }, (_, i) => `t${i}`) }, /1\.\.10 entries/],
    ["empty name", { ...ok, tag_names: [""] }, /1\.\.50 characters/],
    ["51-char name", { ...ok, tag_names: ["x".repeat(51)] }, /1\.\.50 characters/],
    ["comma", { ...ok, tag_names: ["a,b"] }, /comma/],
    ["untrimmed", { ...ok, tag_names: [" vip"] }, /not trimmed/],
    ["control char", { ...ok, tag_names: ["a\nb"] }, /control characters/],
    ["non-string name", { ...ok, tag_names: [5] }, /not a string/],
    ["duplicates (case-insensitive)", { ...ok, tag_names: ["vip", "VIP"] }, /duplicate/],
  ])("rejects %s", (_label, form, re) => {
    expect(() => assertTagForm(form)).toThrow(FreeScoutError);
    expect(() => assertTagForm(form)).toThrow(re);
  });
  it("rejects non-plain objects", () => {
    expect(() => assertTagForm(null)).toThrow(/not a plain object/);
    expect(() => assertTagForm([ok])).toThrow(/not a plain object/);
    expect(() => assertTagForm(Object.assign(Object.create({ evil: 1 }), ok))).toThrow(/not a plain object/);
  });
});

describe("tag form on the wire (real Session against the fake FreeScout)", () => {
  let fs: FakeFreeScout | undefined;
  afterEach(async () => {
    await fs?.stop();
    fs = undefined;
  });
  it("serialises tag_names as repeated tag_names[] entries and a single conversation_id", async () => {
    fs = new FakeFreeScout();
    await fs.start();
    fs.tags = ["billing"];
    const session = new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 });
    const res = await session.ajaxPost<{ status: string; tags: Array<{ name: string }> }>(TAGS_AJAX, buildTagForm(1, ["vip", "a b"]));
    expect(res.status).toBe("success");
    expect(res.tags.map((t) => t.name)).toEqual(["billing", "vip", "a b"]);
    expect(fs.tagPosts[0]!.filter(([k]) => k !== "_token")).toEqual([
      ["action", "add"],
      ["tag_names[]", "vip"],
      ["tag_names[]", "a b"],
      ["conversation_id", "1"],
    ]);
    expect(fs.requests.at(-1)).toMatchObject({ method: "POST", path: "/tags/ajax" });
  });
});

describe("addTag", () => {
  /** Stub FreeScout: conversation `id` page renders `state.tags`; tags/ajax POSTs go to `onPost`. */
  function tagPort(opts: { id?: number; html?: string; tags?: string[]; onPost?: (form: Record<string, unknown>, tags: string[]) => unknown; page?: Error }) {
    const id = opts.id ?? 9;
    const state = { tags: [...(opts.tags ?? [])], posts: [] as Array<[string, Record<string, unknown>]>, gets: 0 };
    const p: FreeScoutPort = {
      async getHtml(path: string): Promise<HtmlPage> {
        state.gets++;
        if (opts.page) throw opts.page;
        if (path !== `/conversation/${id}`) throw new FreeScoutError(`FreeScout page not found: ${path}`, 404);
        const html = opts.html ?? withConvTags(CONV9, state.tags);
        return { $: cheerio.load(html), url: `${BASE}/conversation/${id}?folder_id=17`, status: 200 };
      },
      async ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
        state.posts.push([path, form]);
        if (opts.onPost) return opts.onPost(form, state.tags) as T;
        for (const n of form.tag_names as string[]) state.tags.push(n);
        return { status: "success", tags: state.tags.map((name) => ({ name, url: `${BASE}/search?f%5Btag%5D=${name}` })) } as T;
      },
    };
    return { port: p, state };
  }

  it("drops names already present (case-insensitive, trimmed), posts only the rest once, and verifies", async () => {
    const { port: p, state } = tagPort({ tags: ["safari", "vip"] });
    const r = await addTag(p, 9, ["SAFARI", " new ", "New", "vip "]);
    expect(state.posts).toEqual([[TAGS_AJAX, { action: "add", tag_names: ["new"], conversation_id: "9" }]]);
    expect(r).toEqual({ conversation_id: 9, tags_before: ["safari", "vip"], tags_after: ["safari", "vip", "new"], added: ["new"], response_tags: ["safari", "vip", "new"] });
    expect(state.gets).toBe(2);
  });

  it("returns 'already tagged' without posting when every name is present", async () => {
    const { port: p, state } = tagPort({ tags: ["Safari"] });
    expect(await addTag(p, 9, ["safari"])).toEqual({ conversation_id: 9, added: [], tags_before: ["Safari"], tags_after: ["Safari"], note: "already tagged" });
    expect(state.posts).toEqual([]);
  });

  it("refuses invalid names before fetching or posting", async () => {
    const { port: p, state } = tagPort({});
    await expect(addTag(p, 9, ["a,b"])).rejects.toThrow(/comma/);
    await expect(addTag(p, 9, ["  "])).rejects.toThrow(/1\.\.50/);
    await expect(addTag(p, 9, Array.from({ length: 11 }, (_, i) => `t${i}`))).rejects.toThrow(/1\.\.10/);
    expect(state.gets + state.posts.length).toBe(0);
  });

  it("maps status:error to FreeScoutError with FreeScout's msg, and permission answers to PermissionError", async () => {
    const err = tagPort({ onPost: () => ({ status: "error", msg: "Tag name is too long" }) });
    await expect(addTag(err.port, 9, ["x"])).rejects.toThrow(/add_tag failed: Tag name is too long/);
    const perm = tagPort({ onPost: () => ({ status: "error", msg: "Not enough permissions" }) });
    await expect(addTag(perm.port, 9, ["x"])).rejects.toBeInstanceOf(PermissionError);
    const http403 = tagPort({
      onPost: () => {
        throw new PermissionError("FreeScout denied /tags/ajax (HTTP 403)");
      },
    });
    await expect(addTag(http403.port, 9, ["x"])).rejects.toBeInstanceOf(PermissionError);
    const page403 = tagPort({ page: new PermissionError("FreeScout denied access to /conversation/9 (HTTP 403)") });
    await expect(addTag(page403.port, 9, ["x"])).rejects.toBeInstanceOf(PermissionError);
    expect(page403.state.posts).toEqual([]);
  });

  it("post-verification throws loudly if a previous tag vanished", async () => {
    const { port: p } = tagPort({
      tags: ["safari", "vip"],
      onPost: (form, tags) => {
        tags.splice(0, tags.length, ...(form.tag_names as string[]), "vip"); // server "replaced" the set
        return { status: "success", tags: tags.map((name) => ({ name })) };
      },
    });
    await expect(addTag(p, 9, ["new"])).rejects.toThrow(/DANGER: .*lost tag\(s\) \["safari"\]/);
  });

  it("post-verification fails if a requested tag does not appear, with before/after detail", async () => {
    const { port: p } = tagPort({ tags: ["safari"], onPost: () => ({ status: "success", tags: [{ name: "safari" }] }) });
    await expect(addTag(p, 9, ["new"])).rejects.toThrow(/\["new"\] is not shown .*tags_after=\["safari"\]/);
  });

  it("refuses when the Tags module markup is absent (nothing posted)", async () => {
    const { port: p, state } = tagPort({ html: CONV9 });
    await expect(addTag(p, 9, ["x"])).rejects.toThrow(/no tag controls: the paid Tags module/);
    expect(state.posts).toEqual([]);
  });

  it("refuses an unsent draft conversation even when the module markup is there (nothing posted)", async () => {
    const draft = withConvTags(raw("conversation-13-new-draft.html"), []);
    const { port: p, state } = tagPort({ id: 13, html: draft });
    await expect(addTag(p, 13, ["x"])).rejects.toThrow(/unsent draft conversation.*refusing to tag it/);
    expect(state.posts).toEqual([]);
  });
});

describe("assertTagRemoveForm", () => {
  const ok = { action: "remove", tag_name: "vip", conversation_id: "9" };
  it("accepts exactly {action:'remove', conversation_id, tag_name}", () => {
    expect(() => assertTagRemoveForm(ok)).not.toThrow();
    expect(buildTagRemoveForm(9, "vip")).toEqual(ok);
  });
  it.each([
    ["conversation_id array (bulk)", { ...ok, conversation_id: ["9", "10"] }, /array \(bulk/],
    ["conversation_id number", { ...ok, conversation_id: 9 }, /single positive integer/],
    ["conversation_id with junk", { ...ok, conversation_id: "9&conversation_id[]=10" }, /single positive integer/],
    ["add action", { ...ok, action: "add" }, /action is not 'remove'/],
    ["extra key", { ...ok, status: "3" }, /unexpected field status/],
    ["tag_names instead of tag_name", { action: "remove", tag_names: ["vip"], conversation_id: "9" }, /unexpected field tag_names.*tag_name missing/],
    ["tag_name array", { ...ok, tag_name: ["a", "b"] }, /tag_name is an array/],
    ["empty name", { ...ok, tag_name: "" }, /1\.\.50 characters/],
    ["comma", { ...ok, tag_name: "a,b" }, /comma/],
    ["untrimmed", { ...ok, tag_name: "vip " }, /not trimmed/],
  ])("rejects %s", (_label, form, re) => {
    expect(() => assertTagRemoveForm(form)).toThrow(FreeScoutError);
    expect(() => assertTagRemoveForm(form)).toThrow(re);
  });
  it("rejects non-plain objects", () => {
    expect(() => assertTagRemoveForm(null)).toThrow(/not a plain object/);
    expect(() => assertTagRemoveForm([ok])).toThrow(/not a plain object/);
  });
});

describe("removeTag", () => {
  /** Stub FreeScout: conversation `id` renders `state.tags`; tags/ajax remove POSTs go to `onPost` or drop the tag. */
  function removePort(opts: { id?: number; html?: string; tags?: string[]; onPost?: (form: Record<string, unknown>, tags: string[]) => unknown }) {
    const id = opts.id ?? 9;
    const state = { tags: [...(opts.tags ?? [])], posts: [] as Array<[string, Record<string, unknown>]>, gets: 0 };
    const p: FreeScoutPort = {
      async getHtml(path: string): Promise<HtmlPage> {
        state.gets++;
        if (path !== `/conversation/${id}`) throw new FreeScoutError(`FreeScout page not found: ${path}`, 404);
        return { $: cheerio.load(opts.html ?? withConvTags(CONV9, state.tags)), url: `${BASE}/conversation/${id}?folder_id=17`, status: 200 };
      },
      async ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
        state.posts.push([path, form]);
        if (opts.onPost) return opts.onPost(form, state.tags) as T;
        const i = state.tags.findIndex((t) => t.toLowerCase() === String(form.tag_name).toLowerCase());
        if (i >= 0) state.tags.splice(i, 1);
        return { status: "success" } as T;
      },
    };
    return { port: p, state };
  }

  it("posts one remove per present tag, using the name as shown, and verifies the rest stayed", async () => {
    const { port: p, state } = removePort({ tags: ["Safari", "vip", "billing"] });
    const r = await removeTag(p, 9, ["safari", " BILLING ", "Safari", "nope"]);
    expect(state.posts).toEqual([
      [TAGS_AJAX, { action: "remove", tag_name: "Safari", conversation_id: "9" }],
      [TAGS_AJAX, { action: "remove", tag_name: "billing", conversation_id: "9" }],
    ]);
    expect(r).toEqual({ conversation_id: 9, tags_before: ["Safari", "vip", "billing"], tags_after: ["vip"], removed: ["Safari", "billing"], not_present: ["nope"] });
    expect(state.gets).toBe(2);
  });

  it("posts nothing when none of the tags are on the conversation", async () => {
    const { port: p, state } = removePort({ tags: ["vip"] });
    expect(await removeTag(p, 9, ["safari"])).toEqual({
      conversation_id: 9,
      removed: [],
      not_present: ["safari"],
      tags_before: ["vip"],
      tags_after: ["vip"],
      note: "none of these tags are on the conversation",
    });
    expect(state.posts).toEqual([]);
  });

  it("refuses invalid names before fetching or posting", async () => {
    const { port: p, state } = removePort({});
    await expect(removeTag(p, 9, ["a,b"])).rejects.toThrow(/comma/);
    await expect(removeTag(p, 9, Array.from({ length: 11 }, (_, i) => `t${i}`))).rejects.toThrow(/1\.\.10/);
    expect(state.gets + state.posts.length).toBe(0);
  });

  it("maps status:error and permission answers", async () => {
    const err = removePort({ tags: ["x"], onPost: () => ({ status: "error", msg: "Tag not found" }) });
    await expect(removeTag(err.port, 9, ["x"])).rejects.toThrow(/remove_tag failed: Tag not found/);
    const perm = removePort({ tags: ["x"], onPost: () => ({ status: "error", msg: "Not enough permissions" }) });
    await expect(removeTag(perm.port, 9, ["x"])).rejects.toBeInstanceOf(PermissionError);
  });

  it("post-verification throws DANGER if another tag vanished", async () => {
    const { port: p } = removePort({
      tags: ["safari", "vip"],
      onPost: (_form, tags) => {
        tags.splice(0, tags.length);
        return { status: "success" };
      },
    });
    await expect(removeTag(p, 9, ["safari"])).rejects.toThrow(/DANGER: .*also lost tag\(s\) \["vip"\]/);
  });

  it("post-verification fails if the tag is still shown", async () => {
    const { port: p } = removePort({ tags: ["safari"], onPost: () => ({ status: "success" }) });
    await expect(removeTag(p, 9, ["safari"])).rejects.toThrow(/\["safari"\] is still shown/);
  });

  it("refuses without module markup and on unsent drafts (nothing posted)", async () => {
    const absent = removePort({ html: CONV9 });
    await expect(removeTag(absent.port, 9, ["x"])).rejects.toThrow(/no tag controls/);
    const draft = removePort({ id: 13, html: withConvTags(raw("conversation-13-new-draft.html"), ["x"]) });
    await expect(removeTag(draft.port, 13, ["x"])).rejects.toThrow(/unsent draft conversation/);
    expect(absent.state.posts.length + draft.state.posts.length).toBe(0);
  });
});
