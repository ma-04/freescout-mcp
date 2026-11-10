/**
 * create_conversation (new outbound conversation; draft by default, send gated by FREESCOUT_REPLY_ENABLED +
 * FREESCOUT_CREATE_SEND). Gate parsing and the form guard are tested directly; createConversation runs through a real
 * Session + FreeScoutClient against the fake FreeScout (test/fake-freescout.ts), which simulates save_draft / send_reply
 * with is_create, the New Conversation page and the draft-conversation view as read from FreeScout 1.8.248
 * (docs/freescout-endpoints.md §5.7).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FreeScoutClient, type FreeScoutPort, type HtmlPage } from "../src/client.js";
import { loadBaseConfig } from "../src/config.js";
import { AuthError, FreeScoutError, PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import {
  assertCreateForm,
  assertNoteForm,
  assertReplyForm,
  buildCreateDraftForm,
  buildCreateSendForm,
  buildDraftForm,
  buildNoteForm,
  buildReplyForm,
  createConversation,
  MAX_CREATE_CC,
  type CreateConversationInput,
  type CreateGate,
} from "../src/operations.js";
import { parseConversation, parseCreateForm } from "../src/parsers/conversation.js";
import { createSendAllowed, describeCreate, parseCreateSend, REPLY_DISABLED, type ReplyGate } from "../src/reply-gate.js";
import { Session } from "../src/session.js";
import { registerTools } from "../src/tools/index.js";
import { FakeFreeScout, newTicketPage } from "./fake-freescout.js";

const REPLY_ON: ReplyGate = { enabled: true, mailboxes: [] };
const SEND: CreateGate = { reply: REPLY_ON, createSend: true };
const DRAFT_ONLY: CreateGate = { reply: REPLY_ON, createSend: false };
const OFF: CreateGate = { reply: REPLY_DISABLED, createSend: false };
const TO = "partner@vendor.example";

let fs: FakeFreeScout;
let client: FreeScoutClient;
let cleanup: (() => Promise<unknown>) | undefined;

beforeEach(async () => {
  fs = new FakeFreeScout();
  fs.dashboardMailboxes = [[1, "Support"], [2, "Billing"]];
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
const create = (o: Partial<CreateConversationInput> = {}, gate: CreateGate = SEND) =>
  createConversation(client, { mailbox_id: 1, to: TO, subject: "Quarterly invoice", body: "Hello,\n\nplease find the details.", ...o }, gate);

// ------------------------------------------------------------------------------------------------
describe("FREESCOUT_CREATE_SEND", () => {
  it("on only for exactly 1/true, and only together with FREESCOUT_REPLY_ENABLED", () => {
    for (const v of ["1", "true", "TRUE", " True "]) expect(parseCreateSend({ FREESCOUT_CREATE_SEND: v }, true), v).toEqual({ enabled: true });
    for (const v of [undefined, "", "  ", "0", "false", "FALSE"]) {
      expect(parseCreateSend({ FREESCOUT_CREATE_SEND: v }, true), String(v)).toEqual({ enabled: false });
      expect(parseCreateSend({ FREESCOUT_CREATE_SEND: v }, false), String(v)).toEqual({ enabled: false });
    }
    const w = parseCreateSend({ FREESCOUT_CREATE_SEND: "1" }, false);
    expect(w.enabled).toBe(false);
    expect(w.warning).toMatch(/FREESCOUT_REPLY_ENABLED is not 1\/true: create_conversation stays draft-only/);
  });

  it("any other non-empty value stops the server", () => {
    for (const v of ["yes", "on", "enabled", "11", "1,", "t", "true1", "*", "send"]) {
      expect(() => parseCreateSend({ FREESCOUT_CREATE_SEND: v }, true), v).toThrow(/FREESCOUT_CREATE_SEND: invalid value/);
      expect(() => parseCreateSend({ FREESCOUT_CREATE_SEND: v }, false), v).toThrow(/FREESCOUT_CREATE_SEND: invalid value/);
    }
  });

  it("loadBaseConfig: unset = off (existing installs, even with replies on); both set = on; malformed stops startup", () => {
    const base = { FREESCOUT_URL: "https://fs.example" };
    expect(loadBaseConfig(base).createSend).toBe(false);
    expect(loadBaseConfig({ ...base, FREESCOUT_REPLY_ENABLED: "1" }).createSend).toBe(false);
    expect(loadBaseConfig({ ...base, FREESCOUT_REPLY_ENABLED: "1" }).reply).toEqual({ enabled: true, mailboxes: [] });
    expect(loadBaseConfig({ ...base, FREESCOUT_CREATE_SEND: "1" }).createSend).toBe(false);
    expect(loadBaseConfig({ ...base, FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_CREATE_SEND: "true" }).createSend).toBe(true);
    expect(() => loadBaseConfig({ ...base, FREESCOUT_REPLY_ENABLED: "1", FREESCOUT_CREATE_SEND: "yes" })).toThrow(/FREESCOUT_CREATE_SEND/);
  });

  it("createSendAllowed needs both switches and respects FREESCOUT_REPLY_MAILBOXES; describeCreate says which", () => {
    expect(createSendAllowed(REPLY_ON, true, 5)).toBe(true);
    expect(createSendAllowed(REPLY_ON, false, 5)).toBe(false);
    expect(createSendAllowed(REPLY_DISABLED, true, 5)).toBe(false);
    expect(createSendAllowed({ enabled: true, mailboxes: [1, 3] }, true, 3)).toBe(true);
    expect(createSendAllowed({ enabled: true, mailboxes: [1, 3] }, true, 2)).toBe(false);
    expect(describeCreate(REPLY_DISABLED, true)).toMatch(/drafts only/);
    expect(describeCreate(REPLY_ON, false)).toMatch(/drafts only/);
    expect(describeCreate(REPLY_ON, true)).toMatch(/can SEND .* every mailbox/);
    expect(describeCreate({ enabled: true, mailboxes: [3] }, true)).toMatch(/limited to mailbox id 3$/);
  });
});

// ------------------------------------------------------------------------------------------------
describe("create forms", () => {
  const input = { mailbox_id: 1, to: TO, cc: ["a@team.example"], bcc: ["b@team.example"], subject: "S", body: "<p>b</p>", status: 2 };

  it("draft form: exactly save_draft + is_create + type 1 + one to, no ids, no user_id/after_send", () => {
    const f = buildCreateDraftForm(input);
    expect(f).toEqual({ action: "save_draft", mailbox_id: "1", is_create: "1", type: "1", to: [TO], subject: "S", body: "<p>b</p>", status: "2", cc: ["a@team.example"], bcc: ["b@team.example"] });
    expect(Object.keys(buildCreateDraftForm({ ...input, cc: [], bcc: [] })).sort()).toEqual(["action", "body", "is_create", "mailbox_id", "status", "subject", "to", "type"]);
  });

  it("send form: send_reply + is_create + user_id + after_send=1, nothing else", () => {
    const f = buildCreateSendForm({ ...input, user_id: -1 });
    expect(Object.keys(f).sort()).toEqual(["action", "after_send", "bcc", "body", "cc", "is_create", "mailbox_id", "status", "subject", "to", "type", "user_id"]);
    expect(f).toMatchObject({ action: "send_reply", after_send: "1", user_id: "-1", to: [TO] });
  });

  it("assertCreateForm refuses ids, extra recipients, note/forward/alias keys and malformed values", () => {
    const send = buildCreateSendForm({ ...input, user_id: 7 });
    const draft = buildCreateDraftForm(input);
    const bad: Array<[Record<string, unknown>, "draft" | "send"]> = [
      [{ conversation_id: "9" }, "send"], [{ conversation_id: "" }, "send"], [{ thread_id: "50" }, "send"], [{ thread_id: "50" }, "draft"],
      [{ conversation_id: "9" }, "draft"], [{ multiple_conversations: "1" }, "send"], [{ is_note: "1" }, "send"], [{ subtype: "1" }, "send"],
      [{ to_email: ["x@evil.example"] }, "send"], [{ "to[]": "x@evil.example" }, "send"], [{ from_alias: "a@b.example" }, "send"],
      [{ attachments: ["x"] }, "send"], [{ conv_history: "full" }, "send"], [{ customer_id: "4" }, "send"], [{ saved_reply_id: "1" }, "send"],
      [{ to: [TO, "x@evil.example"] }, "send"], [{ to: [] }, "send"], [{ to: "x@evil.example" }, "send"], [{ to: ["Name <x@evil.example>"] }, "send"],
      [{ to: ["X@Evil.example"] }, "send"], [{ to: ["x@evil.example, y@evil.example"] }, "send"], [{ cc: [TO] }, "send"],
      [{ cc: ["a@team.example"], bcc: ["a@team.example"] }, "send"], [{ cc: Array.from({ length: 11 }, (_, i) => `c${i}@team.example`) }, "send"],
      [{ cc: Array.from({ length: 6 }, (_, i) => `c${i}@team.example`), bcc: Array.from({ length: 5 }, (_, i) => `b${i}@team.example`) }, "send"],
      [{ cc: [] }, "send"], [{ type: "2" }, "send"], [{ type: "" }, "send"], [{ is_create: "" }, "send"], [{ action: "save_draft" }, "send"],
      [{ action: "send_reply" }, "draft"], [{ status: "4" }, "send"], [{ status: "" }, "draft"], [{ user_id: "0" }, "send"],
      [{ after_send: "3" }, "send"], [{ user_id: "7" }, "draft"], [{ after_send: "1" }, "draft"], [{ subject: "" }, "send"],
      [{ subject: "a\r\nBcc: x@evil.example" }, "send"], [{ subject: "x".repeat(999) }, "send"], [{ body: " " }, "draft"],
      [{ mailbox_id: "1,2" }, "send"], [{ mailbox_id: ["1"] }, "send"],
    ];
    for (const [extra, mode] of bad) {
      const base = mode === "send" ? send : draft;
      expect(() => assertCreateForm({ ...base, ...extra }, mode), `${mode} ${JSON.stringify(extra)}`).toThrow(FreeScoutError);
    }
    const noUser: Record<string, unknown> = { ...send };
    delete noUser.user_id;
    expect(() => assertCreateForm(noUser, "send")).toThrow(/user_id missing/);
    expect(() => assertCreateForm(send, "draft")).toThrow(/forbidden field/);
    expect(() => assertCreateForm(draft, "send")).toThrow(/missing/);
    expect(() => assertCreateForm({ ...send, cc: Array.from({ length: MAX_CREATE_CC }, (_, i) => `c${i}@team.example`), bcc: undefined }, "send")).toThrow(/bcc is not an array/);
  });

  it("existing guards are as strict as before: note/reply/draft forms still refuse is_create and recipients", () => {
    const note = buildNoteForm({ conversation_id: 9, mailbox_id: 1, user_id: 2, status: 1, body: "b" });
    expect(() => assertNoteForm({ ...note, is_create: "1" })).toThrow(FreeScoutError);
    const reply = buildReplyForm({ conversation_id: 9, mailbox_id: 1, body: "b", user_id: 2, status: 1 });
    for (const bad of [{ is_create: "1" }, { to: ["x@y.example"] }, { subject: "s" }, { after_send: "1" }, { type: "1" }]) {
      expect(() => assertReplyForm({ ...reply, ...bad }, "new"), JSON.stringify(bad)).toThrow(FreeScoutError);
    }
    expect(Object.keys(buildDraftForm({ conversation_id: 9, mailbox_id: 1, body: "b" }))).toEqual(["action", "conversation_id", "mailbox_id", "thread_id", "body"]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("refusals before any request", () => {
  function counting(): { port: FreeScoutPort; calls: string[] } {
    const calls: string[] = [];
    const port: FreeScoutPort = {
      async getHtml(p: string): Promise<HtmlPage> { calls.push(`GET ${p}`); throw new Error("must not be called"); },
      async ajaxPost<T>(p: string): Promise<T> { calls.push(`POST ${p}`); throw new Error("must not be called"); },
    };
    return { port, calls };
  }
  const base: CreateConversationInput = { mailbox_id: 1, to: TO, subject: "S", body: "b" };
  const cases: Array<[string, Partial<CreateConversationInput>, CreateGate, RegExp]> = [
    ["send, both switches off", { send: true }, OFF, /sending new conversations is disabled.*Nothing was created or sent/],
    ["send, replies on but FREESCOUT_CREATE_SEND off", { send: true }, DRAFT_ONLY, /needs FREESCOUT_REPLY_ENABLED=1 and FREESCOUT_CREATE_SEND=1/],
    ["send, createSend without reply gate", { send: true }, { reply: REPLY_DISABLED, createSend: true }, /disabled/],
    ["send, mailbox outside FREESCOUT_REPLY_MAILBOXES", { send: true, mailbox_id: 2 }, { reply: { enabled: true, mailboxes: [1] }, createSend: true }, /mailbox 2 is not in this server's FREESCOUT_REPLY_MAILBOXES \(1\)/],
    ["draft with assignee", { assignee: "me" }, SEND, /assignee only works with send=true/],
    ["draft with tags", { tags: ["vip"] }, SEND, /tags only work with send=true/],
    ["to with a name", { to: "Victim <victim@evil.example>" }, SEND, /to: Recipient must be one bare email address/],
    ["two addresses in to", { to: "a@x.example,b@x.example" }, SEND, /to: Recipient must be one bare/],
    ["to not an address", { to: "nobody" }, SEND, /to: Recipient is not a valid single email address/],
    ["cc with a name", { cc: ["Boss boss@x.example"] }, SEND, /cc: Recipient must be one bare/],
    ["to repeated in cc", { cc: [TO] }, SEND, /is the To address; do not repeat it/],
    ["to repeated in bcc (case-insensitive)", { bcc: [TO.toUpperCase()] }, SEND, /is the To address/],
    ["same address in cc and bcc", { cc: ["a@x.example"], bcc: ["a@x.example"] }, SEND, /in both cc and bcc/],
    ["more than 10 cc+bcc", { cc: Array.from({ length: 6 }, (_, i) => `c${i}@x.example`), bcc: Array.from({ length: 5 }, (_, i) => `b${i}@x.example`) }, SEND, /together have 11 addresses \(max 10\)/],
    ["subject with a line break", { subject: "Hi\nBcc: victim@evil.example" }, SEND, /line breaks or control characters/],
    ["blank subject", { subject: "   " }, SEND, /subject is empty/],
    ["spam status", { status: "spam" as never }, SEND, /status must be active, pending or closed/],
    ["bad assignee", { send: true, assignee: "everyone" as never }, SEND, /assignee must be/],
    ["bad tag", { send: true, tags: ["a,b"] }, SEND, /invalid tag/],
    ["mailbox 0", { mailbox_id: 0 }, SEND, /mailbox_id must be a positive integer/],
  ];
  for (const [name, o, gate, re] of cases) {
    it(name, async () => {
      const { port, calls } = counting();
      await expect(createConversation(port, { ...base, ...o }, gate)).rejects.toThrow(re);
      expect(calls).toEqual([]);
    });
  }

  it("send=true while off is never downgraded: no draft is created either (real fake server)", async () => {
    await expect(create({ send: true }, DRAFT_ONLY)).rejects.toThrow(/disabled/);
    expect(fs.convPosts).toEqual([]);
    expect(fs.createdDrafts).toEqual([]);
    expect(posts()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("draft mode (default, ungated)", () => {
  it("one pinned save_draft + is_create POST; the draft is re-read from FreeScout's create view; nothing emailed", async () => {
    const r = await create({ cc: ["Ops@Team.example", "ops@team.example"], bcc: ["audit@team.example"] }, OFF);
    expect(wire()).toEqual([
      ["action", "save_draft"], ["mailbox_id", "1"], ["is_create", "1"], ["type", "1"], ["to[]", TO],
      ["subject", "Quarterly invoice"], ["body", "<p>Hello,</p><p>please find the details.</p>"], ["status", "1"],
      ["cc[]", "ops@team.example"], ["bcc[]", "audit@team.example"],
    ]);
    expect(fs.convPosts).toHaveLength(1);
    expect(fs.emails).toEqual([]);
    const id = fs.createdDrafts[0]!;
    expect(r).toMatchObject({
      mode: "draft", sent: false, conversation_id: id, number: id, mailbox_id: 1, to: TO, cc: ["ops@team.example"], bcc: ["audit@team.example"],
      subject: "Quarterly invoice", status: "active",
    });
    expect(r.thread_id).toBe(fs.convs.get(id)!.threads[0]!.id);
    expect(r.note).toMatch(/Nothing was emailed.*cannot send or delete a draft conversation/);
    expect(r.warning).toBeUndefined();
    // The mailbox list and the New Conversation page were read first.
    const gets = fs.requests.filter((q) => q.method === "GET").map((q) => q.path);
    expect(gets.slice(0, 2)).toEqual(["/", "/mailbox/1/new-ticket"]);
    expect(gets.at(-1)).toBe(`/conversation/${id}`);
  });

  it("works with neither reply variable set; send defaults to false", async () => {
    await expect(create({}, OFF)).resolves.toMatchObject({ mode: "draft", sent: false });
    await expect(create({ send: false, subject: "other" }, OFF)).resolves.toMatchObject({ mode: "draft" });
    expect(fs.emails).toEqual([]);
  });

  it("status: requested value stored; otherwise FreeScout's preselected default; warns when the Send form preselects another", async () => {
    fs.newTicket = { statusSelected: 2 };
    const a = await create({}, OFF);
    expect(wire(0)).toContainEqual(["status", "2"]);
    expect(a.status).toBe("pending");
    const b = await create({ status: "closed", subject: "closed one" }, OFF);
    expect(wire(1)).toContainEqual(["status", "3"]);
    expect(b.status).toBe("closed");
    expect(b.warning).toMatch(/stores status closed, but FreeScout's Send form preselects active/);
  });

  it("mailbox not on the dashboard: refused before any POST", async () => {
    await expect(create({ mailbox_id: 5 }, OFF)).rejects.toThrow(/mailbox 5 is not one of the mailboxes this account can access/);
    expect(posts()).toEqual([]);
  });

  it("New Conversation page forbidden (403): PermissionError, nothing posted", async () => {
    await expect(create({ mailbox_id: 2 }, OFF)).rejects.toBeInstanceOf(PermissionError);
    expect(posts()).toEqual([]);
  });

  it("success without ids: POSSIBLY CREATED (a draft may exist; nothing was emailed)", async () => {
    fs.misbehave.draftNoIds = true;
    await expect(create({}, OFF)).rejects.toThrow(/^POSSIBLY CREATED: a draft conversation may have been created in mailbox 1 \(nothing was emailed/);
  });

  it("re-read shows another recipient: error naming the created draft, no retry", async () => {
    fs.misbehave.draftShowsTo = ["victim@evil.example"];
    await expect(create({}, OFF)).rejects.toThrow(/created draft conversation 300 .*addressed to victim@evil\.example, not partner@vendor\.example\. Do NOT create it again/);
    expect(fs.emails).toEqual([]);
  });

  it("draft stored published: DANGER", async () => {
    fs.misbehave.draftPublishes = true;
    await expect(create({}, OFF)).rejects.toThrow(/^DANGER: create_conversation asked FreeScout for a DRAFT, but conversation 300 is not shown as an unsent draft/);
  });

  it("stored status differs from the requested one: warning", async () => {
    fs.misbehave.draftStoresStatus = 1;
    const r = await create({ status: "pending" }, OFF);
    expect(r.warning).toMatch(/FreeScout stored status 1 on the draft, not 2 as requested/);
  });

  it("FreeScout error envelope: plain error (not POSSIBLY CREATED), nothing created", async () => {
    fs.misbehave.draftAnswer = { status: "error", msg: "Message has been already sent. Please discard this draft." };
    const e = await create({}, OFF).catch((x) => x);
    expect(e.message).toMatch(/^create_conversation \(draft\) failed: Message has been already sent/);
    expect(fs.createdDrafts).toEqual([]);
  });

  it("connection dropped after the draft POST: POSSIBLY CREATED", async () => {
    fs.misbehave.createDropsConnection = true;
    await expect(create({}, OFF)).rejects.toThrow(/^POSSIBLY CREATED: .*Drafts folder/);
    expect(fs.createdDrafts).toHaveLength(1);
    expect(fs.emails).toEqual([]);
  });

  it("a non-English UI does not block drafts", async () => {
    fs.newTicket = { anyone: "Jeder" };
    await expect(create({}, OFF)).resolves.toMatchObject({ mode: "draft" });
  });

  it("re-read fails: error with the id (nothing emailed)", async () => {
    fs.misbehave.rereadFailsAfterCreate = true;
    await expect(create({}, OFF)).rejects.toThrow(/created draft conversation 300 \(draft thread \d+, nothing was emailed\) but it could not be re-read/);
  });

  it("two overlapping identical calls: the second is refused", async () => {
    const [a, b] = await Promise.allSettled([create({}, OFF), create({}, OFF)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toMatch(/another create_conversation to partner@vendor\.example with this subject/);
    expect(fs.createdDrafts).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("send mode (FREESCOUT_REPLY_ENABLED + FREESCOUT_CREATE_SEND)", () => {
  it("one pinned send_reply + is_create POST; recipients exactly as requested; result from the re-read", async () => {
    const r = await create({ send: true, cc: ["ops@team.example"], bcc: ["audit@team.example"], status: "pending", assignee: "me" });
    expect(wire()).toEqual([
      ["action", "send_reply"], ["mailbox_id", "1"], ["is_create", "1"], ["type", "1"], ["to[]", TO],
      ["subject", "Quarterly invoice"], ["body", "<p>Hello,</p><p>please find the details.</p>"], ["status", "2"], ["user_id", "7"],
      ["after_send", "1"], ["cc[]", "ops@team.example"], ["bcc[]", "audit@team.example"],
    ]);
    expect(fs.emails).toEqual([{ conversation_id: 300, to: [TO], cc: ["ops@team.example"], bcc: ["audit@team.example"], body: "<p>Hello,</p><p>please find the details.</p>", via: "create" }]);
    expect(r).toMatchObject({
      mode: "sent", sent: true, conversation_id: 300, number: 300, mailbox_id: 1, to: TO, cc: ["ops@team.example"], bcc: ["audit@team.example"],
      subject: "Quarterly invoice", status: "pending", assignee: "Agnes (you)",
    });
    expect(r.undo_note).toMatch(/treat it as sent/);
    expect(r.warning).toBeUndefined();
    expect(fs.createdDrafts).toEqual([]);
  });

  it("assignee: unassigned -> -1; a user id the form offers; default = the form's preselection (else Anyone)", async () => {
    await create({ send: true, assignee: "unassigned" });
    expect(wire(0)).toContainEqual(["user_id", "-1"]);
    await create({ send: true, assignee: 8, subject: "two" });
    expect(wire(1)).toContainEqual(["user_id", "8"]);
    await create({ send: true, subject: "three" });
    expect(wire(2)).toContainEqual(["user_id", "-1"]);
    fs.newTicket = { userSelected: 7, statusSelected: 3 };
    await create({ send: true, subject: "four" });
    expect(wire(3)).toContainEqual(["user_id", "7"]);
    expect(wire(3)).toContainEqual(["status", "3"]);
  });

  it("assignee not offered in this mailbox: refused before the POST", async () => {
    await expect(create({ send: true, assignee: 99 })).rejects.toThrow(/user 99 is not an assignee FreeScout offers in mailbox 1 \(offered: -1, 7, 8/);
    expect(posts()).toEqual([]);
  });

  it("FreeScout ignores the assignee (no mailbox access): sent, with a warning instead of an error", async () => {
    fs.assignable = [7];
    const r = await create({ send: true, assignee: 8 });
    expect(r.sent).toBe(true);
    expect(r.warning).toMatch(/was sent, but assignee id is -1, requested 8\. .*do not create it again/);
  });

  it("FreeScout validation error: plain error, nothing sent", async () => {
    fs.misbehave.createAnswer = { status: "error", msg: "Incorrect recipients" };
    const e = await create({ send: true }).catch((x) => x);
    expect(e).toBeInstanceOf(FreeScoutError);
    expect(e.message).toMatch(/create_conversation failed: Incorrect recipients/);
    expect(e.message).not.toMatch(/POSSIBLY SENT/);
    expect(fs.emails).toEqual([]);
  });

  it("success without a conversation in redirect_url: POSSIBLY SENT naming the mailbox", async () => {
    fs.misbehave.createAnswer = { status: "success", msg: "", redirect_url: `${"http://x"}/mailbox/1/3` };
    await expect(create({ send: true })).rejects.toThrow(/^POSSIBLY SENT: a new conversation to partner@vendor\.example may already have been created and emailed\. Do NOT retry .*check mailbox 1/);
  });

  it("connection dropped after the POST: POSSIBLY SENT", async () => {
    fs.misbehave.createDropsConnection = true;
    await expect(create({ send: true })).rejects.toThrow(/^POSSIBLY SENT:/);
    expect(fs.emails).toHaveLength(1);
  });

  it("re-read fails: POSSIBLY SENT naming the conversation", async () => {
    fs.misbehave.rereadFailsAfterCreate = true;
    await expect(create({ send: true })).rejects.toThrow(/^POSSIBLY SENT: .*check conversation 300 in FreeScout/);
  });

  it("non-envelope answer: POSSIBLY SENT", async () => {
    fs.misbehave.createAnswer = "oops";
    await expect(create({ send: true })).rejects.toThrow(/^POSSIBLY SENT:/);
  });

  const dangers: Array<[string, Partial<FakeFreeScout["misbehave"]>, RegExp]> = [
    ["another To shown", { createShowsTo: ["victim@evil.example"] }, /addressed to victim@evil\.example, not partner@vendor\.example/],
    ["an extra Cc shown", { createShowsCc: ["victim@evil.example"] }, /its Cc is victim@evil\.example, not empty/],
    ["a Bcc nobody asked for", { createShowsBcc: ["victim@evil.example"] }, /its Bcc is victim@evil\.example, not empty/],
    ["another mailbox", { createMovesMailbox: 2 }, /it is in mailbox 2, not 1/],
    ["still a draft", { createStaysDraft: true }, /shows it as an unsent draft/],
    ["two messages", { createAddsTwo: true }, /has 2 agent threads/],
  ];
  for (const [name, mis, re] of dangers) {
    it(`after-state: ${name} -> DANGER`, async () => {
      Object.assign(fs.misbehave, mis);
      const e = await create({ send: true }).catch((x) => x);
      expect(e.message).toMatch(/^DANGER: after create_conversation \(conversation 300\)/);
      expect(e.message).toMatch(re);
      expect(e.message).toMatch(/do NOT retry/);
    });
  }

  it("tags requested but no Tags module: refused before the POST (nothing sent)", async () => {
    await expect(create({ send: true, tags: ["vip"] })).rejects.toThrow(/Tags module does not answer.*Nothing was created or sent/);
    expect(fs.emails).toEqual([]);
    expect(fs.convPosts).toEqual([]);
  });

  it("non-English FreeScout UI: send refused before the POST (the after-send checks read English labels)", async () => {
    fs.newTicket = { anyone: "Jeder" };
    await expect(create({ send: true })).rejects.toThrow(/send mode needs an English FreeScout UI .*"Jeder".*Nothing was created or sent/);
    expect(posts()).toEqual([]);
  });

  it("tags after sending: added through add_tag's pinned form and confirmed on the re-read", async () => {
    fs.tags = ["vip"];
    fs.tagNewConversations = true;
    const r = await create({ send: true, tags: ["vip", "VIP", "renewal"] });
    expect(r.tags).toMatchObject({ conversation_id: 300, tags_before: [], added: ["vip", "renewal"], tags_after: ["vip", "renewal"] });
    expect(r.tags_error).toBeUndefined();
    expect(r.warning).toBeUndefined();
    expect(fs.tagPosts.map((p) => p.filter(([k]) => k !== "_token"))).toEqual([
      [["action", "add"], ["tag_names[]", "vip"], ["tag_names[]", "renewal"], ["conversation_id", "300"]],
    ]);
  });

  it("tag failure after sending: the result reports the created id, sent=true and the failure (not an error)", async () => {
    fs.tags = ["vip"]; // module present (autocomplete answers); the new conversation shows no tag controls -> add_tag fails
    const r = await create({ send: true, tags: ["vip"] });
    expect(r).toMatchObject({ sent: true, conversation_id: 300 });
    expect(r.tags).toBeUndefined();
    expect(r.tags_error).toMatch(/has no tag controls/);
    expect(r.warning).toMatch(/Conversation 300 WAS created and sent, but adding the tags failed .*Do NOT create it again/);
    expect(fs.emails).toHaveLength(1);
    expect(fs.tagPosts).toEqual([]);
  });

  it("logged out before the POST: AuthError, nothing sent", async () => {
    fs.logoutAll();
    await expect(create({ send: true })).rejects.toBeInstanceOf(AuthError);
    expect(fs.emails).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("parseCreateForm", () => {
  it("reads FreeScout's create form and toolbar only (synthetic page built from the blade source)", () => {
    const $ = cheerio.load(newTicketPage("https://x", "tok", 3, 7, { statusSelected: 2, userSelected: 7, users: [[9, "Nine"]] }));
    expect(parseCreateForm($)).toMatchObject({
      present: true, conversation_id: null, thread_id: null, mailbox_id: 3, body_mailbox_id: 3, to: [], cc: [], bcc: [],
      status_options: [1, 2, 3], status_selected: 2, user_options: [-1, 7, 9], user_selected: 7, current_user_id: 7,
    });
    expect(parseCreateForm(cheerio.load("<html><body></body></html>")).present).toBe(false);
  });

  it("real captured draft-conversation page (docs/fixtures/conversation-13-new-draft.html, FreeScout 1.8.248)", () => {
    const html = readFileSync(fileURLToPath(new URL("../docs/fixtures/conversation-13-new-draft.html", import.meta.url)), "utf8");
    const $ = cheerio.load(html);
    expect(parseCreateForm($)).toEqual({
      present: true, conversation_id: 13, thread_id: 26, mailbox_id: 1, body_mailbox_id: 1, type: 1,
      to: ["draft-test@customer.example"], cc: [], bcc: [], subject: "MCP draft-conversation test", body: "<p>unsent new conversation</p>",
      // Stored status Active, but the Send form preselects the mailbox default (Pending): why draft mode warns.
      status_options: [1, 2, 3], status_selected: 2, stored_status: 1,
      user_options: [-1, 2, 1], user_selected: 2, anyone_label: "Anyone", current_user_id: 2,
    });
    const conv = parseConversation($, "https://freescout.example.com/conversation/13");
    expect(conv).toMatchObject({ id: 13, mailbox_id: 1, is_draft_conversation: true, threads: [] });
  });
});

// ------------------------------------------------------------------------------------------------
describe("create_conversation through the MCP tool", () => {
  async function connect(ctx: { reply?: ReplyGate; createSend?: boolean }) {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { client, forwardAllow: [], ...ctx });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    cleanup = () => Promise.all([mcp.close(), server.close()]);
    return mcp;
  }
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

  it("always registered; send=true refused unless both switches are on; the description says which", async () => {
    for (const ctx of [{}, { reply: REPLY_ON }, { createSend: true }, { reply: REPLY_DISABLED, createSend: true }]) {
      const mcp = await connect(ctx);
      const tool = (await mcp.listTools()).tools.find((t) => t.name === "create_conversation")!;
      expect(tool, JSON.stringify(ctx)).toBeDefined();
      expect(tool.description).toMatch(/send=true is DISABLED on this server/);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(
        ["assignee", "bcc", "body", "cc", "mailbox_id", "send", "status", "subject", "tags", "to"],
      );
      expect((tool.inputSchema as { required: string[] }).required.sort()).toEqual(["body", "mailbox_id", "subject", "to"]);
      const r = await mcp.callTool({ name: "create_conversation", arguments: { mailbox_id: 1, to: TO, subject: "s", body: "b", send: true } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/sending new conversations is disabled/);
      await cleanup!();
      cleanup = undefined;
    }
    expect(posts()).toEqual([]);
    expect(fs.emails).toEqual([]);
  });

  it("with both switches on: the description says so and send=true sends; mailbox list narrows it", async () => {
    let mcp = await connect({ reply: REPLY_ON, createSend: true });
    let tool = (await mcp.listTools()).tools.find((t) => t.name === "create_conversation")!;
    expect(tool.description).toMatch(/send=true IS ENABLED on this server/);
    const r = await mcp.callTool({ name: "create_conversation", arguments: { mailbox_id: 1, to: TO, subject: "s", body: "b", send: true } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).conversation).toMatchObject({ sent: true, mode: "sent" });
    await cleanup!();
    mcp = await connect({ reply: { enabled: true, mailboxes: [2] }, createSend: true });
    tool = (await mcp.listTools()).tools.find((t) => t.name === "create_conversation")!;
    expect(tool.description).toMatch(/limited to mailbox id 2/);
    const r2 = await mcp.callTool({ name: "create_conversation", arguments: { mailbox_id: 1, to: TO, subject: "s2", body: "b", send: true } });
    expect(text(r2)).toMatch(/mailbox 1 is not in this server's FREESCOUT_REPLY_MAILBOXES \(2\)/);
    expect(fs.emails).toHaveLength(1);
  });

  it("draft through the tool: result under `conversation`", async () => {
    const mcp = await connect({});
    const r = await mcp.callTool({ name: "create_conversation", arguments: { mailbox_id: 1, to: TO, subject: "s", body: "b" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).conversation).toMatchObject({ mode: "draft", sent: false, conversation_id: 300 });
    const bad = await mcp.callTool({ name: "create_conversation", arguments: { mailbox_id: 1, to: TO, subject: "s", body: "b", assignee: "me" } });
    expect(text(bad)).toMatch(/assignee only works with send=true/);
  });
});
