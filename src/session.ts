import { type Cookie, CookieJar } from "tough-cookie";
import { parseCookieHeader } from "./cookies.js";
import { AuthError, FreeScoutError, PermissionError } from "./errors.js";
import { extractCsrfMeta, extractLoginFormToken, isLoginFormHtml, looksLikeHtml } from "./html.js";
import { addSecret, log as defaultLog, redact, removeSecret, type Logger } from "./log.js";

export interface SessionOptions {
  baseUrl: string;
  /** Raw `Cookie:` header value pasted from the browser. */
  cookie?: string;
  user?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /**
   * After this many consecutive failed logins, further logins fail fast (no request to FreeScout)
   * for `loginCooldownMs`. Off when unset (stdio mode); the HTTP transport sets 3 / 60 s so a wrong
   * password header cannot hammer FreeScout.
   */
  maxLoginFailures?: number;
  loginCooldownMs?: number;
  /** Message of the AuthError raised when the session is dead and no credentials are available. */
  authErrorMessage?: string;
  /** Clock, for tests. */
  now?: () => number;
}

export interface SessionResponse {
  status: number;
  /** Final URL after same-origin redirects. */
  url: string;
  headers: Headers;
  text: string;
  /** URLs we were redirected through (not including the final one). */
  redirects: string[];
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** Treat as XHR for logged-out detection (401 JSON instead of redirect). */
  ajax?: boolean;
  /** Internal: the login flow's own requests always own the jar. */
  loginFlow?: boolean;
}

export type AuthMode = "cookie" | "credentials" | "none";

export interface SessionHealth {
  /** How the current session was obtained. */
  authMode: AuthMode;
  /** FREESCOUT_USER/PASSWORD available for transparent re-login. */
  canAutoLogin: boolean;
  /** null until the first request completes. */
  lastRequestOk: boolean | null;
  lastRequestAt?: string;
  lastError?: string;
  loginCount: number;
  lastLoginAt?: string;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class Session {
  readonly baseUrl: URL;
  readonly jar = new CookieJar();
  private readonly user?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly seeded: Promise<void>;
  private csrf?: string;
  private loginPromise?: Promise<void>;
  /** Bumped on every successful login; lets a request tell if someone else re-logged meanwhile. */
  private loginGeneration = 0;
  /** Bumped when a login starts and when it ends; see ingestSetCookie. */
  private authEpoch = 0;
  private loggingIn = false;
  private readonly _health: SessionHealth;
  /** Values this session pinned in the redaction registry; released by dispose(). */
  private readonly pinnedSecrets: string[] = [];
  private readonly maxLoginFailures?: number;
  private readonly loginCooldownMs: number;
  private readonly authErrorMessage?: string;
  private readonly now: () => number;
  private loginFailures = 0;
  private loginLockedUntil = 0;

  constructor(opts: SessionOptions) {
    const base = new URL(opts.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    base.search = "";
    base.hash = "";
    // Never keep user:pass@ (it would be echoed by whoami and fetch() rejects such URLs anyway).
    base.username = "";
    base.password = "";
    this.baseUrl = base;
    this.user = opts.user;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log = opts.logger ?? defaultLog;
    this.maxLoginFailures = opts.maxLoginFailures;
    this.loginCooldownMs = opts.loginCooldownMs ?? 60_000;
    this.authErrorMessage = opts.authErrorMessage;
    this.now = opts.now ?? Date.now;
    this.pin(this.password);
    this._health = {
      authMode: opts.cookie ? "cookie" : "none",
      canAutoLogin: Boolean(this.user && this.password),
      lastRequestOk: null,
      loginCount: 0,
    };
    this.seeded = this.seedCookies(opts.cookie);
  }

  get health(): SessionHealth {
    return { ...this._health };
  }

  private pin(value: string | undefined): void {
    if (!value) return;
    addSecret(value, true);
    this.pinnedSecrets.push(value);
  }

  /**
   * Release the secrets this session pinned in the redaction registry (HTTP mode, when an MCP session
   * ends). A value stays masked while another session or the env config still pins it.
   */
  async dispose(): Promise<void> {
    await this.seeded.catch(() => undefined);
    for (const v of this.pinnedSecrets.splice(0)) removeSecret(v);
  }

  get canAutoLogin(): boolean {
    return this._health.canAutoLogin;
  }

  /**
   * The single place that turns an app path into a URL. "/mailbox/1" and "mailbox/1" both resolve
   * *under* FREESCOUT_URL, so a sub-path install (https://host/helpdesk/) gets /helpdesk/mailbox/1;
   * never build request URLs with `new URL("/…", base)`, which would drop the sub-path.
   * Absolute URLs (hrefs read from FreeScout pages) must be same-origin.
   */
  resolve(path: string): URL {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (u.origin !== this.baseUrl.origin) throw new FreeScoutError(`Refusing cross-origin URL ${u.origin}`);
      return u;
    }
    return new URL(path.replace(/^\/+/, ""), this.baseUrl);
  }

  private async seedCookies(raw?: string): Promise<void> {
    const pairs = parseCookieHeader(raw);
    const secure = this.baseUrl.protocol === "https:" ? "; Secure" : "";
    for (const { name, value } of pairs) {
      this.pin(value);
      await this.jar.setCookie(`${name}=${value}; Path=/${secure}`, this.baseUrl.toString(), { ignoreError: true });
    }
    if (raw && pairs.length === 0) this.log.warn("FREESCOUT_COOKIE is set but contains no name=value pairs");
    else if (pairs.length) this.log.debug(`seeded ${pairs.length} cookie(s): ${pairs.map((p) => p.name).join(", ")}`);
  }

  /** Current Cookie header value the jar would send to FREESCOUT_URL. */
  async cookieHeader(): Promise<string> {
    await this.seeded;
    return this.jar.getCookieString(this.baseUrl.toString());
  }

  /** Value of one cookie currently in the jar. */
  async cookieValue(name: string): Promise<string | undefined> {
    await this.seeded;
    const cookies = await this.jar.getCookies(this.baseUrl.toString());
    return cookies.find((c) => c.key === name)?.value;
  }

  private async ingestSetCookie(res: Response, url: URL): Promise<void> {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const value = /^[^=]+=([^;]*)/.exec(sc)?.[1];
      addSecret(value);
      try {
        const stored = await this.jar.setCookie(sc, url.toString(), { ignoreError: true });
        if (stored) await this.dropShadowed(stored, url);
      } catch (e) {
        this.log.debug("ignored bad Set-Cookie", e);
      }
    }
  }

  /**
   * The pasted cookie is seeded host-only. If the server sets the same name with a Domain attribute
   * (SESSION_DOMAIN), both would be sent and PHP reads the first, i.e. the stale pasted one.
   * Keep only the cookie the server just set.
   */
  private async dropShadowed(stored: Cookie, url: URL): Promise<void> {
    const store = this.jar.store;
    for (const c of await this.jar.getCookies(url.toString())) {
      if (c === stored || c.key !== stored.key || c.path !== stored.path) continue;
      if (c.domain === stored.domain && c.hostOnly === stored.hostOnly) continue;
      if (c.domain) await store.removeCookie(c.domain, c.path ?? "/", c.key);
    }
  }

  /**
   * One HTTP exchange plus manual same-origin redirect following (max 5).
   * Every hop's Set-Cookie is fed into the jar before the next hop. Does not
   * interpret logged-out state; stops (returning the 3xx) at a redirect to the
   * login page or to another origin.
   */
  async rawFetch(path: string, opts: RequestOptions = {}): Promise<SessionResponse> {
    await this.seeded;
    let url = this.resolve(path);
    let method = (opts.method ?? "GET").toUpperCase();
    let body: string | undefined = opts.body === undefined ? undefined : String(opts.body);
    const baseHeaders: Record<string, string> = {
      "User-Agent": "freescout-mcp/0.1",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      ...opts.headers,
    };
    const redirects: string[] = [];

    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { ...baseHeaders };
      const cookie = await this.jar.getCookieString(url.toString());
      if (cookie) headers.Cookie = cookie;
      if (body === undefined) delete headers["Content-Type"];

      this.log.debug(`${method} ${url.pathname}${hop ? ` (redirect ${hop})` : ""}`);
      const epoch = this.authEpoch;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const msg = e instanceof Error && e.name === "TimeoutError" ? `timed out after ${this.timeoutMs}ms` : String(e);
        throw new FreeScoutError(`Request to ${url.pathname} failed: ${msg}`);
      }
      // Laravel re-sends the session cookie on every response. A response to a request that was
      // sent with the pre-login (dead) session must not clobber the fresh login cookie, so only the
      // login flow may write while a login is running or after one finished mid-flight.
      if (opts.loginFlow || (!this.loggingIn && epoch === this.authEpoch)) await this.ingestSetCookie(res, url);
      else this.log.debug(`ignored Set-Cookie from ${url.pathname} (login happened mid-request)`);

      const location = res.headers.get("location");
      if (REDIRECT.has(res.status) && location) {
        const next = new URL(location, url);
        if (next.origin !== url.origin || isLoginUrl(next) || hop >= MAX_REDIRECTS) {
          if (hop >= MAX_REDIRECTS && next.origin === url.origin && !isLoginUrl(next)) {
            await res.body?.cancel();
            throw new FreeScoutError(`Too many redirects starting at ${this.resolve(path).pathname}`);
          }
          return { status: res.status, url: url.toString(), headers: res.headers, text: await res.text(), redirects };
        }
        await res.body?.cancel();
        redirects.push(url.toString());
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
          method = "GET";
          body = undefined;
          delete baseHeaders["Content-Type"];
        }
        url = next;
        continue;
      }
      const text = await res.text();
      return { status: res.status, url: url.toString(), headers: res.headers, text, redirects };
    }
  }

  /** Throws AuthError when the response says we are not logged in. */
  private assertLoggedIn(res: SessionResponse, opts: RequestOptions): void {
    if (REDIRECT.has(res.status)) {
      const loc = res.headers.get("location");
      if (loc && isLoginUrl(new URL(loc, res.url))) throw new AuthError("logged_out");
    }
    if (res.status === 401) throw new AuthError("logged_out");
    if (res.status === 200 && looksLikeHtml(res.headers.get("content-type"), res.text) && isLoginFormHtml(res.text)) {
      throw new AuthError("logged_out");
    }
    // 419 is handled by ajaxPost (CSRF refresh); for a page GET it means the session is gone.
    if (res.status === 419 && !opts.ajax) throw new AuthError("logged_out");
  }

  private remember(res: SessionResponse): void {
    if (looksLikeHtml(res.headers.get("content-type"), res.text)) {
      const t = extractCsrfMeta(res.text);
      if (t) {
        addSecret(t);
        this.csrf = t;
      }
    }
  }

  /**
   * Authenticated request: cookie jar, redirects, logged-out detection and,
   * when credentials are configured, one transparent re-login + retry.
   * `build` is re-invoked for the retry so callers can refresh tokens.
   */
  async request(path: string, opts: RequestOptions = {}): Promise<SessionResponse> {
    return this.send(async () => ({ path, opts }));
  }

  private async send(build: () => Promise<{ path: string; opts: RequestOptions }>): Promise<SessionResponse> {
    const gen = this.loginGeneration;
    try {
      return await this.once(build);
    } catch (e) {
      if (!(e instanceof AuthError) || e.reason !== "logged_out") throw this.fail(e);
      if (!this.canAutoLogin) throw this.fail(new AuthError("no_credentials", this.authErrorMessage));
      this.log.info("session looks logged out; logging in with FREESCOUT_USER");
      try {
        if (this.loginGeneration === gen) await this.ensureLogin();
        return await this.once(build);
      } catch (e2) {
        throw this.fail(e2);
      }
    }
  }

  private async once(build: () => Promise<{ path: string; opts: RequestOptions }>): Promise<SessionResponse> {
    if (this.loginPromise) await this.loginPromise.catch(() => undefined);
    const { path, opts } = await build();
    const res = await this.rawFetch(path, opts);
    this.assertLoggedIn(res, opts);
    this.remember(res);
    this._health.lastRequestOk = true;
    this._health.lastRequestAt = new Date().toISOString();
    this._health.lastError = undefined;
    return res;
  }

  private fail(e: unknown): Error {
    const err = e instanceof Error ? e : new FreeScoutError(String(e));
    this._health.lastRequestOk = false;
    this._health.lastRequestAt = new Date().toISOString();
    this._health.lastError = redact(err.message);
    return err;
  }

  /** Single-flight login: concurrent callers share one attempt. */
  ensureLogin(): Promise<void> {
    if (!this.loginPromise) {
      const max = this.maxLoginFailures;
      if (max !== undefined && this.loginFailures >= max && this.now() < this.loginLockedUntil) {
        const wait = Math.ceil((this.loginLockedUntil - this.now()) / 1000);
        return Promise.reject(
          new AuthError(
            "login_failed",
            `FreeScout login failed ${this.loginFailures} times in a row; not trying again for ${wait}s. Check the username/password, or send a fresh cookie.`,
          ),
        );
      }
      this.loggingIn = true;
      this.authEpoch++;
      const attempt = this.login().then(
        () => {
          this.loginFailures = 0;
          this.loginLockedUntil = 0;
        },
        (e: unknown) => {
          if (e instanceof AuthError && e.reason === "login_failed") {
            this.loginFailures++;
            if (max !== undefined && this.loginFailures >= max) this.loginLockedUntil = this.now() + this.loginCooldownMs;
          }
          throw e;
        },
      );
      this.loginPromise = attempt.finally(() => {
        this.loggingIn = false;
        this.authEpoch++;
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }

  /** Log in with FREESCOUT_USER / FREESCOUT_PASSWORD. Uses rawFetch only (no recursion). */
  async login(): Promise<void> {
    if (!this.user || !this.password) throw new AuthError("no_credentials");
    const page = await this.rawFetch("login", { loginFlow: true });
    // RedirectIfAuthenticated: GET /login bounces to /home when the session is already valid.
    if (page.status === 200 && !isLoginFormHtml(page.text) && page.redirects.length > 0) {
      this.remember(page);
      this.markLoggedIn("session already valid");
      return;
    }
    if (page.status !== 200) {
      const loc = REDIRECT.has(page.status) ? page.headers.get("location") : null;
      const hint = loc ? ` (redirect to ${new URL(loc, page.url).origin}; set FREESCOUT_URL to that origin if it is your FreeScout)` : "";
      throw new AuthError("login_failed", `FreeScout login page returned HTTP ${page.status}${hint}.`);
    }
    const token = extractLoginFormToken(page.text) ?? extractCsrfMeta(page.text);
    if (!token) throw new AuthError("login_failed", "Could not find the _token field on the FreeScout login page.");
    addSecret(token);

    const form = new URLSearchParams({ _token: token, email: this.user, password: this.password, remember: "1" });
    const res = await this.rawFetch("login", {
      method: "POST",
      loginFlow: true,
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: this.resolve("login").toString() },
    });
    const bouncedToLogin =
      REDIRECT.has(res.status) && isLoginUrl(new URL(res.headers.get("location") ?? "/", res.url));
    if (bouncedToLogin || res.status !== 200 || isLoginFormHtml(res.text)) {
      throw new AuthError(
        "login_failed",
        `FreeScout login failed for FREESCOUT_USER (HTTP ${res.status}${bouncedToLogin ? ", redirected back to /login" : ""}). Check the credentials, or paste a fresh FREESCOUT_COOKIE.`,
      );
    }
    this.csrf = undefined; // session id and token are regenerated on login
    this.remember(res);
    this.markLoggedIn("logged in");
  }

  private markLoggedIn(what: string): void {
    this.loginGeneration++;
    this._health.authMode = "credentials";
    this._health.loginCount++;
    this._health.lastLoginAt = new Date().toISOString();
    this.log.info(`FreeScout ${what}`);
  }

  /**
   * CSRF token for form/ajax posts. Primary source is the <meta name="csrf-token">
   * of the last HTML page (fetched from the dashboard if nothing is cached).
   * Fallback is the XSRF-TOKEN cookie, URL-decoded; note that value is Laravel's
   * *encrypted* token, valid only in the X-XSRF-TOKEN header (ajaxPost handles that).
   * The FreeScout 2.2.21 demo does not set XSRF-TOKEN at all, so the meta tag is what counts there.
   */
  async csrfToken(): Promise<string> {
    const t = await this.csrfPair();
    if (t.meta) return t.meta;
    if (t.xsrf) return t.xsrf;
    throw new FreeScoutError("Could not find a CSRF token on the FreeScout dashboard");
  }

  private async csrfPair(): Promise<{ meta?: string; xsrf?: string }> {
    if (!this.csrf) {
      try {
        await this.refreshCsrf();
      } catch (e) {
        if (e instanceof AuthError) throw e;
        this.log.debug("could not refresh CSRF meta", e);
      }
    }
    const cookie = await this.cookieValue("XSRF-TOKEN");
    return { meta: this.csrf, xsrf: cookie ? safeDecode(cookie) : undefined };
  }

  async refreshCsrf(): Promise<void> {
    this.csrf = undefined;
    await this.request("/");
  }

  /**
   * POST application/x-www-form-urlencoded to a FreeScout ajax endpoint and
   * parse the JSON answer. Retries once on 419 after refreshing the token.
   */
  async ajaxPost<T = unknown>(path: string, form: AjaxForm): Promise<T> {
    let refreshed = false;
    for (;;) {
      const res = await this.send(async () => {
        const { meta, xsrf } = await this.csrfPair();
        if (!meta && !xsrf) throw new FreeScoutError("Could not find a CSRF token on the FreeScout dashboard");
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) {
          if (v === undefined) continue;
          // Arrays go out the way jQuery serialises them: one `key[]=value` pair per element.
          if (Array.isArray(v)) for (const item of v) body.append(k.endsWith("[]") ? k : `${k}[]`, String(item));
          else body.append(k, String(v));
        }
        const headers: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/javascript, */*; q=0.01",
        };
        if (meta) {
          body.set("_token", meta);
          headers["X-CSRF-TOKEN"] = meta;
        } else if (xsrf) {
          headers["X-XSRF-TOKEN"] = xsrf;
        }
        return { path, opts: { method: "POST", body: body.toString(), headers, ajax: true } };
      });
      if (res.status === 419) {
        if (refreshed) throw this.fail(new FreeScoutError("FreeScout rejected the CSRF token (HTTP 419) twice", 419));
        refreshed = true;
        this.log.info("CSRF token rejected (419); refreshing");
        await this.refreshCsrf(); // goes through request(): re-logs in if the 419 was really a dead session
        continue;
      }
      if (res.status === 403) throw this.fail(new PermissionError(`FreeScout denied ${this.resolve(path).pathname} (HTTP 403)`));
      if (res.status < 200 || res.status >= 300) {
        throw this.fail(new FreeScoutError(`FreeScout ${this.resolve(path).pathname} returned HTTP ${res.status}`, res.status));
      }
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw this.fail(new FreeScoutError(`FreeScout ${this.resolve(path).pathname} did not return JSON`, res.status));
      }
    }
  }
}

/**
 * Ajax form values. Array values are serialised as repeated `key[]` pairs. Two callers use one, each pinned by its
 * guard: add_tag's `tag_names` (assertTagForm makes it the only array-valued key; FreeScout's tags.ajax treats an
 * array conversation_id as a bulk operation) and forward's `to_email` (assertForwardForm: the only array-valued key,
 * exactly one recipient).
 */
export type AjaxForm = Record<string, string | number | boolean | undefined | readonly string[]>;

export function isLoginUrl(u: URL): boolean {
  return /\/login\/?$/i.test(u.pathname);
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
