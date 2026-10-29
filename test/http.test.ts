import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHttpConfig } from "../src/config.js";
import { createMcpHttpServer, type HttpServerOptions, type McpHttpServer } from "../src/http-server.js";
import { redact, silentLogger } from "../src/log.js";
import { Session } from "../src/session.js";
import { FakeFreeScout } from "./fake-freescout.js";

const TOKEN = "t".repeat(40);
const PROTOCOL = "2025-06-18";

let fs: FakeFreeScout;
let app: McpHttpServer;
let mcpUrl: string;
let clients: Client[] = [];

async function start(extra: Partial<HttpServerOptions> = {}): Promise<void> {
  app = createMcpHttpServer({ baseUrl: fs.base, token: TOKEN, logger: silentLogger, timeoutMs: 5_000, ...extra });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
}

beforeEach(async () => {
  fs = new FakeFreeScout();
  await fs.start();
  await start();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
  await app.close();
  await fs.stop();
});

const initBody = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

/** Raw initialize; returns the session id. */
async function rawInit(identity: Record<string, string>): Promise<string> {
  const res = await post(initBody(), { ...bearer, ...identity });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...bearer, ...identity, "mcp-session-id": sid!, "mcp-protocol-version": PROTOCOL });
  return sid!;
}

async function connect(identity: Record<string, string>): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { ...bearer, ...identity } } });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  return (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
}

describe("HTTP transport: access control", () => {
  it("GET /healthz answers without auth and says nothing else", async () => {
    const res = await fetch(mcpUrl.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) });
  });

  it("401 with WWW-Authenticate: Bearer without (or with a wrong) bearer token", async () => {
    const cookie = { "X-FreeScout-Cookie": fs.mintLoggedInCookie() };
    for (const auth of [{}, { Authorization: "Bearer nope" }, { Authorization: `Basic ${TOKEN}` }]) {
      const res = await post(initBody(), { ...cookie, ...auth });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
    expect(app.sessionCount).toBe(0);
    expect(fs.requests).toHaveLength(0);
  });

  it("401 with a JSON-RPC error naming the headers when no identity is sent", async () => {
    for (const identity of [{}, { "X-FreeScout-User": "agent@example.com" }]) {
      const res = await post(initBody(), { ...bearer, ...identity });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.message).toMatch(/X-FreeScout-Cookie/);
      expect(body.error.message).toMatch(/X-FreeScout-User/);
      expect(body.error.message).toMatch(/X-FreeScout-Password/);
    }
    expect(app.sessionCount).toBe(0);
  });

  it("refuses browser Origins (absent Origin is fine)", async () => {
    const cookie = { "X-FreeScout-Cookie": fs.mintLoggedInCookie() };
    const res = await post(initBody(), { ...bearer, ...cookie, Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(app.sessionCount).toBe(0);
    expect((await post(initBody(), { ...bearer, ...cookie })).status).toBe(200);
  });

  it("413 for bodies over 1 MB, 400 for invalid JSON", async () => {
    const cookie = { "X-FreeScout-Cookie": fs.mintLoggedInCookie() };
    const big = JSON.stringify({ ...initBody(), pad: "x".repeat(1024 * 1024) });
    const res = await post(undefined, { ...bearer, ...cookie }, big);
    expect(res.status).toBe(413);
    const bad = await post(undefined, { ...bearer, ...cookie }, "{not json");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    expect(app.sessionCount).toBe(0);
  });

  it("400 for a non-initialize request without a session, 404 for an unknown session", async () => {
    const cookie = { "X-FreeScout-Cookie": fs.mintLoggedInCookie() };
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    expect((await post(list, { ...bearer, ...cookie })).status).toBe(400);
    expect((await post(list, { ...bearer, ...cookie, "mcp-session-id": "nope" })).status).toBe(404);
  });
});

describe("HTTP transport: sessions", () => {
  it("initialize + tools/list + whoami over HTTP with a cookie header", async () => {
    const { client } = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie(41) });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("whoami");
    expect(tools.map((t) => t.name)).not.toContain("send_reply");
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { user: { id: number } }).user.id).toBe(41);
    expect(app.sessionCount).toBe(1);
  });

  it("list_tags over HTTP: absent module, then module markup and autocomplete, through the real session layer", async () => {
    const { client } = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    let r = await client.callTool({ name: "list_tags", arguments: { mailbox_id: 1 } });
    expect(r.structuredContent).toMatchObject({ available: false, mailbox_ids: [1] });
    // q without the module: autocomplete 404s, then the page scan says unavailable.
    r = await client.callTool({ name: "list_tags", arguments: { mailbox_id: 1, q: "vi" } });
    expect(r.structuredContent).toMatchObject({ available: false });
    fs.tags = ["billing", "vip"];
    r = await client.callTool({ name: "list_tags", arguments: { mailbox_id: 1 } });
    expect(r.structuredContent).toMatchObject({ available: true, tags: [{ name: "billing", id: 1, conversations_seen: 1 }, { name: "vip", id: 2 }] });
    const before = fs.requests.length;
    r = await client.callTool({ name: "list_tags", arguments: { mailbox_id: 1, q: "vi" } });
    expect(r.structuredContent).toMatchObject({ available: true, source: "Tags module autocomplete", tags: [{ name: "vip", conversations_seen: null }] });
    expect(fs.requests.slice(before).map((q) => `${q.method} ${q.path}`)).toEqual(["POST /tags/ajax"]);
    expect(fs.tagPosts).toEqual([]); // autocomplete is not recorded as a write
  });

  it("add_tag over HTTP: exactly one POST, to tags/ajax, add-only; never /conversation/ajax", async () => {
    const { client } = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    // Module absent: clean refusal, nothing posted.
    let r = await client.callTool({ name: "add_tag", arguments: { conversation_id: 1, tags: ["vip"] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^FreeScoutError: .*Tags module/);
    expect(fs.requests.filter((q) => q.method === "POST")).toEqual([]);

    fs.tags = ["billing"];
    r = await client.callTool({ name: "add_tag", arguments: { conversation_id: 1, tags: ["vip", " BILLING ", "Vip"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      conversation_id: 1,
      tags_before: ["billing"],
      tags_after: ["billing", "vip"],
      added: ["vip"],
      response_tags: ["billing", "vip"],
    });
    const posts = fs.requests.filter((q) => q.method === "POST").map((q) => q.path);
    expect(posts).toEqual(["/tags/ajax"]);
    expect(fs.tagPosts).toHaveLength(1);
    expect(fs.tagPosts[0]!.filter(([k]) => k !== "_token")).toEqual([
      ["action", "add"],
      ["tag_names[]", "vip"],
      ["conversation_id", "1"],
    ]);

    // Everything already there: no POST at all.
    r = await client.callTool({ name: "add_tag", arguments: { conversation_id: 1, tags: ["VIP"] } });
    expect(r.structuredContent).toMatchObject({ added: [], note: "already tagged" });
    expect(fs.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("remove_tag over HTTP: one POST per present tag, pinned form, other tags kept", async () => {
    const { client } = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    fs.tags = ["billing", "VIP", "sso"];
    const r = await client.callTool({ name: "remove_tag", arguments: { conversation_id: 1, tags: ["vip", "nope"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      conversation_id: 1,
      tags_before: ["billing", "VIP", "sso"],
      tags_after: ["billing", "sso"],
      removed: ["VIP"],
      not_present: ["nope"],
    });
    expect(fs.requests.filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/tags/ajax"]);
    expect(fs.tagPosts.map((f) => f.filter(([k]) => k !== "_token"))).toEqual([
      [
        ["action", "remove"],
        ["tag_name", "VIP"],
        ["conversation_id", "1"],
      ],
    ]);
  });

  it("forward_conversation exists only when the server was started with an allow-list; no header can enable it", async () => {
    const hdr = { "X-FreeScout-Cookie": fs.mintLoggedInCookie(), "X-FreeScout-Forward-Allow": "@evil.example", "X-Forward-Allow": "@evil.example" };
    let names = (await (await connect(hdr)).client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("close_conversation");
    expect(names).not.toContain("forward_conversation");

    await app.close();
    await start({ forwardAllow: ["@team.example"] });
    const { client } = await connect(hdr);
    names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("forward_conversation");
    fs.addConv(9);
    const r = await client.callTool({ name: "forward_conversation", arguments: { conversation_id: 9, to: "x@evil.example", body: "x" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not on this server's forward allow-list/);
    expect(fs.convPosts).toEqual([]);
  });

  it("isolates sessions: two cookies, two users, two jars", async () => {
    const a = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie(101) });
    const b = await connect({ "X-FreeScout-Cookie": fs.mintLoggedInCookie(202) });
    for (let i = 0; i < 2; i++) {
      const [ra, rb] = await Promise.all([
        a.client.callTool({ name: "whoami", arguments: {} }),
        b.client.callTool({ name: "whoami", arguments: {} }),
      ]);
      expect((ra.structuredContent as { user: { id: number } }).user.id).toBe(101);
      expect((rb.structuredContent as { user: { id: number } }).user.id).toBe(202);
    }
    // Every request FreeScout saw carried exactly one session cookie, belonging to one of the two sessions.
    const sidsSeen = new Set(fs.requests.map((r) => fs.cookieToSid.get(/laravel_session=([^;]+)/.exec(r.cookie ?? "")![1]!)));
    expect(sidsSeen.size).toBe(2);
    expect(app.sessionCount).toBe(2);
  });

  it("403 when a later request carries different identity headers", async () => {
    const cookie = fs.mintLoggedInCookie();
    const sid = await rawInit({ "X-FreeScout-Cookie": cookie });
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const hdr = { ...bearer, "mcp-session-id": sid, "mcp-protocol-version": PROTOCOL };
    expect((await post(list, { ...hdr, "X-FreeScout-Cookie": fs.mintLoggedInCookie() })).status).toBe(403);
    expect((await post(list, { ...hdr, "X-FreeScout-Cookie": cookie, "X-FreeScout-User": "x@example.com", "X-FreeScout-Password": "pw-123456" })).status).toBe(403);
    expect((await post(list, { ...hdr })).status).toBe(401);
    expect((await post(list, { ...hdr, "X-FreeScout-Cookie": cookie })).status).toBe(200);
  });

  it("DELETE tears the session down", async () => {
    const cookie = { "X-FreeScout-Cookie": fs.mintLoggedInCookie() };
    const sid = await rawInit(cookie);
    expect(app.sessionCount).toBe(1);
    const hdr = { ...bearer, ...cookie, "mcp-session-id": sid, "mcp-protocol-version": PROTOCOL };
    const del = await fetch(mcpUrl, { method: "DELETE", headers: hdr });
    expect(del.status).toBe(200);
    expect(app.sessionCount).toBe(0);
    expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, hdr)).status).toBe(404);
  });

  it("reaps idle sessions after the TTL and caps concurrent sessions", async () => {
    await app.close();
    let clock = 1_000_000;
    await start({ sessionTtlMs: 60_000, maxSessions: 2, now: () => clock });
    await rawInit({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    await rawInit({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    const third = await post(initBody(), { ...bearer, "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    expect(third.status).toBe(503);
    clock += 61_000;
    expect(await app.reap()).toBe(2);
    expect(app.sessionCount).toBe(0);
    await rawInit({ "X-FreeScout-Cookie": fs.mintLoggedInCookie() });
    expect(app.sessionCount).toBe(1);
  });

  it("a bogus cookie initializes fine and whoami returns the session-expired AuthError", async () => {
    const { client } = await connect({ "X-FreeScout-Cookie": "laravel_session=bogus-cookie-value" });
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^AuthError: FreeScout session expired or invalid/);
    expect(text(r)).toMatch(/X-FreeScout-Cookie/);
    expect(text(r)).not.toContain("bogus-cookie-value");
    expect(fs.loginPosts).toBe(0);
  });

  it("logs in with user/password headers, and a wrong password stops hitting FreeScout after 3 failures", async () => {
    const good = await connect({ "X-FreeScout-User": "agent@example.com", "X-FreeScout-Password": "s3cret-pass" });
    expect((await good.client.callTool({ name: "whoami", arguments: {} })).isError).toBeFalsy();
    expect(fs.loginPosts).toBe(1);

    const bad = await connect({ "X-FreeScout-User": "agent@example.com", "X-FreeScout-Password": "wrong-password-1" });
    for (let i = 0; i < 6; i++) {
      const r = await bad.client.callTool({ name: "whoami", arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain("wrong-password-1");
    }
    expect(fs.loginPosts).toBe(1 + 3);
    const last = await bad.client.callTool({ name: "whoami", arguments: {} });
    expect(text(last)).toMatch(/not trying again for \d+s/);
  });

  it("header secrets are redacted while the session lives and released after DELETE", async () => {
    const secret = "laravel_session=header-cookie-secret-xyz";
    const { transport } = await connect({ "X-FreeScout-Cookie": secret, "X-FreeScout-Password": "pw-header-secret", "X-FreeScout-User": "a@example.com" });
    expect(redact("leak header-cookie-secret-xyz pw-header-secret")).not.toMatch(/header-cookie-secret-xyz|pw-header-secret/);
    expect(redact("X-FreeScout-Password: whatever")).toBe("X-FreeScout-Password: <redacted>");
    await transport.terminateSession();
    expect(app.sessionCount).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(redact("pw-header-secret")).toBe("pw-header-secret");
  });
});

describe("Session login lockout", () => {
  it("fails fast after maxLoginFailures and retries after the cooldown", async () => {
    let clock = 0;
    const s = new Session({
      baseUrl: fs.base,
      user: "agent@example.com",
      password: "wrong-password-2",
      logger: silentLogger,
      maxLoginFailures: 3,
      loginCooldownMs: 60_000,
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) await expect(s.request("/")).rejects.toMatchObject({ name: "AuthError" });
    expect(fs.loginPosts).toBe(3);
    clock += 60_001;
    await expect(s.request("/")).rejects.toMatchObject({ name: "AuthError" });
    expect(fs.loginPosts).toBe(4);
    await s.dispose();
  });
});

describe("loadHttpConfig", () => {
  const base = { FREESCOUT_URL: "https://support.example.com/", MCP_TOKEN: TOKEN };
  it("defaults to loopback:8787 and needs no FreeScout identity", () => {
    expect(loadHttpConfig(base)).toMatchObject({ host: "127.0.0.1", port: 8787, sessionTtlMs: 1_800_000, maxSessions: 100 });
  });
  it("refuses to start without MCP_TOKEN or with a short one", () => {
    expect(() => loadHttpConfig({ FREESCOUT_URL: base.FREESCOUT_URL })).toThrow(/MCP_TOKEN is required/);
    expect(() => loadHttpConfig({ ...base, MCP_TOKEN: "short" })).toThrow(/too short/);
  });
  it("rejects a wildcard bind unless MCP_ALLOW_PUBLIC_BIND=1", () => {
    expect(() => loadHttpConfig({ ...base, MCP_HOST: "0.0.0.0" })).toThrow(/Tailscale/);
    expect(() => loadHttpConfig({ ...base, MCP_HOST: "::" })).toThrow(/Tailscale/);
    expect(loadHttpConfig({ ...base, MCP_HOST: "0.0.0.0", MCP_ALLOW_PUBLIC_BIND: "1" }).host).toBe("0.0.0.0");
    expect(loadHttpConfig({ ...base, MCP_HOST: "100.64.0.10" }).host).toBe("100.64.0.10");
  });
  it("keeps the FREESCOUT_URL checks of stdio mode", () => {
    expect(() => loadHttpConfig({ ...base, FREESCOUT_URL: undefined })).toThrow(/FREESCOUT_URL is required/);
    expect(() => loadHttpConfig({ ...base, FREESCOUT_URL: "http://support.example.com" })).toThrow(/plain http/);
  });
});
