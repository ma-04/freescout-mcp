/**
 * remove_note (2026-11-04): delete ONE internal note written by the logged-in agent via FreeScout's
 * `action=delete_thread` (docs/freescout-endpoints.md §5.6). Everything here is offline: the real conversation-9
 * capture through a stub port, and the fake FreeScout through the real Session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import { assertDeleteThreadForm, buildDeleteThreadForm, removeNote } from "../src/operations.js";
import { parseConversation } from "../src/parsers/conversation.js";
import { Session } from "../src/session.js";
import { FakeFreeScout, type FakeThread } from "./fake-freescout.js";

const BASE = "https://freescout.example.com";
const raw = (n: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${n}`, import.meta.url)), "utf8");
const CONV9 = raw("conversation-9.html");
const CONV9_URL = `${BASE}/conversation/9?folder_id=17`;

function stub(pages: string[], reply: unknown = { status: "success", msg: "" }) {
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  let i = 0;
  const port: FreeScoutPort = {
    async getHtml(): Promise<HtmlPage> {
      return { $: cheerio.load(pages[Math.min(i++, pages.length - 1)]!), url: CONV9_URL, status: 200 };
    },
    async ajaxPost<T>(path: string, form: Record<string, string>): Promise<T> {
      posts.push({ path, form: { ...form } });
      return reply as T;
    },
  };
  return { port, posts };
}
const without = (html: string, id: number) => {
  const $ = cheerio.load(html);
  $(`#thread-${id}`).remove();
  return $.html();
};

describe("delete_thread form guard", () => {
  it("builds exactly {action:'delete_thread', thread_id}", () => {
    expect(buildDeleteThreadForm(19)).toEqual({ action: "delete_thread", thread_id: "19" });
    expect(() => assertDeleteThreadForm({ action: "delete_thread", thread_id: "19" })).not.toThrow();
  });

  it("rejects extra keys, other actions, bad ids and non-plain objects", () => {
    const ok = { action: "delete_thread", thread_id: "19" };
    for (const extra of [{ conversation_id: "9" }, { _token: "x" }, { body: "x" }, { is_note: "1" }, { status: "3" }, { user_id: "1" }]) {
      expect(() => assertDeleteThreadForm({ ...ok, ...extra }), JSON.stringify(extra)).toThrow(/unexpected field/);
    }
    for (const action of ["delete_conversation", "delete_conversation_forever", "save_edit_thread", "discard_draft", "send_reply", "", "delete_thread "]) {
      expect(() => assertDeleteThreadForm({ ...ok, action }), action).toThrow(FreeScoutError);
    }
    for (const thread_id of ["0", "-1", "1.5", "19,20", "", " 19", "019", ["19"], ["19", "20"], 19]) {
      expect(() => assertDeleteThreadForm({ ...ok, thread_id }), JSON.stringify(thread_id)).toThrow(/thread_id/);
    }
    expect(() => assertDeleteThreadForm({ action: "delete_thread" })).toThrow(/thread_id missing/);
    expect(() => assertDeleteThreadForm(["delete_thread", "19"])).toThrow(/plain object/);
    expect(() => assertDeleteThreadForm(Object.assign(Object.create({ evil: 1 }), ok))).toThrow(/plain object/);
    expect(() => assertDeleteThreadForm(null)).toThrow(/plain object/);
  });
});

describe("parser: can_delete comes only from FreeScout's own thread menu", () => {
  it("real capture: own note 19 has the Delete item; customer 18 and reply 20 do not", () => {
    const conv = parseConversation(cheerio.load(CONV9), CONV9_URL);
    const by = Object.fromEntries(conv.threads.map((t) => [t.thread_id, t]));
    expect(by[19]).toMatchObject({ type: "note", can_delete: true, author: { kind: "user", id: 2, is_current_user: true } });
    expect(by[18]!.can_delete).toBeUndefined();
    expect(by[20]!.can_delete).toBeUndefined();
  });

  it("a delete link written inside the note body does not count", () => {
    const $ = cheerio.load(CONV9);
    $("#thread-20 .thread-content").append('<div class="thread-options"><a class="thread-delete-trigger">Delete</a></div>');
    $("#thread-19 > .thread-options .thread-delete-trigger").remove();
    $("#thread-19 .thread-content").append('<a class="thread-delete-trigger">Delete</a>');
    const conv = parseConversation($, CONV9_URL);
    expect(conv.threads.find((t) => t.thread_id === 20)!.can_delete).toBeUndefined();
    expect(conv.threads.find((t) => t.thread_id === 19)!.can_delete).toBeUndefined();
  });
});

describe("removeNote on the real conversation-9 capture (stub port)", () => {
  it("deletes own note 19: one pinned POST, then verifies it is gone and 18/20 remain", async () => {
    const { port, posts } = stub([CONV9, without(CONV9, 19)]);
    const res = await removeNote(port, 9, 19);
    expect(posts).toEqual([{ path: "/conversation/ajax", form: { action: "delete_thread", thread_id: "19" } }]);
    expect(res).toMatchObject({ conversation_id: 9, thread_id: 19, removed: true, thread_count_before: 3, thread_count_after: 2 });
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("refuses the customer message and the reply before any POST", async () => {
    const { port, posts } = stub([CONV9]);
    await expect(removeNote(port, 9, 18)).rejects.toThrow(/customer message; refusing/);
    await expect(removeNote(port, 9, 20)).rejects.toThrow(/reply sent to the customer; refusing/);
    expect(posts).toEqual([]);
  });

  it("thread not on the conversation (wrong id, or a second call after deleting): clean error, nothing posted", async () => {
    const { port, posts } = stub([without(CONV9, 19)]);
    await expect(removeNote(port, 9, 19)).rejects.toThrow(/Thread 19 is not on conversation 9 \(wrong id, or already deleted\)/);
    await expect(removeNote(port, 9, 999)).rejects.toThrow(/not on conversation 9/);
    expect(posts).toEqual([]);
  });

  it("refuses when FreeScout does not offer Delete for the note (no trigger in its menu)", async () => {
    const $ = cheerio.load(CONV9);
    $("#thread-19 .thread-delete-trigger").remove();
    const { port, posts } = stub([$.html()]);
    await expect(removeNote(port, 9, 19)).rejects.toThrow(/not offered for deletion by FreeScout/);
    expect(posts).toEqual([]);
  });

  it("refuses when the page does not show the logged-in user id", async () => {
    const $ = cheerio.load(CONV9);
    $("body").removeAttr("data-auth_user_id");
    const { port, posts } = stub([$.html()]);
    await expect(removeNote(port, 9, 19)).rejects.toThrow(/logged-in user/);
    expect(posts).toEqual([]);
  });

  it("FreeScout errors are typed: 'Thread not found' -> FreeScoutError, 'Not enough permissions' -> PermissionError", async () => {
    let s = stub([CONV9], { status: "error", msg: "Thread not found" });
    await expect(removeNote(s.port, 9, 19)).rejects.toThrow(/remove_note failed: Thread not found/);
    s = stub([CONV9], { status: "error", msg: "Not enough permissions" });
    await expect(removeNote(s.port, 9, 19)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("removeNote against the fake FreeScout (real Session)", () => {
  let fs: FakeFreeScout;
  afterEach(async () => {
    await fs?.stop();
  });

  async function setup(threads: FakeThread[]) {
    fs = new FakeFreeScout();
    await fs.start();
    fs.addConv(9, { threads });
    fs.addConv(11, { threads: [{ id: 1100, type: "customer", body: "other", to: ["support@fake.example"] }, { id: 1101, type: "note", body: "mine elsewhere" }] });
    const client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(7), logger: silentLogger, timeoutMs: 5000 }));
    return client;
  }
  const BASE_THREADS = (): FakeThread[] => [
    { id: 100, type: "customer", body: "Help", to: ["support@fake.example"] },
    { id: 101, type: "message", body: "Reply", to: ["customer@client.example"] },
    { id: 102, type: "note", body: "My note" },
    { id: 103, type: "note", body: "Colleague's note", by: 8 },
    { id: 104, type: "note", body: "Forward note", to: ["lead@team.example"], forward_child: 1 },
    { id: 105, type: "draft", body: "<p>draft</p>" },
    { type: "lineitem", body: "You marked as Active" },
    { id: 106, type: "note", body: "Fwd without link", forward: true, to: ["lead@team.example"] },
    { id: 107, type: "note", body: "Fwd alert only", forward_alert_only: 2 },
  ];
  const deletePosts = () => fs.convPosts.map((p) => p.filter(([k]) => k !== "_token"));

  it("deletes the agent's own note; the wire form is exactly action + thread_id (+ _token); other threads stay", async () => {
    const client = await setup(BASE_THREADS());
    const res = await removeNote(client, 9, 102);
    expect(res).toMatchObject({ conversation_id: 9, thread_id: 102, removed: true, body: "My note" });
    expect(deletePosts()).toEqual([[["action", "delete_thread"], ["thread_id", "102"]]]);
    expect(fs.convPosts[0]!.map(([k]) => k).sort()).toEqual(["_token", "action", "thread_id"]);
    expect(fs.convs.get(9)!.threads.map((t) => t.id)).toEqual([100, 101, 103, 104, 105, undefined, 106, 107]);
    // Second call: the note is gone, so it fails cleanly without posting again.
    await expect(removeNote(client, 9, 102)).rejects.toThrow(/not on conversation 9/);
    expect(fs.convPosts).toHaveLength(1);
  });

  it("refuses every non-own or non-plain-note thread before any POST", async () => {
    const client = await setup(BASE_THREADS());
    const cases: Array<[number, RegExp]> = [
      [100, /customer message/],
      [101, /reply sent to the customer/],
      [103, /not written by the logged-in user \(author: Other Agent\)/],
      [104, /forward note/],
      [105, /reply draft/],
      [106, /forward note/],
      [107, /forward note/], // only the .alert.alert-note marker, no badge, no recipients
      [1101, /not on conversation 9/], // a note of another conversation
    ];
    for (const [id, re] of cases) await expect(removeNote(client, 9, id), String(id)).rejects.toThrow(re);
    expect(fs.convPosts).toEqual([]);
    expect(fs.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("refuses another user's note even if FreeScout rendered a Delete item for it", async () => {
    const client = await setup([...BASE_THREADS().slice(0, 3), { id: 103, type: "note", body: "x", by: 8, deletable: true }]);
    await expect(removeNote(client, 9, 103)).rejects.toThrow(/not written by the logged-in user/);
    expect(fs.convPosts).toEqual([]);
  });

  it("refuses an own note that is the first thread (FreeScout never offers to delete it)", async () => {
    const client = await setup([{ id: 200, type: "note", body: "phone call log", deletable: true }, { id: 201, type: "customer", body: "x", to: ["s@x.example"] }]);
    await expect(removeNote(client, 9, 200)).rejects.toThrow(/first thread/);
    expect(fs.convPosts).toEqual([]);
  });

  it("refuses an unsent draft conversation", async () => {
    const client = await setup(BASE_THREADS());
    fs.convs.get(9)!.draft = true;
    await expect(removeNote(client, 9, 102)).rejects.toThrow(/unsent draft conversation/);
    expect(fs.convPosts).toEqual([]);
  });

  it("verification: FreeScout says success but the note is still there", async () => {
    const client = await setup(BASE_THREADS());
    fs.misbehave.deleteNoop = true;
    await expect(removeNote(client, 9, 102)).rejects.toThrow(/still shown on conversation 9/);
    expect(fs.convPosts).toHaveLength(1);
  });

  it("verification: another thread vanished too -> DANGER", async () => {
    const client = await setup(BASE_THREADS());
    fs.misbehave.deleteAlsoRemoves = 101;
    await expect(removeNote(client, 9, 102)).rejects.toThrow(/DANGER: after remove_note, conversation 9 also lost thread\(s\) 101/);
  });

  it("a new inbound customer thread arriving meanwhile is not an error", async () => {
    const client = await setup(BASE_THREADS());
    fs.misbehave.teammate = (c) => c.threads.push({ id: 900, type: "customer", body: "new mail", to: ["support@fake.example"] });
    await expect(removeNote(client, 9, 102)).resolves.toMatchObject({ removed: true, thread_count_before: 9, thread_count_after: 9 });
  });
});
