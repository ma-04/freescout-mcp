/**
 * RED-TEAM regression tests — session / secret isolation (docs/REDTEAM.md).
 *
 * Offline, with a fake fetch. Asserts the cookie jar and redaction defenses that keep the browser
 * session cookie from leaking cross-origin or into tool output. All BLOCKED at review time.
 */
import { describe, expect, it } from "vitest";
import { Session } from "../../src/session.js";
import { addSecret, redact } from "../../src/log.js";

const BASE = "https://fs.example.com";
const SECRET = "eyJpdiI6SECRETSESSIONVALUE1234567890abcdef";

function fakeFetch(handler: (url: string, init: any) => { status: number; headers: Record<string, string | string[]>; body?: string }): typeof fetch {
  return (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url, init);
    const h = new Headers();
    for (const [k, v] of Object.entries(r.headers)) { if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else h.set(k, v); }
    return new Response(r.body ?? "", { status: r.status, headers: h });
  }) as any;
}

describe("RT: session cookie never crosses origin", () => {
  it("a 302 to another origin is NOT followed and the cookie is never sent there", async () => {
    let cookieSeenAtEvil = false;
    const s = new Session({ baseUrl: BASE, cookie: `laravel_session=${SECRET}`, fetchImpl: fakeFetch((url, init) => {
      if (url.includes("evil.com")) { if (init.headers?.Cookie || init.headers?.cookie) cookieSeenAtEvil = true; return { status: 200, headers: { "content-type": "text/html" }, body: "<html>evil</html>" }; }
      return { status: 302, headers: { location: "https://evil.com/steal" } };
    }) });
    const res = await s.request("/mailbox/1");
    expect(res.status).toBe(302);                // stopped at the redirect, did not follow
    expect(new URL(res.url).origin).toBe(BASE);  // stayed on the FreeScout origin
    expect(cookieSeenAtEvil).toBe(false);
  });

  it("resolve() refuses a cross-origin absolute URL", () => {
    const s = new Session({ baseUrl: BASE, cookie: `laravel_session=${SECRET}`, fetchImpl: fakeFetch(() => ({ status: 200, headers: {} })) });
    expect(() => s.resolve("https://evil.com/x")).toThrow(/cross-origin/i);
  });

  it("a Set-Cookie scoped to another domain is dropped by the jar", async () => {
    const s = new Session({ baseUrl: BASE, cookie: `laravel_session=${SECRET}`, fetchImpl: fakeFetch(() => ({
      status: 200, headers: { "content-type": "text/html", "set-cookie": ["evil=pwned; Domain=evil.com; Path=/", "attacker=1; Domain=attacker.net"] }, body: "<html><meta name='csrf-token' content='abc'></html>",
    })) });
    await s.request("/");
    const header = await s.cookieHeader();
    expect(header).not.toMatch(/evil|attacker|pwned/);
    expect(header).toContain("laravel_session=");
  });
});

describe("RT: secrets never appear in surfaced errors", () => {
  it("a non-JSON ajax reply that echoes the cookie yields an error without the secret", async () => {
    const s = new Session({ baseUrl: BASE, cookie: `laravel_session=${SECRET}`, fetchImpl: fakeFetch((url) =>
      url.includes("conversation/ajax")
        ? { status: 200, headers: { "content-type": "text/html" }, body: `<html>garbage ${SECRET} not json</html>` }
        : { status: 200, headers: { "content-type": "text/html" }, body: "<html><meta name='csrf-token' content='tok123456'></html>" }) });
    await expect(s.ajaxPost("/conversation/ajax", { action: "send_reply" })).rejects.toThrow(/did not return JSON/);
    try { await s.ajaxPost("/conversation/ajax", { action: "send_reply" }); } catch (e: any) { expect(redact(e.message)).not.toContain(SECRET); }
  });

  it("redact() masks a seeded cookie value and the Cookie: header pattern", () => {
    addSecret(SECRET, true);
    expect(redact(`Cookie: laravel_session=${SECRET}`)).not.toContain(SECRET);
    expect(redact(SECRET)).toBe("<redacted>");
  });
});
