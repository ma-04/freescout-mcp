/**
 * Live tool tests against the demo FreeScout (docs/demo.md), run as the restricted agent:
 *   demo/reset.sh   # known ids/state first
 *   FREESCOUT_URL=https://freescout.example.com FREESCOUT_USER=agent@freescout.example.com \
 *   FREESCOUT_PASSWORD=... [FREESCOUT_DEMO_SSH=user@host] npx vitest run test/integration-tools.test.ts
 *
 * With FREESCOUT_DEMO_SSH set, the note test also checks the database over ssh (threads.type and
 * send_logs). It writes notes/drafts only on Support conversation 1.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { FreeScoutClient } from "../src/client.js";
import { PermissionError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import * as ops from "../src/operations.js";
import { Session } from "../src/session.js";
import * as stats from "../src/stats.js";

const { FREESCOUT_URL: url, FREESCOUT_USER: user, FREESCOUT_PASSWORD: password, FREESCOUT_DEMO_SSH: sshHost } = process.env;
const enabled = Boolean(url && user && password);

/** Run SQL in the demo DB container; the password is read from the server's .env, never sent from here. */
function sql(query: string): string[][] {
  const remote =
    `cd ~/${new URL(url!).host} && set -a && . ./.env && set +a && ` +
    `docker exec -i -e MYSQL_PWD="$DB_PASS" freescout-demo-db mariadb -N -B -u freescout freescout`;
  const out = execFileSync("ssh", [sshHost!, remote], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  return out
    .split("\n")
    .filter((l) => l && !l.startsWith("Downloading More Ram"))
    .map((l) => l.split("\t"));
}

describe.skipIf(!enabled)("live tools as the restricted agent", () => {
  let c: FreeScoutClient;
  beforeAll(() => {
    c = new FreeScoutClient(new Session({ baseUrl: url!, user, password, logger: silentLogger, timeoutMs: 20_000 }));
  });

  it("list_mailboxes shows only Support, with its folders", async () => {
    const boxes = await ops.listMailboxes(c);
    expect(boxes.map((b) => [b.id, b.name])).toEqual([[1, "Support"]]);
    const types = boxes[0]!.folders.map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(["unassigned", "mine", "starred", "assigned", "closed", "spam"]));
    expect(boxes[0]!.folders.find((f) => f.type === "mine")?.id).toBe(17);
  }, 60_000);

  it("list_conversations matches the seeded folders", async () => {
    const ids = async (f: ops.FolderArg) => (await ops.listConversations(c, 1, f)).conversations.map((r) => r.id);
    expect(await ids("unassigned")).toEqual([1, 4, 7]);
    expect(await ids("mine")).toEqual([9, 2, 3]);
    expect(await ids("starred")).toEqual([2]);
    expect(await ids("assigned")).toEqual([6]);
    expect(await ids("closed")).toEqual([5, 8]);
    expect(await ids(17)).toEqual([9, 2, 3]);
    const closed = await ops.listConversations(c, 1, "closed");
    expect(closed.conversations.every((r) => r.status === "closed")).toBe(true);
    const mine = await ops.listConversations(c, 1, "mine");
    expect(mine.conversations.find((r) => r.id === 2)).toMatchObject({ starred: true, thread_count: 3, status: "active" });
    expect(mine.conversations.find((r) => r.id === 3)?.status).toBe("pending");
  }, 60_000);

  it("list_conversations on Billing is a PermissionError", async () => {
    await expect(ops.listConversations(c, 2, "unassigned")).rejects.toBeInstanceOf(PermissionError);
  }, 60_000);

  it("search_conversations finds webhook -> 2 and nothing from Billing", async () => {
    expect((await ops.searchConversations(c, "webhook")).conversations.map((r) => r.id)).toEqual([2]);
    expect((await ops.searchConversations(c, "invoice")).conversations).toEqual([]);
    expect((await ops.searchConversations(c, "#9")).conversations.map((r) => r.id)).toEqual([9]);
  }, 60_000);

  it("search_conversations filters: unassigned -> 1,4,7; a filters-only date search; Billing mailbox is widened", async () => {
    const u = await ops.searchConversations(c, { assigned: "unassigned" });
    expect(u.conversations.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 4, 7]);
    const day = await ops.searchConversations(c, { after: "2026-10-26", before: "2026-10-26" });
    expect(day.total).toBe(4);
    const billing = await ops.searchConversations(c, { after: "2026-10-01", before: "2026-10-31", mailbox_id: 2 });
    expect(billing.mailbox_filter_ignored).toBe(true);
    const support = await ops.searchConversations(c, { after: "2026-10-01", before: "2026-10-31", mailbox_id: 1 });
    expect(support.mailbox_filter_ignored).toBeUndefined();
    // "#N" with a filter is sent as f[number] (q=#9 plus a filter is HTTP 500 on FreeScout 1.8).
    const num = await ops.searchConversations(c, { q: "#9", status: ["active"] });
    expect(num.conversations.map((r) => r.id)).toEqual([9]);
    expect(num.note).toBe("searched by conversation number");
    expect((await ops.searchConversations(c, { q: "#9", status: ["closed"] })).total).toBe(0);
  }, 60_000);

  it("list_assignees shows only the agent itself", async () => {
    expect((await ops.listAssignees(c)).assignees).toEqual([{ id: 2, name: "Demo Agent" }]);
  }, 60_000);

  it("ticket_volume 2026-10-23..26 by day matches the demo DB (created_at per day)", async () => {
    // §10.4 listing: 3 on 10-23, 7 on 10-24, 2 on 10-25, 1/4/6/9 on 10-26.
    const r = await stats.ticketVolume(c, { from: "2026-10-23", to: "2026-10-26" });
    expect(r.buckets.map((b) => b.total)).toEqual([1, 1, 1, 4]);
    expect(r.requests_made).toBe(4);
    const byAssignee = await stats.ticketVolume(c, { from: "2026-10-26", to: "2026-10-26", breakdown: "assignee" });
    // 9 -> agent 2; 1, 4 unassigned; 6 -> admin (not in the agent's list) = other.
    expect(byAssignee.buckets[0]).toMatchObject({ total: 4, by: { "2": 1, unassigned: 2, other: 1 } });
  }, 90_000);

  it("get_conversation 9 returns customer message, agent note, agent reply in order", async () => {
    const conv = await ops.getConversation(c, 9);
    expect(conv).toMatchObject({ id: 9, number: 9, mailbox_id: 1, status: "active", assignee_id: 2, current_user_id: 2 });
    expect(conv.customer).toMatchObject({ id: 9, email: "carlos.mendes@tidepool.example" });
    expect(conv.threads.map((t) => [t.thread_id, t.type])).toEqual([
      [18, "customer"],
      [19, "note"],
      [20, "message"],
    ]);
    expect(conv.threads[0]!.author).toMatchObject({ kind: "customer", id: 9 });
    expect(conv.threads[1]!.author).toMatchObject({ kind: "user", id: 2 });
  }, 60_000);

  it("get_conversation on Billing conversation 10 is a PermissionError", async () => {
    await expect(ops.getConversation(c, 10)).rejects.toBeInstanceOf(PermissionError);
  }, 60_000);

  it("get_customer by email and id", async () => {
    const byEmail = await ops.getCustomer(c, "carlos.mendes@tidepool.example");
    expect(byEmail).toMatchObject({ id: 9, name: "Carlos Mendes", profile: { company: "Tidepool Media" } });
    expect(byEmail.conversations.map((r) => r.id)).toEqual([9]);
    const billingOnly = await ops.getCustomer(c, 10);
    expect(billingOnly.conversations).toEqual([]);
  }, 60_000);

  it("list_saved_replies reports the module as unavailable", async () => {
    expect(await ops.listSavedReplies(c, 1)).toMatchObject({ available: false });
  }, 60_000);

  it("add_note on conversation 1 creates a note; DB has type 3 and no mail to the customer", async () => {
    const before = await ops.getConversation(c, 1);
    const dbNow = sshHost ? sql("select now();")[0]![0]! : undefined;
    const note = await ops.addNote(c, 1, `Integration test note ${Date.now()}\nsecond line`);
    expect(note.type).toBe("note");
    const after = await ops.getConversation(c, 1);
    expect(after.threads.find((t) => t.thread_id === note.thread_id)?.type).toBe("note");
    expect(after.status_value).toBe(before.status_value);
    expect(after.assignee_id).toBe(before.assignee_id);
    if (!sshHost) return;
    // Give the queue worker a moment to process any notification jobs.
    await new Promise((r) => setTimeout(r, 5000));
    const [row] = sql(`select type, state, ifnull(subtype,'NULL') from threads where id = ${note.thread_id};`);
    expect(row).toEqual(["3", "2", "NULL"]); // Thread::TYPE_NOTE, STATE_PUBLISHED, no subtype
    const customerEmail = before.customer!.email!;
    const logs = sql(`select id, email, mail_type, status from send_logs where created_at >= '${dbNow}';`);
    // A notification to subscribed users (admin) may be attempted and fail (outgoing mail is disabled); fine.
    expect(logs.filter((l) => l[1]?.toLowerCase() === customerEmail.toLowerCase())).toEqual([]);
    console.log(`[db] note ${note.thread_id}: threads.type=${row![0]}; send_logs since ${dbNow}: ${JSON.stringify(logs)}`);
  }, 90_000);

  it("save_draft creates, updates in place, discard_draft removes it", async () => {
    const d1 = await ops.saveDraft(c, 1, `Integration draft v1 ${Date.now()}`);
    expect(d1).toMatchObject({ conversation_id: 1, number: 1, updated: false });
    const d2 = await ops.saveDraft(c, 1, `Integration draft v2 ${Date.now()}`, d1.thread_id);
    expect(d2.thread_id).toBe(d1.thread_id);
    const mid = await ops.getConversation(c, 1);
    const drafts = mid.threads.filter((t) => t.type === "draft");
    expect(drafts.map((t) => t.thread_id)).toEqual([d1.thread_id]);
    expect(drafts[0]!.body).toMatch(/^Integration draft v2/);
    await ops.discardDraft(c, 1, d1.thread_id);
    const end = await ops.getConversation(c, 1);
    expect(end.threads.filter((t) => t.type === "draft")).toEqual([]);
    if (sshHost) expect(sql(`select count(*) from threads where id = ${d1.thread_id};`)).toEqual([["0"]]);
  }, 90_000);

  it("writes on Billing conversation 10 are refused", async () => {
    await expect(ops.addNote(c, 10, "should not work")).rejects.toBeInstanceOf(PermissionError);
    await expect(ops.saveDraft(c, 10, "should not work")).rejects.toBeInstanceOf(PermissionError);
  }, 60_000);
});
