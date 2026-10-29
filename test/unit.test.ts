import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCookieHeader } from "../src/cookies.js";
import { AUTH_ERROR_MESSAGE, AuthError, FreeScoutError, PermissionError } from "../src/errors.js";
import { extractCsrfMeta, extractLoginFormToken, isLoginFormHtml } from "../src/html.js";
import { addSecret, redact, silentLogger } from "../src/log.js";
import { loadConfig } from "../src/config.js";
import { Session } from "../src/session.js";
import * as cheerio from "cheerio";
import { FreeScoutClient, type FreeScoutPort } from "../src/client.js";
import { listSavedReplies } from "../src/operations.js";
import { FakeFreeScout, dashboard, loginPage } from "./fake-freescout.js";

describe("parseCookieHeader", () => {
  it("parses a devtools Cookie header", () => {
    expect(parseCookieHeader("XSRF-TOKEN=abc%3D%3D; laravel_session=eyJpdi; remember_web_59ba=1|x")).toEqual([
      { name: "XSRF-TOKEN", value: "abc%3D%3D" },
      { name: "laravel_session", value: "eyJpdi" },
      { name: "remember_web_59ba", value: "1|x" },
    ]);
  });
  it("tolerates prefix, whitespace, newlines, quotes, junk and duplicates", () => {
    expect(parseCookieHeader('Cookie:  a=1 ;; b="two"\n c=3=3 ; junk ; =x; a=last')).toEqual([
      { name: "a", value: "last" },
      { name: "b", value: "two" },
      { name: "c", value: "3=3" },
    ]);
  });
  it("returns [] for empty input", () => {
    expect(parseCookieHeader(undefined)).toEqual([]);
    expect(parseCookieHeader("   ")).toEqual([]);
  });
});

describe("html helpers", () => {
  it("extracts csrf meta in either attribute order", () => {
    expect(extractCsrfMeta('<meta name="csrf-token" content="tok123">')).toBe("tok123");
    expect(extractCsrfMeta("<meta content='tok456' name='csrf-token'>")).toBe("tok456");
    expect(extractCsrfMeta("<meta name=viewport>")).toBeUndefined();
  });
  it("detects the login form and its _token", () => {
    const html = loginPage("https://fs.example", "T0KEN");
    expect(isLoginFormHtml(html)).toBe(true);
    expect(extractLoginFormToken(html)).toBe("T0KEN");
  });
  it("does not mistake the dashboard (logout form) for a login form", () => {
    expect(isLoginFormHtml(dashboard("https://fs.example", "x"))).toBe(false);
    expect(isLoginFormHtml('<form action="/login"><input name="q"></form>')).toBe(false);
  });
});

describe("redaction", () => {
  it("masks cookies, tokens, passwords and registered secrets", () => {
    addSecret("hunter2-very-secret");
    const out = redact(
      "Cookie: laravel_session=eyJabc; _token=zzz&password=hunter2-very-secret remember_web_ab12=1|q XSRF-TOKEN=a%3D said hunter2-very-secret",
    );
    expect(out).not.toMatch(/eyJabc|zzz|hunter2|1\|q/);
  });
  it("configured secrets survive the eviction of rotated values", () => {
    addSecret("pinned-Passw0rd", true);
    for (let i = 0; i < 700; i++) addSecret(`rotated-cookie-value-${i}`);
    expect(redact("pw=x pinned-Passw0rd")).not.toContain("pinned-Passw0rd");
  });

  it("errors are redacted at construction", () => {
    addSecret("pasted-cookie-value-123");
    expect(new FreeScoutError("bad pasted-cookie-value-123").message).toBe("bad <redacted>");
  });
});

describe("Session cookie shadowing", () => {
  it("a rotated Domain= session cookie replaces the host-only pasted one instead of being sent after it", async () => {
    const sent: string[] = [];
    let n = 0;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>).Cookie ?? "");
      const h = new Headers({ "content-type": "text/html" });
      h.append("set-cookie", `laravel_session=NEW${++n}; domain=.example.com; path=/; secure; httponly`);
      return new Response("<html><body>ok</body></html>", { status: 200, headers: h });
    }) as unknown as typeof fetch;
    const s = new Session({ baseUrl: "https://fs.example.com", cookie: "laravel_session=OLDpasted", logger: silentLogger, fetchImpl });
    await s.request("/");
    await s.request("/");
    // PHP uses the first of duplicate cookie names, so the stale pasted value must not linger.
    expect(sent).toEqual(["laravel_session=OLDpasted", "laravel_session=NEW1"]);
  });
});

describe("Session against a fake FreeScout", () => {
  let fs: FakeFreeScout;
  let base: string;
  const creds = { user: "agent@example.com", password: "s3cret-pass" };
  beforeEach(async () => {
    fs = new FakeFreeScout({ loginDelayMs: 30 });
    base = await fs.start();
  });
  afterEach(() => fs.stop());

  const mk = (o: Partial<ConstructorParameters<typeof Session>[0]> = {}) =>
    new Session({ baseUrl: base, logger: silentLogger, timeoutMs: 5000, ...o });

  it("seeds the jar from FREESCOUT_COOKIE and stores Set-Cookie rotation", async () => {
    const pasted = fs.mintLoggedInCookie();
    const s = mk({ cookie: `XSRF-TOKEN=abc%3D; ${pasted}` });
    expect(await s.cookieHeader()).toBe(`XSRF-TOKEN=abc%3D; ${pasted}`);
    const r1 = await s.request("/");
    expect(r1.status).toBe(200);
    const rotated = await s.cookieValue("laravel_session");
    expect(`laravel_session=${rotated}`).not.toBe(pasted);
    // A second call must carry the rotated value, never the pasted one.
    const r2 = await s.request("/");
    expect(r2.status).toBe(200);
    const last = fs.requests.at(-1)!;
    expect(last.cookie).toContain(`laravel_session=${rotated}`);
    expect(last.cookie).not.toContain(pasted);
    expect(s.health).toMatchObject({ authMode: "cookie", lastRequestOk: true, loginCount: 0 });
  });

  it("detects logged out via 302 -> /login and raises AuthError without credentials", async () => {
    const s = mk({ cookie: "laravel_session=stale" });
    const err = await s.request("/").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe(AUTH_ERROR_MESSAGE);
    expect(s.health).toMatchObject({ lastRequestOk: false, lastError: AUTH_ERROR_MESSAGE });
    expect(fs.loginPosts).toBe(0);
  });

  it("detects logged out via a 200 login-form page", async () => {
    const s = mk({ cookie: fs.mintLoggedInCookie() });
    await expect(s.request("/login-form-200")).rejects.toBeInstanceOf(AuthError);
  });

  it("detects logged out via 401 on XHR", async () => {
    const s = mk({ cookie: "laravel_session=stale" });
    await expect(s.request("/", { ajax: true, headers: { "X-Requested-With": "XMLHttpRequest" } })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("caps redirects", async () => {
    const s = mk({ cookie: fs.mintLoggedInCookie() });
    await expect(s.request("/loop")).rejects.toThrow(/Too many redirects/);
  });

  it("logs in once with credentials on AuthError and retries the request", async () => {
    const s = mk({ cookie: "laravel_session=stale", ...creds });
    const res = await s.request("/");
    expect(res.status).toBe(200);
    expect(fs.loginPosts).toBe(1);
    const loginPost = fs.requests.find((r) => r.method === "POST" && r.path === "/login");
    expect(loginPost).toBeDefined();
    expect(s.health).toMatchObject({ authMode: "credentials", loginCount: 1, lastRequestOk: true });
  });

  it("concurrent logged-out requests share a single login", async () => {
    const s = mk({ ...creds });
    const results = await Promise.all(Array.from({ length: 5 }, () => s.request("/")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fs.loginPosts).toBe(1);
  });

  it("a slow response sent with the pre-login session does not clobber the fresh login cookie", async () => {
    let release!: () => void;
    fs.slowGate = new Promise<void>((r) => (release = r));
    const s = mk({ cookie: "laravel_session=stale", ...creds });
    const slow = s.request("/slow"); // in flight with the dead session
    await new Promise((r) => setTimeout(r, 20));
    await s.request("/"); // AuthError -> login -> retry
    expect(fs.loginPosts).toBe(1);
    const loggedIn = await s.cookieValue("laravel_session");
    release();
    expect((await slow).status).toBe(200);
    // Without the guard the slow response would overwrite the jar with its anonymous session.
    expect(await s.cookieValue("laravel_session")).toBe(loggedIn);
    expect((await s.request("/")).status).toBe(200);
    expect(fs.loginPosts).toBe(1);
  });

  it("reports a failed login as AuthError(login_failed) and does not loop", async () => {
    const s = mk({ user: creds.user, password: "wrong" });
    const err = await s.request("/").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.reason).toBe("login_failed");
    expect(err.message).not.toContain("wrong");
    expect(fs.loginPosts).toBe(1);
  });

  it("csrfToken comes from the meta tag of the last HTML page", async () => {
    const pasted = fs.mintLoggedInCookie();
    const s = mk({ cookie: pasted });
    await s.request("/");
    expect(await s.csrfToken()).toBe(fs.tokenOf((await s.cookieValue("laravel_session"))!));
  });

  it("csrfToken falls back to the URL-decoded XSRF-TOKEN cookie when no page carries a meta tag", async () => {
    const fetchImpl = (async () =>
      new Response("<html><body>no meta here</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;
    const s = new Session({ baseUrl: "https://fs.example", cookie: "XSRF-TOKEN=eyJ2%3D%3D; laravel_session=x", fetchImpl, logger: silentLogger });
    expect(await s.csrfToken()).toBe("eyJ2==");
  });

  it("ajaxPost sends _token + headers and parses JSON", async () => {
    const s = mk({ cookie: fs.mintLoggedInCookie() });
    expect(await s.ajaxPost("/conversation/ajax", { action: "ping" })).toEqual({ status: "success", action: "ping" });
  });

  it("ajaxPost refreshes the token once on 419 and retries", async () => {
    const s = mk({ cookie: fs.mintLoggedInCookie() });
    await s.request("/"); // cache a token
    fs.rotateAllTokens(); // cached token is now stale
    expect(await s.ajaxPost("/conversation/ajax", { action: "ping" })).toEqual({ status: "success", action: "ping" });
    const posts = fs.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
  });

  it("ajaxPost with a dead session re-logs in (419 -> refresh -> /login -> login) when credentials exist", async () => {
    const s = mk({ cookie: "laravel_session=stale", ...creds });
    expect(await s.ajaxPost("/conversation/ajax", { action: "ping" })).toMatchObject({ status: "success" });
    expect(fs.loginPosts).toBe(1);
  });

  it("ajaxPost 403 is a PermissionError and does not trigger login", async () => {
    const s = mk({ cookie: fs.mintLoggedInCookie(), ...creds });
    await expect(s.ajaxPost("/conversation/ajax", { action: "forbidden" })).rejects.toBeInstanceOf(PermissionError);
    expect(fs.loginPosts).toBe(0);
  });

  it("FreeScoutClient.whoami parses header + profile", async () => {
    const c = new FreeScoutClient(mk({ cookie: fs.mintLoggedInCookie() }));
    expect(await c.whoami()).toMatchObject({
      id: 7,
      firstName: "Agnes",
      lastName: "Agent",
      name: "Agnes Agent",
      email: "agent@example.com",
      role: "User",
      isAdmin: false,
    });
  });
});

describe("non-TLS FREESCOUT_URL", () => {
  const creds = { FREESCOUT_USER: "a@b.example", FREESCOUT_PASSWORD: "pw" };
  it("refuses a plain http:// URL to a remote host unless FREESCOUT_ALLOW_INSECURE=1", () => {
    expect(() => loadConfig({ FREESCOUT_URL: "http://support.example.com", ...creds })).toThrow(/FREESCOUT_ALLOW_INSECURE=1/);
    expect(loadConfig({ FREESCOUT_URL: "http://support.example.com", FREESCOUT_ALLOW_INSECURE: "1", ...creds }).baseUrl).toBe(
      "http://support.example.com/",
    );
  });
  it("allows http:// on localhost / 127.0.0.1 and any https:// URL", () => {
    for (const u of ["http://localhost:8080", "http://127.0.0.1:3000/", "https://support.example.com"]) {
      expect(() => loadConfig({ FREESCOUT_URL: u, ...creds })).not.toThrow();
    }
  });
  it("names the redirect target when the base URL redirects to another origin", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 301, headers: { location: "https://support.example.com/" } })) as unknown as typeof fetch;
    const s = new Session({ baseUrl: "http://support.example.com", cookie: "laravel_session=x", logger: silentLogger, fetchImpl });
    const err = await new FreeScoutClient(s).getHtml("/").catch((e: Error) => e);
    expect(err).toBeInstanceOf(FreeScoutError);
    expect((err as Error).message).toMatch(/redirected \(HTTP 301\) to another origin: https:\/\/support\.example\.com\//);
    expect((err as Error).message).toMatch(/set FREESCOUT_URL to https:\/\/support\.example\.com/);
  });
});

describe("sub-path install (FREESCOUT_URL=https://host/helpdesk/)", () => {
  let fake: FakeFreeScout;
  beforeEach(async () => {
    fake = new FakeFreeScout({ prefix: "/helpdesk" });
    await fake.start();
  });
  afterEach(() => fake.stop());

  it("resolve() keeps the sub-path for leading-slash and relative paths", () => {
    const s = new Session({ baseUrl: "https://fs.example/helpdesk", cookie: "a=b", logger: silentLogger });
    expect(s.resolve("/mailbox/1").toString()).toBe("https://fs.example/helpdesk/mailbox/1");
    expect(s.resolve("conversation/ajax").toString()).toBe("https://fs.example/helpdesk/conversation/ajax");
    expect(s.resolve("/search?q=%239").toString()).toBe("https://fs.example/helpdesk/search?q=%239");
    expect(s.resolve("/").toString()).toBe("https://fs.example/helpdesk/");
  });

  it("login, dashboard, profile and ajax all stay under the prefix", async () => {
    const s = new Session({ baseUrl: fake.base, user: "agent@example.com", password: "s3cret-pass", logger: silentLogger });
    const me = await new FreeScoutClient(s).whoami();
    expect(me.id).toBe(7);
    expect(me.email).toBe("agent@example.com");
    expect(await s.ajaxPost("/conversation/ajax", { action: "ping" })).toMatchObject({ status: "success" });
    const paths = fake.requests.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/helpdesk/", "/helpdesk/login", "/helpdesk/users/profile/7", "/helpdesk/conversation/ajax"]));
    expect(paths.filter((p) => !p.startsWith("/helpdesk/"))).toEqual([]);
  });

  it("list_saved_replies probes the module URL under the prefix", async () => {
    const s = new Session({ baseUrl: "https://fs.example/helpdesk/", cookie: "a=b", logger: silentLogger });
    const seen: string[] = [];
    const port = {
      async getHtml(path: string) {
        const url = s.resolve(path).toString();
        seen.push(url);
        if (url.endsWith("/mailbox/1")) return { $: cheerio.load("<html><body></body></html>"), url, status: 200 };
        throw new FreeScoutError("not found", 404);
      },
      async ajaxPost() {
        throw new Error("unused");
      },
    } as unknown as FreeScoutPort;
    const r = await listSavedReplies(port, 1);
    expect(r.available).toBe(false);
    expect(seen).toEqual(["https://fs.example/helpdesk/mailbox/1", "https://fs.example/helpdesk/mailbox/saved-replies/1"]);
  });
});

describe("userinfo in FREESCOUT_URL", () => {
  let fake: FakeFreeScout;
  beforeEach(async () => {
    fake = new FakeFreeScout();
    await fake.start();
  });
  afterEach(() => fake.stop());

  it("is stripped: whoami.baseUrl never echoes user:pass@ and requests still work", async () => {
    const withCreds = fake.url.replace("http://", "http://basic-user:basic-secret@");
    const cfg = loadConfig({ FREESCOUT_URL: withCreds, FREESCOUT_COOKIE: fake.mintLoggedInCookie() });
    expect(cfg.baseUrl).not.toMatch(/basic-user|basic-secret/);
    const s = new Session({ baseUrl: withCreds, cookie: cfg.cookie, logger: silentLogger });
    const me = await new FreeScoutClient(s).whoami();
    expect(me.id).toBe(7);
    expect(me.baseUrl).toBe(`${fake.url}/`);
    expect(me.baseUrl).not.toMatch(/basic-user|basic-secret|@/);
  });
});
