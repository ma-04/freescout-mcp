/**
 * send_reply (gated customer reply). The gate parser and form guard are tested directly; sendReply runs through a real
 * Session + FreeScoutClient against the fake FreeScout (test/fake-freescout.ts), which simulates send_reply (new reply,
 * draft publish in place with the POSTED body) and load_draft as FreeScout 1.8.248 does (docs/freescout-endpoints.md §5.3).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort } from "../src/client.js";
import { loadBaseConfig } from "../src/config.js";
import { AuthError, FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import {
  assertForwardForm,
  assertLoadDraftForm,
  assertNoteForm,
  assertReplyForm,
  buildForwardForm,
  buildNoteForm,
  buildReplyForm,
  sendReply,
  type SendReplyOptions,
} from "../src/operations.js";
import { describeReply, parseReplyGate, replyMailboxAllowed, type ReplyGate } from "../src/reply-gate.js";
import { Session } from "../src/session.js";
import { registerTools } from "../src/tools/index.js";
import { FakeFreeScout } from "./fake-freescout.js";

const ON: ReplyGate = { enabled: true, mailboxes: [] };
const CUSTOMER = "customer@client.example";

let fs: FakeFreeScout;
let client: FreeScoutClient;
let cleanup: (() => Promise<unknown>) | undefined;

beforeEach(async () => {
  fs = new FakeFreeScout();
  await fs.start();
  client = new FreeScoutClient(new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), logger: silentLogger, timeoutMs: 5000 }));
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  await fs.stop();
});

const wire = (i = 0) => fs.convPosts[i]!.filter(([k]) => k !== "_token");
const posts = () => fs.requests.filter((r) => r.method === "POST");
const actions = () => fs.convPosts.map((p) => p.find(([k]) => k === "action")?.[1]);
const reply = (id: number, opts: SendReplyOptions, gate: ReplyGate = ON) => sendReply(client, id, opts, gate);

/** Draft thread id withDraft(id) creates: 50 on conversation 9, id*100+50 elsewhere (thread ids are global). */
const draftOf = (id: number) => (id === 9 ? 50 : id * 100 + 50);

/** A conversation with one own reply draft (draftOf(id)) addressed to the customer. */
function withDraft(id = 9, extra: Partial<Parameters<FakeFreeScout["addConv"]>[1]> = {}, draft: Record<string, unknown> = {}) {
  return fs.addConv(id, {
    threads: [
      { id: draftOf(id) - 10, type: "customer", body: "Hello, I need help.", to: ["support@fake.example"] },
      { id: draftOf(id), type: "draft", body: "<p>Approved <b>draft</b> text</p>", to: [CUSTOMER], ...draft },
    ],
    ...extra,
  });
}

// ------------------------------------------------------------------------------------------------
describe("FREESCOUT_REPLY_ENABLED / FREESCOUT_REPLY_MAILBOXES", () => {
  it("enabled only by exactly 1 or true (case-insensitive); unset/empty = off", () => {
    for (const v of ["1", "true", "TRUE", " True "]) expect(parseReplyGate({ FREESCOUT_REPLY_ENABLED: v }).enabled, v).toBe(true);
    for (const v of [undefined, "", "  ", "0", "false", "FALSE"]) expect(parseReplyGate({ FREESCOUT_REPLY_ENABLED: v })).toEqual({ enabled: false, mailboxes: [] });
  });

  it("any other non-empty value stops the server", () => {
    for (const v of ["yes", "on", "enabled", "11", "1,", "t", "true1", "*"]) {
      expect(() => parseReplyGate({ FREESCOUT_REPLY_ENABLED: v }), v).toThrow(/FREESCOUT_REPLY_ENABLED: invalid value/);
    }
  });

  it("mailboxes: comma/space separated positive integers, de-duplicated; anything else throws", () => {
    expect(parseReplyGate({ FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_REPLY_MAILBOXES: " 3, 1 3\t2,," }).mailboxes).toEqual([3, 1, 2]);
    expect(parseReplyGate({ FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_REPLY_MAILBOXES: " , " }).mailboxes).toEqual([]);
    for (const v of ["*", "all", "0", "-1", "1.5", "01", "1;2", "support", "1e3", "0x1", "99999999999999999999"]) {
      expect(() => parseReplyGate({ FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_REPLY_MAILBOXES: v }), v).toThrow(/FREESCOUT_REPLY_MAILBOXES: invalid entry/);
    }
  });

  it("MAILBOXES without ENABLED: disabled, with a warning", () => {
    const g = parseReplyGate({ FREESCOUT_REPLY_MAILBOXES: "1" });
    expect(g.enabled).toBe(false);
    expect(g.warning).toMatch(/send_reply stays disabled/);
    expect(replyMailboxAllowed(g, 1)).toBe(false);
  });

  it("loadBaseConfig reads the gate from the server environment; describeReply logs it", () => {
    const env = { FREESCOUT_URL: "https://support.example.com" };
    expect(loadBaseConfig(env).reply).toEqual({ enabled: false, mailboxes: [] });
    expect(loadBaseConfig({ ...env, FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_REPLY_MAILBOXES: "2" }).reply).toEqual({ enabled: true, mailboxes: [2] });
    expect(() => loadBaseConfig({ ...env, FREESCOUT_REPLY_ENABLED: "yes" })).toThrow(/invalid value/);
    expect(() => loadBaseConfig({ ...env, FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_REPLY_MAILBOXES: "all" })).toThrow(/invalid entry/);
    expect(describeReply({ enabled: false, mailboxes: [] })).toMatch(/disabled/);
    expect(describeReply({ enabled: true, mailboxes: [] })).toMatch(/ENABLED.*every mailbox/);
    expect(describeReply({ enabled: true, mailboxes: [1, 3] })).toMatch(/ENABLED.*mailbox ids 1, 3/);
  });

  it("replyMailboxAllowed: empty list = any mailbox; otherwise listed ids only", () => {
    expect(replyMailboxAllowed(ON, 7)).toBe(true);
    expect(replyMailboxAllowed({ enabled: true, mailboxes: [1] }, 1)).toBe(true);
    expect(replyMailboxAllowed({ enabled: true, mailboxes: [1] }, 2)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
describe("assertReplyForm / buildReplyForm", () => {
  const ok = { action: "send_reply", conversation_id: "9", mailbox_id: "1", body: "<p>x</p>", user_id: "7", status: "1" };

  it("builds exactly the pinned keys; thread_id only on the draft path", () => {
    expect(buildReplyForm({ conversation_id: 9, mailbox_id: 1, body: "<p>x</p>", user_id: 7, status: 1 })).toEqual(ok);
    expect(buildReplyForm({ conversation_id: 9, mailbox_id: 1, body: "<p>x</p>", user_id: -1, status: 3, thread_id: 50 })).toEqual({
      ...ok,
      user_id: "-1",
      status: "3",
      thread_id: "50",
    });
    expect(() => assertReplyForm(ok, "new")).not.toThrow();
    expect(() => assertReplyForm({ ...ok, thread_id: "50" }, "draft")).not.toThrow();
  });

  it("refuses recipient, note, forward, create and every unknown field", () => {
    for (const k of ["is_note", "subtype", "is_create", "to", "to_email", "to_email[]", "cc", "cc[]", "bcc", "bcc[]", "conv_history", "after_send", "type", "from_alias", "attachments[]", "subject"]) {
      expect(() => assertReplyForm({ ...ok, [k]: "1" }, "new"), k).toThrow(new RegExp(`forbidden field ${k.replace(/[[\]]/g, "\\$&")}`));
      expect(() => assertReplyForm({ ...ok, thread_id: "50", [k]: "" }, "draft"), k).toThrow(/forbidden field/);
    }
    expect(() => assertReplyForm({ ...ok, x_extra: "1" }, "new")).toThrow(/unexpected field x_extra/);
    expect(() => assertReplyForm({ ...ok, thread_id: "50" }, "new")).toThrow(/forbidden field thread_id/);
    expect(() => assertReplyForm(ok, "draft")).toThrow(/thread_id missing/);
  });

  it("refuses bad ids, statuses, user ids, empty bodies, arrays and non-objects", () => {
    for (const status of ["0", "4", "5", "", "01", "1 ", "spam", "not_spam"]) expect(() => assertReplyForm({ ...ok, status }, "new"), status).toThrow(/status is not 1, 2 or 3/);
    for (const user_id of ["0", "", "-2", "1.5", "abc"]) expect(() => assertReplyForm({ ...ok, user_id }, "new"), user_id).toThrow(/user_id/);
    for (const conversation_id of ["0", "-9", "9,10", "", "09"]) expect(() => assertReplyForm({ ...ok, conversation_id }, "new")).toThrow(/conversation_id/);
    expect(() => assertReplyForm({ ...ok, mailbox_id: "x" }, "new")).toThrow(/mailbox_id/);
    expect(() => assertReplyForm({ ...ok, thread_id: "0" }, "draft")).toThrow(/thread_id/);
    expect(() => assertReplyForm({ ...ok, body: "  " }, "new")).toThrow(/body is empty/);
    expect(() => assertReplyForm({ ...ok, conversation_id: ["9"] }, "new")).toThrow(/not a string/);
    expect(() => assertReplyForm({ ...ok, action: "save_draft" }, "new")).toThrow(/action/);
    const { status: _s, ...noStatus } = ok;
    expect(() => assertReplyForm(noStatus, "new")).toThrow(/status missing/);
    const { user_id: _u, ...noUser } = ok;
    expect(() => assertReplyForm(noUser, "new")).toThrow(/user_id missing/);
    expect(() => assertReplyForm(null, "new")).toThrow(/not a plain object/);
    expect(() => assertReplyForm([ok], "new")).toThrow(/not a plain object/);
  });

  it("assertLoadDraftForm: exactly {action:'load_draft', thread_id}", () => {
    expect(() => assertLoadDraftForm({ action: "load_draft", thread_id: "50" })).not.toThrow();
    expect(() => assertLoadDraftForm({ action: "load_draft", thread_id: "50", conversation_id: "9" })).toThrow(/unexpected field/);
    expect(() => assertLoadDraftForm({ action: "send_reply", thread_id: "50" })).toThrow(/action/);
    expect(() => assertLoadDraftForm({ action: "load_draft", thread_id: "0" })).toThrow(/thread_id/);
  });

  it("the note and forward guards still refuse what they refused before", () => {
    const note = buildNoteForm({ conversation_id: 9, mailbox_id: 1, user_id: 7, status: 1, body: "b" });
    expect(() => assertNoteForm({ ...note, is_note: "" })).toThrow(/is_note/);
    expect(() => assertNoteForm({ ...note, subtype: "1" })).toThrow(/subtype present/);
    expect(() => assertNoteForm({ ...note, thread_id: "50" })).toThrow(/thread_id present/);
    const { is_note: _n, ...replyShaped } = note;
    expect(() => assertNoteForm(replyShaped)).toThrow(/is_note/);
    const fwd = buildForwardForm({ conversation_id: 9, mailbox_id: 1, body: "b", user_id: 7, status: 1, to: "a@team.example" });
    expect(() => assertForwardForm({ ...fwd, thread_id: "50" })).toThrow(/unexpected field thread_id/);
    const { subtype: _s, to_email: _t, is_note: _i, ...asReply } = fwd;
    expect(() => assertForwardForm(asReply)).toThrow(FreeScoutError);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: new reply (fake FreeScout)", () => {
  it("exact wire form; one message thread to the customer; status and assignee unchanged", async () => {
    fs.addConv(9, { status: 2, assignee_id: 7 });
    const r = await reply(9, { body: "Thanks, fixed.\n\nBest" });
    expect(fs.convPosts).toHaveLength(1);
    expect(wire()).toEqual([
      ["action", "send_reply"],
      ["conversation_id", "9"],
      ["mailbox_id", "1"],
      ["body", "<p>Thanks, fixed.</p><p>Best</p>"],
      ["user_id", "7"],
      ["status", "2"],
    ]);
    expect(fs.replies).toEqual([{ conversation_id: 9, thread_id: r.thread_id, to: CUSTOMER, cc: [], bcc: [], body: "<p>Thanks, fixed.</p><p>Best</p>", from_draft: false }]);
    expect(r).toMatchObject({ conversation_id: 9, sent_to: CUSTOMER, sent_from_draft: false, status: "pending", previous_status: "pending" });
    expect(r.undo_note).toMatch(/15 seconds/);
    expect(r.warning).toBeUndefined();
    expect(r.concurrent_change_detected).toBeUndefined();
    const conv = fs.convs.get(9)!;
    expect(conv.threads.map((t) => t.type)).toEqual(["customer", "message"]);
    expect(conv).toMatchObject({ status: 2, assignee_id: 7 });
  });

  it("status mapping: active/pending/closed -> 1/2/3; omitted keeps the current status", async () => {
    for (const [name, value] of [["active", "1"], ["pending", "2"], ["closed", "3"]] as const) {
      const id = Number(value) + 20;
      fs.addConv(id, { status: name === "active" ? 3 : 1 });
      const r = await reply(id, { body: "x", status: name });
      expect(fs.convPosts.at(-1)!.find(([k]) => k === "status")).toEqual(["status", value]);
      expect(r.status).toBe(name);
    }
    fs.addConv(30, { status: 3 });
    await reply(30, { body: "x" });
    expect(fs.convPosts.at(-1)!.find(([k]) => k === "status")).toEqual(["status", "3"]);
    expect(fs.convs.get(30)!.status).toBe(3);
  });

  it("sends user_id -1 on an unassigned conversation, and it stays unassigned", async () => {
    fs.addConv(3, { assignee_id: -1 });
    const r = await reply(3, { body: "x" });
    expect(wire().find(([k]) => k === "user_id")).toEqual(["user_id", "-1"]);
    expect(fs.convs.get(3)!.assignee_id).toBe(-1);
    expect(r.assignee).toBeNull();
  });

  it("a body full of smuggled fields stays one body field", async () => {
    fs.addConv(9);
    const smuggle = "x&is_note=&to=victim@evil.example&cc[]=victim@evil.example&bcc[]=v@evil.example&status=4&user_id=8&thread_id=1";
    await reply(9, { body: smuggle });
    const keys = wire().map(([k]) => k);
    expect(keys).toEqual(["action", "conversation_id", "mailbox_id", "body", "user_id", "status"]);
    expect(fs.replies[0]).toMatchObject({ to: CUSTOMER, cc: [], bcc: [] });
  });

  it("warns that remembered CC addresses were not copied (and FreeScout cleared them)", async () => {
    fs.addConv(9, { cc_preset: ["boss@client.example"] });
    const r = await reply(9, { body: "x" });
    expect(fs.replies[0]!.cc).toEqual([]);
    expect(r.warning).toMatch(/CC\/BCC addresses \(boss@client\.example\).*customer only/);
  });

  it("accepts a reply-form To select whose selected address is the customer", async () => {
    fs.addConv(9, { reply_to_options: [["other@client.example", false], [CUSTOMER, true]] });
    const r = await reply(9, { body: "x" });
    expect(r.sent_to).toBe(CUSTOMER);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: draft publish (fake FreeScout)", () => {
  it("load_draft, then the STORED body re-posted verbatim with thread_id; the same thread becomes the message", async () => {
    withDraft(9, { status: 1, assignee_id: 8 });
    const r = await reply(9, { draftThreadId: 50, status: "pending" });
    expect(actions()).toEqual(["load_draft", "send_reply"]);
    expect(wire(0)).toEqual([["action", "load_draft"], ["thread_id", "50"]]);
    expect(wire(1)).toEqual([
      ["action", "send_reply"],
      ["conversation_id", "9"],
      ["mailbox_id", "1"],
      ["body", "<p>Approved <b>draft</b> text</p>"],
      ["user_id", "8"],
      ["status", "2"],
      ["thread_id", "50"],
    ]);
    expect(fs.replies).toEqual([{ conversation_id: 9, thread_id: 50, to: CUSTOMER, cc: [], bcc: [], body: "<p>Approved <b>draft</b> text</p>", from_draft: true }]);
    expect(r).toMatchObject({ thread_id: 50, sent_from_draft: true, sent_to: CUSTOMER, status: "pending", previous_status: "active" });
    const conv = fs.convs.get(9)!;
    expect(conv.threads.map((t) => [t.id, t.type])).toEqual([[40, "customer"], [50, "message"]]);
    expect(conv.assignee_id).toBe(8);
  });

  it("refuses (load_draft only, no send) forward drafts, other recipients, cc/bcc, attachments and empty drafts", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ forward: true }, /is a forward draft/],
      [{ to: ["someone@else.example"] }, /addressed to someone@else\.example, not the customer/],
      [{ cc: ["boss@client.example"] }, /has CC\/BCC recipients \(boss@client\.example\)/],
      [{ bcc: ["spy@evil.example"] }, /has CC\/BCC recipients \(spy@evil\.example\)/],
      [{ attachments: 1 }, /has attachments/],
      [{ body: "   " }, /is empty/],
    ];
    let id = 60;
    for (const [draft, msg] of cases) {
      withDraft(++id, {}, draft);
      const before = fs.convPosts.length;
      await expect(reply(id, { draftThreadId: draftOf(id) }), msg.source).rejects.toThrow(msg);
      expect(fs.convPosts.slice(before).map((p) => p.find(([k]) => k === "action")?.[1])).toEqual(["load_draft"]);
    }
    expect(actions().every((a) => a === "load_draft")).toBe(true);
    expect(fs.replies).toEqual([]);
  });

  it("load_draft answers missing is_forward or attachments are refused (fail closed)", async () => {
    withDraft(9);
    for (const [strip, msg] of [["is_forward", /is a forward draft/], ["attachments", /did not say whether draft 50 has attachments/], ["to", /addressed to nobody/]] as const) {
      const port: FreeScoutPort = {
        getHtml: (path) => client.getHtml(path),
        async ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
          const r = await client.ajaxPost<{ data?: Record<string, unknown> }>(path, form as Record<string, string>);
          if (form.action === "load_draft" && r.data) delete r.data[strip];
          return r as T;
        },
      };
      await expect(sendReply(port, 9, { draftThreadId: 50 }, ON), strip).rejects.toThrow(msg);
    }
    expect(actions().every((a) => a === "load_draft")).toBe(true);
    expect(fs.replies).toEqual([]);
  });

  it("customer email compared case-insensitively with the stored To", async () => {
    withDraft(9, {}, { to: ["Customer@Client.example"] });
    const r = await reply(9, { draftThreadId: 50 });
    expect(r.sent_from_draft).toBe(true);
  });

  it("refuses with zero POSTs: other user's draft, a non-draft thread, a thread from another conversation", async () => {
    withDraft(9, {}, { by: 8 });
    await expect(reply(9, { draftThreadId: 50 })).rejects.toThrow(/not written \(or last edited\) by the logged-in user \(FreeScout shows it as Other Agent's\)/);
    await expect(reply(9, { draftThreadId: 40 })).rejects.toThrow(/thread 40 is a customer thread, not a reply draft/);
    fs.addConv(11);
    await expect(reply(11, { draftThreadId: 50 })).rejects.toThrow(/thread 50 is not on this conversation/);
    expect(posts()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: refusals before any POST", () => {
  it("gate off, both/neither of body and draft, bad status: no request at all", async () => {
    fs.addConv(9);
    await expect(reply(9, { body: "x" }, { enabled: false, mailboxes: [] })).rejects.toThrow(/disabled on this server/);
    await expect(reply(9, {})).rejects.toThrow(/exactly one of body/);
    await expect(reply(9, { body: "   " })).rejects.toThrow(/exactly one of body/);
    await expect(reply(9, { body: "x", draftThreadId: 50 })).rejects.toThrow(/exactly one of body/);
    await expect(reply(9, { draftThreadId: 0 })).rejects.toThrow(/positive integer/);
    for (const status of ["spam", "open", "4", "", "toString", "__proto__"]) {
      await expect(reply(9, { body: "x", status: status as never }), status).rejects.toThrow(/status must be active, pending or closed/);
    }
    expect(fs.requests).toEqual([]);
  });

  it("mailbox outside FREESCOUT_REPLY_MAILBOXES (read from the page), Spam, non-email, draft conversation, no customer email", async () => {
    fs.addConv(9, { mailbox_id: 2 });
    await expect(reply(9, { body: "x" }, { enabled: true, mailboxes: [1, 3] })).rejects.toThrow(/mailbox \(id 2\) is not in this server's FREESCOUT_REPLY_MAILBOXES \(1, 3\)/);
    fs.addConv(12, { status: 4 });
    await expect(reply(12, { body: "x" })).rejects.toThrow(/marked as Spam/);
    fs.addConv(13, { draft: true, threads: [] });
    await expect(reply(13, { body: "x" })).rejects.toThrow(/unsent draft conversation.*refusing to reply to/);
    fs.addConv(14, { no_customer_panel: true });
    await expect(reply(14, { body: "x" })).rejects.toThrow(/does not show the customer's email/);
    fs.addConv(15, { type: "phone" });
    await expect(reply(15, { body: "x" })).rejects.toThrow(/is a phone conversation/);
    fs.addConv(16, { type: "chat" });
    await expect(reply(16, { body: "x" })).rejects.toThrow(/is a chat conversation/);
    fs.addConv(17, { customer_email: "Cust <c@client.example>" });
    await expect(reply(17, { body: "x" })).rejects.toThrow(/is not one plain address/);
    fs.addConv(18, { reply_to_options: [["other@client.example", true], [CUSTOMER, false]] });
    await expect(reply(18, { body: "x" })).rejects.toThrow(/To field is preset to other@client\.example/);
    fs.addConv(19, { reply_to_options: [["other@client.example", false], [CUSTOMER, false]] });
    await expect(reply(19, { body: "x" })).rejects.toThrow(/To field is preset to no address/);
    expect(posts()).toEqual([]);
    expect(fs.replies).toEqual([]);
  });

  it("the mailbox list allows listed mailboxes", async () => {
    fs.addConv(9, { mailbox_id: 3 });
    await reply(9, { body: "x" }, { enabled: true, mailboxes: [1, 3] });
    expect(fs.replies).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: FreeScout errors and POSSIBLY SENT", () => {
  it("'Not enough permissions' is a PermissionError; a clean error envelope is a normal error (not sent)", async () => {
    fs.addConv(10);
    await expect(reply(10, { body: "x" })).rejects.toBeInstanceOf(PermissionError);
    fs.addConv(9);
    fs.misbehave.replyAnswer = { status: "error", msg: "Message is too large" };
    const e = await reply(9, { body: "x" }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("send_reply failed: Message is too large");
    expect((e as Error).message).not.toMatch(/POSSIBLY SENT/);
    expect(fs.replies).toEqual([]);
  });

  it("draft published meanwhile ('Message has been already sent') is a clean error, not POSSIBLY SENT", async () => {
    withDraft(9);
    fs.misbehave.teammate = (c) => {
      c.threads.find((t) => t.id === 50)!.type = "message";
    };
    const e = await reply(9, { draftThreadId: 50 }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("send_reply failed: Message has been already sent. Please discard this draft.");
    expect(fs.replies).toEqual([]);
  });

  it("ambiguous envelope -> POSSIBLY SENT", async () => {
    fs.addConv(9);
    fs.misbehave.replyAnswer = { msg: "" };
    const e = await reply(9, { body: "x" }).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^POSSIBLY SENT: the reply to customer@client\.example on conversation 9 may already have gone out\. Do NOT retry send_reply/);
    expect(fs.replies).toHaveLength(1);
  });

  it("dropped connection after FreeScout processed it -> POSSIBLY SENT (not a PermissionError)", async () => {
    fs.addConv(9);
    fs.misbehave.replyDropsConnection = true;
    const e = await reply(9, { body: "x" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FreeScoutError);
    expect(e).not.toBeInstanceOf(PermissionError);
    expect((e as Error).message).toMatch(/^POSSIBLY SENT:.*Do NOT retry/);
    expect(fs.replies).toHaveLength(1);
  });

  it("re-read fails after the reply was recorded -> POSSIBLY SENT", async () => {
    fs.addConv(9);
    fs.misbehave.rereadFailsAfterReply = true;
    await expect(reply(9, { body: "x" })).rejects.toThrow(/^POSSIBLY SENT:.*HTTP 502/);
    withDraft(8);
    fs.replies.length = 0; // the switch fires on the first page GET after a recorded reply
    fs.misbehave.rereadFailsAfterReply = true;
    await expect(reply(8, { draftThreadId: draftOf(8) })).rejects.toThrow(/^POSSIBLY SENT:/);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: after-state DANGER", () => {
  const danger = /^DANGER: after send_reply on conversation \d+, .*do NOT retry/;

  it("a note instead of the reply, two replies, a reassignment, an unexpected status", async () => {
    fs.addConv(9);
    fs.misbehave.replyAddsNote = true;
    await expect(reply(9, { body: "x" })).rejects.toThrow(/^DANGER: .*thread\(s\) \d+:note that are not the reply/);
    fs.misbehave = {};
    fs.addConv(8);
    fs.misbehave.replyAddsTwo = true;
    await expect(reply(8, { body: "x" })).rejects.toThrow(/^DANGER: .*2 new replies appeared/);
    fs.misbehave = {};
    fs.addConv(7);
    fs.misbehave.replyReassigns = 8;
    await expect(reply(7, { body: "x" })).rejects.toThrow(/^DANGER: .*assignee 7 -> 8/);
    fs.misbehave = {};
    fs.addConv(6, { status: 1 });
    fs.misbehave.replyChangesStatus = 3;
    await expect(reply(6, { body: "x" })).rejects.toThrow(/^DANGER: .*status is 3, expected 1/);
  });

  it("a reply shown to another address, with CC, by another author, or another thread vanished", async () => {
    fs.addConv(9);
    fs.misbehave.replyShowsTo = "victim@evil.example";
    await expect(reply(9, { body: "x" })).rejects.toThrow(/^DANGER: .*addressed to victim@evil\.example/);
    fs.misbehave = { replyShowsCc: ["spy@evil.example"] };
    fs.addConv(8);
    await expect(reply(8, { body: "x" })).rejects.toThrow(/^DANGER: .*CC recipients spy@evil\.example/);
    fs.misbehave = { replyAuthor: 8 };
    fs.addConv(7);
    await expect(reply(7, { body: "x" })).rejects.toThrow(danger);
    const c = fs.addConv(6);
    fs.misbehave = { replyAlsoRemoves: c.threads[0]!.id };
    await expect(reply(6, { body: "x" })).rejects.toThrow(/^DANGER: .*disappeared/);
  });

  it("draft path: a new thread instead of converting the draft is DANGER; a draft left as draft is an error (do not retry)", async () => {
    withDraft(9);
    fs.misbehave.replyDraftCreatesNew = true;
    await expect(reply(9, { draftThreadId: 50 })).rejects.toThrow(/^DANGER: .*new thread\(s\) \d+:message appeared/);
    fs.misbehave = { replyLeavesDraft: true };
    withDraft(8);
    await expect(reply(8, { draftThreadId: draftOf(8) })).rejects.toThrow(/^DANGER: .*still shown as a draft.*do NOT retry/);
  });

  it("FreeScout says success but nothing appeared -> error saying do not retry", async () => {
    fs.addConv(9);
    fs.misbehave.replyNoop = true;
    await expect(reply(9, { body: "x" })).rejects.toThrow(/^DANGER: .*accepted send_reply but no new reply appeared.*do NOT retry/);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: concurrent change", () => {
  it("a teammate's status change between our read and our POST -> success with a warning", async () => {
    fs.addConv(9, { status: 1, assignee_id: 7 });
    fs.misbehave.teammate = (c) => {
      c.status = 3;
      c.threads.push({ type: "lineitem", body: "You marked as Closed" });
    };
    const r = await reply(9, { body: "x" });
    expect(r).toMatchObject({ status: "active", concurrent_change_detected: true });
    expect(r.warning).toMatch(/re-check the status and assignee of conversation 9/);
    expect(fs.replies).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("sendReply: duplicate sends, edited drafts, mailbox and customer checks", () => {
  /** Port that runs `before` once, right before the first send_reply POST leaves. */
  const portWith = (base: FreeScoutPort, before: () => void): FreeScoutPort => {
    let done = false;
    return {
      getHtml: (path) => base.getHtml(path),
      ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
        if (form.action === "send_reply" && !done) {
          done = true;
          before();
        }
        return base.ajaxPost<T>(path, form as Record<string, string>);
      },
    };
  };
  const sendActions = () => actions().filter((a) => a === "send_reply");

  it("the first POST answered 419 (CSRF) is retried once by the session: exactly one reply processed", async () => {
    fs.addConv(9);
    const r = await sendReply(portWith(client, () => fs.rotateAllTokens()), 9, { body: "x" }, ON);
    expect(r.sent_to).toBe(CUSTOMER);
    expect(fs.replies).toHaveLength(1);
    expect(sendActions()).toHaveLength(1); // the 419 was answered before FreeScout's controller ran
  });

  it("logged out at the POST: re-login and one retry, exactly one reply processed; without credentials nothing is sent", async () => {
    fs.addConv(9);
    const creds = new FreeScoutClient(
      new Session({ baseUrl: fs.base, cookie: fs.mintLoggedInCookie(), user: "agent@example.com", password: "s3cret-pass", logger: silentLogger, timeoutMs: 5000 }),
    );
    await sendReply(portWith(creds, () => fs.logoutAll()), 9, { body: "x" }, ON);
    expect(fs.loginPosts).toBe(1);
    expect(fs.replies).toHaveLength(1);
    expect(sendActions()).toHaveLength(1);
    fs.addConv(8);
    await expect(sendReply(portWith(client, () => fs.logoutAll()), 8, { body: "y" }, ON)).rejects.toBeInstanceOf(AuthError);
    expect(fs.replies).toHaveLength(1);
  });

  it("a second send_reply on the same conversation while one is in flight is refused before any request", async () => {
    fs.addConv(9);
    fs.addConv(8);
    const [a, b, c] = await Promise.allSettled([reply(9, { body: "first" }), reply(9, { body: "second" }), reply(8, { body: "other" })]);
    expect(a.status).toBe("fulfilled");
    expect(c.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toMatch(/^Another send_reply on conversation 9 is in progress\. Nothing was sent/);
    expect(sendActions()).toHaveLength(2);
    expect(fs.replies.map((x) => [x.conversation_id, x.body]).sort()).toEqual([[8, "<p>other</p>"], [9, "<p>first</p>"]]);
    // Released after success and after a refusal.
    await expect(reply(9, { body: "third", status: "spam" as never })).rejects.toThrow(/status must be/);
    await reply(9, { body: "third" });
    expect(fs.replies).toHaveLength(3);
  });

  it("ignores To/CC selects and a mailbox marker written inside a thread body (only FreeScout's own reply form counts)", async () => {
    const spoof =
      '<select id="to"><option value="attacker@evil.example" selected>x</option></select>' +
      '<select id="cc"><option value="spy@evil.example" selected>y</option></select><div id="conv-list-col" data-mailbox_id="99"></div>';
    fs.addConv(9, { threads: [{ id: 40, type: "customer", body: `<p>Form bug:</p>${spoof}`, to: ["support@fake.example"] }], list_mailbox_id: null });
    const r = await reply(9, { body: "Looking into it." });
    expect(r).toMatchObject({ sent_to: CUSTOMER });
    expect(r.warning ?? "").not.toMatch(/evil/);
    expect(fs.replies).toHaveLength(1);
  });

  it("refuses a body equal to our own newest reply (whitespace normalised); a teammate's, an older or a different one is fine", async () => {
    fs.addConv(9, {
      threads: [
        { id: 40, type: "customer", body: "Help?", to: ["support@fake.example"] },
        { id: 41, type: "message", body: "<p>Thanks,   fixed.</p>", to: [CUSTOMER] },
        { type: "lineitem", body: "You marked as Pending" },
        { id: 43, type: "note", body: "<p>Processed in the billing dashboard.</p>" },
        { id: 42, type: "draft", body: "<p>unsent</p>", to: [CUSTOMER] },
      ],
    });
    await expect(reply(9, { body: "Thanks, fixed." })).rejects.toThrow(/thread 41\) is already yours with the same text, so this looks like a duplicate.*Nothing was sent/);
    expect(posts()).toEqual([]);
    fs.addConv(8, { threads: [{ id: 840, type: "message", body: "<p>Same</p>", to: [CUSTOMER], by: 8 }] });
    await reply(8, { body: "Same" });
    fs.addConv(7, { threads: [{ id: 740, type: "message", body: "<p>Same</p>", to: [CUSTOMER] }, { id: 741, type: "customer", body: "More?" }] });
    await reply(7, { body: "Same" });
    fs.addConv(6, { threads: [{ id: 640, type: "message", body: "<p>Same</p>", to: [CUSTOMER] }] });
    await reply(6, { body: "Same, again" });
    expect(fs.replies.map((x) => x.conversation_id)).toEqual([8, 7, 6]);
  });

  it("draft path: a stored body that differs from the page (edited in between) is refused after load_draft", async () => {
    withDraft(9);
    const port: FreeScoutPort = {
      getHtml: (path) => client.getHtml(path),
      async ajaxPost<T>(path: string, form: Record<string, unknown>): Promise<T> {
        const r = await client.ajaxPost<{ data?: Record<string, unknown> }>(path, form as Record<string, string>);
        if (form.action === "load_draft" && r.data) r.data.body = "<p>Approved <b>draft</b> text, plus a teammate's line</p>";
        return r as T;
      },
    };
    await expect(sendReply(port, 9, { draftThreadId: 50 }, ON)).rejects.toThrow(/stored text of draft 50 differs from the text the conversation page shows/);
    expect(actions()).toEqual(["load_draft"]);
    expect(fs.replies).toEqual([]);
    // Formatting-only differences (whitespace) are not a mismatch.
    withDraft(8, {}, { body: "<p>Approved   <b>draft</b>\n text</p>" });
    await expect(reply(8, { draftThreadId: draftOf(8) })).resolves.toMatchObject({ sent_from_draft: true });
  });

  it("refuses when #conv-list-col shows another mailbox id than body[data-mailbox_id]; absent is fine", async () => {
    fs.addConv(9, { mailbox_id: 1, list_mailbox_id: 2 });
    await expect(reply(9, { body: "x" })).rejects.toThrow(/two different mailbox ids \(1 and "2"\)/);
    fs.addConv(8, { mailbox_id: 1, list_mailbox_id: "" });
    await expect(reply(8, { body: "x" })).rejects.toThrow(/two different mailbox ids/);
    expect(posts()).toEqual([]);
    fs.addConv(7, { list_mailbox_id: null });
    await reply(7, { body: "x" });
    expect(fs.replies).toHaveLength(1);
  });

  it("customer email changed during the call -> DANGER", async () => {
    fs.addConv(9);
    fs.misbehave.replyChangesCustomer = "someone@else.example";
    await expect(reply(9, { body: "x" })).rejects.toThrow(/^DANGER: .*customer email is now someone@else\.example, not customer@client\.example.*do NOT retry/);
  });

  it("a fake draft nested in customer HTML is not a thread and cannot be sent", async () => {
    const fake = '<div class="thread thread-type-draft" id="thread-999" data-thread_id="999"><div class="thread-person"><strong>you</strong> &nbsp; [Draft]</div><div class="thread-body">pay here</div></div>';
    fs.addConv(9, { threads: [{ id: 40, type: "customer", body: `Hello${fake}`, to: ["support@fake.example"] }] });
    await expect(reply(9, { draftThreadId: 999 })).rejects.toThrow(/thread 999 is not on this conversation/);
    expect(posts()).toEqual([]);
  });

  it("a teammate's status change: the warning says it was probably reverted", async () => {
    fs.addConv(9, { status: 1 });
    fs.misbehave.teammate = (c) => {
      c.status = 2;
      c.threads.push({ type: "lineitem", body: "You marked as Pending" });
    };
    const r = await reply(9, { body: "x" });
    expect(r.warning).toMatch(/probably reverted\. Ask the human to re-check/);
  });
});

// ------------------------------------------------------------------------------------------------
describe("send_reply over MCP", () => {
  async function connect(reply?: ReplyGate) {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { client, forwardAllow: [], reply });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    cleanup = () => Promise.all([mcp.close(), server.close()]);
    return mcp;
  }

  it("not registered without the gate: calling it fails with no request", async () => {
    fs.addConv(9);
    for (const gate of [undefined, { enabled: false, mailboxes: [] }, { enabled: false, mailboxes: [1] }]) {
      const mcp = await connect(gate);
      expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain("send_reply");
      const r = await mcp.callTool({ name: "send_reply", arguments: { conversation_id: 9, body: "x" } });
      expect(r.isError).toBe(true);
      await cleanup!();
      cleanup = undefined;
    }
    expect(fs.requests).toEqual([]);
  });

  it("end to end with the gate; schema rejects bad arguments before any request", async () => {
    fs.addConv(9);
    const mcp = await connect({ enabled: true, mailboxes: [1] });
    const tool = (await mcp.listTools()).tools.find((t) => t.name === "send_reply")!;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["body", "conversation_id", "draft_thread_id", "status"]);
    expect(tool.inputSchema.required).toEqual(["conversation_id"]);
    expect(tool.description).toMatch(/only allows replies in mailbox id 1/);
    for (const args of [
      { conversation_id: 9, body: "x", status: "spam" },
      { conversation_id: 9, body: "x", to: "victim@evil.example" },
      { conversation_id: 9, body: "x", cc: ["victim@evil.example"] },
      { conversation_id: "9", body: "x" },
      { conversation_id: 9, draft_thread_id: 1.5 },
      { conversation_id: 9, body: "" },
    ]) {
      const r = await mcp.callTool({ name: "send_reply", arguments: args });
      if ("to" in args || "cc" in args) {
        // Unknown keys are stripped by the schema; nothing but the pinned form is ever posted.
        continue;
      }
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fs.replies.every((x) => x.to === CUSTOMER && x.cc.length === 0)).toBe(true);
    const ok = await mcp.callTool({ name: "send_reply", arguments: { conversation_id: 9, body: "Done.", status: "closed" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ reply: { sent_to: CUSTOMER, status: "closed", sent_from_draft: false } });
    for (const f of fs.convPosts) {
      expect(f.map(([k]) => k).filter((k) => k !== "_token")).toEqual(["action", "conversation_id", "mailbox_id", "body", "user_id", "status"]);
    }
  });
});
