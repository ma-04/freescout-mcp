import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import type { FreeScoutPort, HtmlPage } from "../src/client.js";
import { FreeScoutError, PermissionError } from "../src/errors.js";
import { addNote, assertNoteForm, buildDraftForm, buildNoteForm, discardDraft, formatBody, saveDraft } from "../src/operations.js";
import { checkAjax } from "../src/ajax.js";
import { parseConversation } from "../src/parsers/conversation.js";

const BASE = "https://freescout.example.com";
const raw = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");

/** Insert a thread div at the top of #conv-layout-main (threads render newest first). */
function withNewThread(html: string, id: number, type: string, text: string): string {
  const $ = cheerio.load(html);
  $("#conv-layout-main").prepend(
    `<div class="thread thread-type-${type}" id="thread-${id}" data-thread_id="${id}"><div class="thread-message"><div class="thread-header"><div class="thread-title"><div class="thread-person"><strong><a href="${BASE}/users/profile/2">you</a></strong></div></div><div class="thread-info"><a href="#thread-${id}" class="thread-date" title="Oct 22, 2026 11:00">Just now</a></div></div><div class="thread-body"><div class="thread-content"><p>${text}</p></div></div></div></div>`,
  );
  return $.html();
}

/** Stub port: serves conversation pages from a queue and records ajax posts. */
function stub(pages: string[], conversationUrl: string, ajaxReply: unknown) {
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  const gets: string[] = [];
  let i = 0;
  const port: FreeScoutPort = {
    async getHtml(path: string): Promise<HtmlPage> {
      gets.push(path);
      const html = pages[Math.min(i++, pages.length - 1)]!;
      return { $: cheerio.load(html), url: conversationUrl, status: 200 };
    },
    async ajaxPost<T>(path: string, form: Record<string, string>): Promise<T> {
      posts.push({ path, form: { ...form } });
      return ajaxReply as T;
    },
  };
  return { port, posts, gets };
}

const CONV9 = raw("conversation-9.html");
const CONV9_URL = `${BASE}/conversation/9?folder_id=17`;
const CONV1 = raw("conversation-1-draft.html");
const CONV1_URL = `${BASE}/conversation/1?folder_id=1`;

describe("note form hard rules", () => {
  it("buildNoteForm pins is_note='1' last, has user_id/status, and no subtype/thread_id", () => {
    const f = buildNoteForm({ conversation_id: 9, mailbox_id: 1, user_id: 2, status: 1, body: "<p>x</p>" });
    expect(f).toEqual({ action: "send_reply", conversation_id: "9", mailbox_id: "1", body: "<p>x</p>", user_id: "2", status: "1", is_note: "1" });
    expect(Object.keys(f).at(-1)).toBe("is_note");
    expect("subtype" in f).toBe(false);
    expect("thread_id" in f).toBe(false);
    expect(buildNoteForm({ conversation_id: 1, mailbox_id: 1, user_id: -1, status: 1, body: "b" }).user_id).toBe("-1");
  });

  it("assertNoteForm rejects anything that could become a customer reply or forward", () => {
    const ok = buildNoteForm({ conversation_id: 9, mailbox_id: 1, user_id: 2, status: 1, body: "b" });
    expect(() => assertNoteForm(ok)).not.toThrow();
    expect(() => assertNoteForm({ ...ok, is_note: "" })).toThrow(/is_note/);
    expect(() => assertNoteForm({ ...ok, is_note: "0" })).toThrow(/is_note/);
    expect(() => assertNoteForm({ ...ok, subtype: "1" })).toThrow(/subtype/);
    expect(() => assertNoteForm({ ...ok, thread_id: "20" })).toThrow(/thread_id/);
    expect(() => assertNoteForm({ ...ok, to: "x@example.com" })).toThrow(/unexpected field to/);
    const { user_id: _u, ...noUser } = ok;
    expect(() => assertNoteForm(noUser)).toThrow(/user_id/);
  });
});

describe("addNote", () => {
  it("reads status/assignee/mailbox from the page, posts the pinned field set and returns the new note", async () => {
    const { port, posts } = stub([CONV9, withNewThread(CONV9, 31, "note", "Checked logs")], CONV9_URL, { status: "success", msg: "" });
    const res = await addNote(port, 9, "Checked logs");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/conversation/ajax");
    expect(posts[0]!.form).toEqual({
      action: "send_reply",
      conversation_id: "9",
      mailbox_id: "1",
      body: "<p>Checked logs</p>",
      user_id: "2",
      status: "1",
      is_note: "1",
    });
    expect(res).toMatchObject({ conversation_id: 9, thread_id: 31, type: "note", body: "Checked logs" });
  });

  it("sends user_id -1 on an unassigned conversation", async () => {
    const { port, posts } = stub([CONV1, withNewThread(CONV1, 40, "note", "n")], CONV1_URL, { status: "success", msg: "" });
    await addNote(port, 1, "n");
    expect(posts[0]!.form.user_id).toBe("-1");
    expect(posts[0]!.form.is_note).toBe("1");
  });

  it("a 200 {status:'error'} response throws and the page is not re-read as success", async () => {
    const { port, gets } = stub([CONV9], CONV9_URL, { status: "error", msg: "The body field is required. " });
    await expect(addNote(port, 9, "x")).rejects.toThrow(FreeScoutError);
    await expect(addNote(port, 9, "x")).rejects.toThrow(/body field is required/);
    expect(gets).toHaveLength(2); // one GET per attempt, no re-fetch after the error
  });

  it("'Not enough permissions' is a PermissionError", async () => {
    const { port } = stub([CONV9], CONV9_URL, { status: "error", msg: "Not enough permissions" });
    await expect(addNote(port, 9, "x")).rejects.toBeInstanceOf(PermissionError);
  });

  it("throws loudly if the new thread is not a note", async () => {
    const { port } = stub([CONV9, withNewThread(CONV9, 32, "message", "oops")], CONV9_URL, { status: "success", msg: "" });
    await expect(addNote(port, 9, "oops")).rejects.toThrow(/DANGER.*32:message/);
  });

  it("a customer reply arriving meanwhile is not reported as DANGER; the note is still returned", async () => {
    const after = withNewThread(withNewThread(CONV9, 33, "customer", "any update?"), 34, "note", "Checked logs");
    const { port } = stub([CONV9, after], CONV9_URL, { status: "success", msg: "" });
    const res = await addNote(port, 9, "Checked logs");
    expect(res).toMatchObject({ thread_id: 34, type: "note" });
  });

  it("throws if no new thread appears", async () => {
    const { port } = stub([CONV9, CONV9], CONV9_URL, { status: "success", msg: "" });
    await expect(addNote(port, 9, "x")).rejects.toThrow(/no new thread/);
  });
});

describe("checkAjax", () => {
  it("treats success-with-permission-msg as PermissionError and missing status as error", () => {
    expect(() => checkAjax({ status: "success", msg: "Not enough permissions" }, "t")).toThrow(PermissionError);
    expect(() => checkAjax({ msg: "" }, "t")).toThrow(FreeScoutError);
    expect(checkAjax({ status: "success", msg: "" }, "t")).toEqual({ status: "success", msg: "" });
  });
});

describe("formatBody", () => {
  it("wraps plain text, escapes it, keeps inline tags and sanitises HTML", () => {
    expect(formatBody("Hi Maria,\nline two\n\nThanks & bye <3")).toBe("<p>Hi Maria,<br>line two</p><p>Thanks &amp; bye &lt;3</p>");
    expect(formatBody("see <b>this</b>\nnext")).toBe("<p>see <b>this</b><br>next</p>");
    expect(formatBody('<p onclick="x()">ok</p><script>alert(1)</script><a href="javascript:x">l</a>')).toBe("<p>ok</p><a>l</a>");
    expect(() => formatBody("   ")).toThrow(/empty/);
  });
  it("treats input as HTML only when it parses into an allow-listed element; otherwise escapes it as text", () => {
    // '<p>' only inside a script / a comment is not markup: shown literally instead of sanitised to nothing.
    expect(formatBody("<script>var s='<p>'</script>")).toBe("<p>&lt;script&gt;var s='&lt;p&gt;'&lt;/script&gt;</p>");
    expect(formatBody("tip: <!-- <p>hidden</p> -->")).toBe("<p>tip: &lt;!-- &lt;p&gt;hidden&lt;/p&gt; --&gt;</p>");
    expect(formatBody("List<int> and <foo>bar</foo>")).toBe("<p>List&lt;int&gt; and &lt;foo&gt;bar&lt;/foo&gt;</p>");
    expect(formatBody("<ul><li>one</li></ul>")).toBe("<ul><li>one</li></ul>");
  });
});

describe("drafts", () => {
  it("buildDraftForm uses save_draft with an empty thread_id for a new draft and never is_note/subtype/is_create", () => {
    const f = buildDraftForm({ conversation_id: 1, mailbox_id: 1, body: "<p>x</p>" });
    expect(f).toEqual({ action: "save_draft", conversation_id: "1", mailbox_id: "1", thread_id: "", body: "<p>x</p>" });
    expect(buildDraftForm({ conversation_id: 1, mailbox_id: 1, body: "b", thread_id: 26 }).thread_id).toBe("26");
  });

  it("saveDraft refuses to 'update' a thread that is not a draft", async () => {
    const { port, posts } = stub([CONV9], CONV9_URL, { status: "success" });
    await expect(saveDraft(port, 9, "x", 20)).rejects.toThrow(/not a draft/);
    expect(posts).toHaveLength(0);
  });

  it("saveDraft updates the given draft and verifies it is still a draft", async () => {
    const { port, posts } = stub([CONV1, CONV1], CONV1_URL, { status: "success", msg: "", thread_id: 26, number: 1 });
    const d = await saveDraft(port, 1, "new text", 26);
    expect(posts[0]!.form).toMatchObject({ action: "save_draft", thread_id: "26", conversation_id: "1", mailbox_id: "1" });
    expect(d).toMatchObject({ thread_id: 26, number: 1, updated: true });
  });

  it("discardDraft only discards draft threads", async () => {
    const { port, posts } = stub([CONV9], CONV9_URL, { status: "success" });
    await expect(discardDraft(port, 9, 19)).rejects.toThrow(/not a draft/);
    expect(posts).toHaveLength(0);
  });
});

describe("draft (unsent) conversations", () => {
  // Live capture: admin created a new conversation with save_draft is_create=1; this is the agent's view.
  const NEW_DRAFT = raw("conversation-13-new-draft.html");
  const NEW_DRAFT_URL = `${BASE}/conversation/13?folder_id=2`;

  it("the create view is recognised as a draft conversation; published conversations are not", () => {
    expect(parseConversation(cheerio.load(NEW_DRAFT), NEW_DRAFT_URL).is_draft_conversation).toBe(true);
    expect(parseConversation(cheerio.load(CONV9), CONV9_URL).is_draft_conversation).toBe(false);
    expect(parseConversation(cheerio.load(CONV1), CONV1_URL).is_draft_conversation).toBe(false);
  });

  it("add_note refuses with a clear error and posts nothing", async () => {
    const { port, posts } = stub([NEW_DRAFT], NEW_DRAFT_URL, { status: "success" });
    await expect(addNote(port, 13, "note")).rejects.toThrow(/unsent draft conversation.*refusing to add a note/);
    expect(posts).toEqual([]);
  });

  it("save_draft and discard_draft refuse too and post nothing", async () => {
    const { port, posts } = stub([NEW_DRAFT], NEW_DRAFT_URL, { status: "success", thread_id: 99 });
    await expect(saveDraft(port, 13, "hi")).rejects.toThrow(/unsent draft conversation/);
    await expect(discardDraft(port, 13, 26)).rejects.toThrow(/unsent draft conversation/);
    expect(posts).toEqual([]);
  });
});
