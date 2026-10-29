/**
 * Live test against a real FreeScout. Runs only when FREESCOUT_URL and
 * FREESCOUT_USER + FREESCOUT_PASSWORD are set, e.g.
 *   FREESCOUT_URL=https://freescout.example FREESCOUT_USER=... FREESCOUT_PASSWORD=... npm test
 */
import { describe, expect, it } from "vitest";
import { FreeScoutClient } from "../src/client.js";
import { AuthError } from "../src/errors.js";
import { silentLogger } from "../src/log.js";
import { Session } from "../src/session.js";

const { FREESCOUT_URL: url, FREESCOUT_USER: user, FREESCOUT_PASSWORD: password } = process.env;
const enabled = Boolean(url && user && password);

describe.skipIf(!enabled)("live FreeScout", () => {
  const mk = (o: Partial<ConstructorParameters<typeof Session>[0]>) =>
    new Session({ baseUrl: url!, logger: silentLogger, timeoutMs: 20_000, ...o });

  it("logs in with credentials and whoami returns the user", async () => {
    const s = mk({ user, password });
    const me = await new FreeScoutClient(s).whoami();
    expect(me.email?.toLowerCase()).toBe(user!.toLowerCase());
    expect(me.id).toBeGreaterThan(0);
    expect(s.health).toMatchObject({ authMode: "credentials", loginCount: 1, lastRequestOk: true });
  }, 60_000);

  it("a fresh Session with only the resulting cookie works, and the jar rotates the session cookie", async () => {
    const s1 = mk({ user, password });
    await new FreeScoutClient(s1).whoami();
    const cookie = await s1.cookieHeader();
    const sessionCookieName = cookie.match(/\b((?:laravel|freescout)_session)=/)?.[1];
    expect(sessionCookieName).toBeDefined();
    const pasted = await s1.cookieValue(sessionCookieName!);

    const s2 = mk({ cookie }); // no credentials
    const me = await new FreeScoutClient(s2).whoami();
    expect(me.email?.toLowerCase()).toBe(user!.toLowerCase());
    expect(s2.health).toMatchObject({ authMode: "cookie", loginCount: 0, lastRequestOk: true });
    const rotated = await s2.cookieValue(sessionCookieName!);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(pasted);
  }, 60_000);

  it("a garbage cookie without credentials yields AuthError", async () => {
    const s = mk({ cookie: "laravel_session=garbage" });
    await expect(new FreeScoutClient(s).whoami()).rejects.toBeInstanceOf(AuthError);
  }, 60_000);

  it("a garbage cookie with credentials auto re-logs in", async () => {
    const s = mk({ cookie: "laravel_session=garbage", user, password });
    const me = await new FreeScoutClient(s).whoami();
    expect(me.email?.toLowerCase()).toBe(user!.toLowerCase());
    expect(s.health.loginCount).toBe(1);
  }, 60_000);
});
