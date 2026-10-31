/**
 * Tiny in-process imitation of FreeScout's auth surface, close enough to
 * Laravel's behaviour to exercise the session layer:
 * - laravel_session cookie re-issued with a NEW value on every response
 *   (like Laravel's re-encryption). Older values for the same session stay
 *   valid, as in Laravel, so concurrent requests work; tests assert on the
 *   value actually sent instead. Session regeneration on login kills old values.
 * - 302 to /login for unauthenticated pages, 401 for unauthenticated XHR GET,
 *   419 for POSTs with a bad token, RedirectIfAuthenticated on GET /login.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

interface Sess {
  authed: boolean;
  token: string;
  /** FreeScout user id shown on the dashboard / profile (default 7). */
  userId?: number;
}

export interface FakeOptions {
  email?: string;
  password?: string;
  /** Delay (ms) on POST /login, to make concurrency tests meaningful. */
  loginDelayMs?: number;
  /** Mount the app under a sub-path, e.g. "/helpdesk" (FreeScout installed at https://host/helpdesk/). */
  prefix?: string;
}

export class FakeFreeScout {
  readonly sessions = new Map<string, Sess>(); // sid -> state
  readonly cookieToSid = new Map<string, string>(); // current cookie value -> sid
  readonly issued: string[] = [];
  loginPosts = 0;
  /** GET /slow waits for this before answering (with a Set-Cookie for whatever session it saw). */
  slowGate?: Promise<void>;
  requests: Array<{ method: string; path: string; cookie?: string }> = [];
  /**
   * Tags module simulation: undefined = module not installed (tags/ajax 404s). Otherwise the tag names of
   * conversation 1, shown in /mailbox/1 and on /conversation/1, and changed by POST tags/ajax (add / remove;
   * autocomplete searches them). Conversation markup follows the observed module markup (docs/freescout-endpoints.md
   * §9); content is synthetic.
   */
  tags?: string[];
  /** Every form POSTed to tags/ajax, as raw [key, value] pairs. */
  tagPosts: Array<Array<[string, string]>> = [];
  /** When set, POST tags/ajax action=add also drops this tag (simulates a server that loses a tag). */
  tagAddDrops?: string;
  /**
   * Conversation simulation for close/forward (synthetic data, markup follows docs/freescout-endpoints.md §4.3).
   * GET /conversation/{id} renders the entry; POST /conversation/ajax changes it like FreeScout does. Ids not in
   * the map keep the legacy behaviour (minimal /conversation/1 page, stateless ajax success).
   */
  convs = new Map<number, FakeConv>();
  /** Every form POSTed to /conversation/ajax, as raw [key, value] pairs (including _token). */
  convPosts: Array<Array<[string, string]>> = [];
  /** Recipients of forwards, per conversation, as FreeScout received them (to_email[] values). */
  forwards: Array<{ conversation_id: number; to: string[] }> = [];
  /** Misbehaviour switches, to exercise the DANGER / post-verification checks. */
  misbehave: {
    statusAddsMessage?: boolean;
    forwardAddsMessage?: boolean;
    forwardReassigns?: number;
    /** conversation_change_status answers success but changes nothing. */
    statusNoop?: boolean;
    /** conversation_change_status also assigns the conversation to this user id. */
    statusReassigns?: number;
    /** A forward also sets this status (without a status line). */
    forwardChangesStatus?: number;
    /** FreeScout ignores subtype/to_email: a "forward" is stored as a plain note and nothing is emailed. */
    forwardIgnoresSubtype?: boolean;
    /** The forward note shows the forward badge but no link to the child conversation. */
    forwardHidesChildLink?: boolean;
    /** Record the forward, then drop the connection without answering. */
    forwardDropsConnection?: boolean;
    /** One-shot: the next conversation page GET after a recorded forward answers HTTP 502. */
    rereadFailsAfterForward?: boolean;
    /**
     * Envelope answered for a forward. status "error": answered without processing (FreeScout's validation branch);
     * anything else: the forward is processed (recorded) and this is answered instead of the normal success.
     */
    forwardAnswer?: unknown;
    /**
     * One-shot "teammate": runs on the next simulated /conversation/ajax POST before FreeScout processes it (e.g. a
     * status/assignee change with its status line, which happened between our page read and our POST).
     */
    teammate?: (conv: FakeConv) => void;
  } = {};
  /**
   * Search simulation (GET /search, docs/freescout-endpoints.md §10.1). Rows default to the demo DB listing in §10.4
   * (Support only). The page renders the f[assigned] / f[mailbox] dropdowns from searchAssignees / searchMailboxes
   * (mailboxes this user can view); f[mailbox] for any other mailbox is silently dropped, as FreeScout does.
   */
  searchConvs: FakeSearchConv[] = DEMO_SEARCH_CONVS.map((c) => ({ ...c }));
  searchAssignees: Array<[number, string]> = [[2, "Demo Agent"]];
  searchMailboxes: Array<[number, string]> = [[1, "Support"]];
  /** data-filter names the search page offers (FreeScout core plus module filters such as the Tags module's "tag"). */
  searchFilterNames: string[] = [...CORE_SEARCH_FILTERS, "tag", "attachment name"];
  /** Query strings of every GET /search, in arrival order. */
  searchRequests: URLSearchParams[] = [];
  /**
   * Simulates canSeeOnlyAssignedConversations: FreeScout forces f[assigned] to this user id on every search and
   * marks it selected in the dropdown.
   */
  searchForceAssigned?: number;
  /** When set, the dashboard renders a card per mailbox (listMailboxes); default: no cards (legacy tests). */
  dashboardMailboxes?: Array<[number, string]>;
  /**
   * Reports module simulation (docs/freescout-endpoints.md §11), served from the scrubbed fixtures. undefined = module
   * not installed (every /reports/* is 404, like the demo). `mode` makes GET /reports/<name> misbehave; `ajaxError`
   * answers POST /reports/ajax with {status:"error", msg}; `answer` replaces the whole ajax answer (raw JSON value).
   */
  reports?: {
    mode?: "ok" | "absent" | "forbidden" | "redirect" | "login" | "no_form";
    ajaxError?: string;
    answer?: unknown;
  };
  /** Every form POSTed to /reports/ajax, as raw [key, value] pairs (including _token), in arrival order. */
  reportPosts: Array<Array<[string, string]>> = [];
  private nextThreadId = 1000;

  /** Add a conversation to the simulation (defaults: active, assigned to user 7, one customer thread). */
  addConv(id: number, c: Partial<FakeConv> = {}): FakeConv {
    const conv: FakeConv = {
      number: id,
      mailbox_id: 1,
      status: 1,
      assignee_id: 7,
      customer_email: "customer@client.example",
      draft: false,
      threads: [{ id: this.nextThreadId++, type: "customer", body: "Hello, I need help.", to: ["support@fake.example"] }],
      ...c,
    };
    this.convs.set(id, conv);
    return conv;
  }
  private server!: Server;
  url = "";

  constructor(readonly opts: FakeOptions = {}) {}

  /** Origin plus mount prefix: what FREESCOUT_URL would be (APP_URL). */
  get base(): string {
    return this.url + (this.opts.prefix ?? "");
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Create an authenticated session and return a cookie header value for it. */
  mintLoggedInCookie(userId = 7): string {
    const sid = rand();
    this.sessions.set(sid, { authed: true, token: rand(), userId });
    const v = this.issue(sid);
    return `laravel_session=${v}`;
  }

  tokenOf(cookieValue: string): string | undefined {
    const sid = this.cookieToSid.get(cookieValue);
    return sid ? this.sessions.get(sid)?.token : undefined;
  }

  rotateTokenFor(cookieValue: string): void {
    const sid = this.cookieToSid.get(cookieValue);
    if (sid) this.sessions.get(sid)!.token = rand();
  }

  rotateAllTokens(): void {
    for (const s of this.sessions.values()) s.token = rand();
  }

  /** The module's tags.ajax actions, for conversation 1 only. */
  private tagsAjax(form: URLSearchParams): [number, unknown] {
    const tags = this.tags!;
    const action = form.get("action");
    if (action === "autocomplete") {
      const q = (form.get("q") ?? "").toLowerCase();
      return [200, { results: tags.filter((t) => t.toLowerCase().includes(q)).map((t) => ({ id: t, text: t })), pagination: { more: false } }];
    }
    this.tagPosts.push([...form.entries()]);
    // One conversation only: an array (bulk) or repeated conversation_id is refused.
    if (form.has("conversation_id[]") || form.getAll("conversation_id").length !== 1) return [400, { status: "error", msg: "bulk form" }];
    if (form.get("conversation_id") !== "1") return [200, { status: "error", msg: "Conversation not found" }];
    const norm = (n: string) => n.trim();
    const has = (n: string) => tags.some((t) => t.toLowerCase() === n.toLowerCase());
    if (action === "add") {
      const names = form.getAll("tag_names[]").map(norm).filter(Boolean);
      if (!names.length) return [200, { status: "error", msg: "No tags" }];
      for (const n of names) if (!has(n)) tags.push(n);
      if (this.tagAddDrops) tags.splice(tags.indexOf(this.tagAddDrops), 1);
      return [200, { status: "success", tags: tags.map((name) => ({ name, url: tagUrl(this.base, name) })) }];
    }
    if (action === "remove") {
      const name = norm(form.get("tag_name") ?? "");
      const i = tags.findIndex((t) => t.toLowerCase() === name.toLowerCase());
      if (i >= 0) tags.splice(i, 1);
      return [200, { status: "success" }];
    }
    return [200, { status: "error", msg: "Unknown action" }];
  }

  /** POST /conversation/ajax against the simulated conversations. Null = not simulated (legacy reply). */
  private convAjax(form: URLSearchParams): [number, unknown] | null {
    const action = form.get("action");
    if (action !== "conversation_change_status" && action !== "send_reply") return null;
    const id = Number(form.get("conversation_id"));
    const conv = this.convs.get(id);
    if (!conv) return null;
    this.convPosts.push([...form.entries()]);
    const teammate = this.misbehave.teammate;
    if (teammate) {
      this.misbehave.teammate = undefined;
      teammate(conv);
    }
    if (action === "conversation_change_status") {
      const status = Number(form.get("status"));
      if (conv.status === status) return [200, { status: "error", msg: "Status already set" }];
      if (id === 10) return [200, { status: "error", msg: "Not enough permissions" }];
      if (![1, 2, 3, 4].includes(status)) return [200, { status: "error", msg: "Incorrect status" }];
      if (this.misbehave.statusNoop) return [200, { status: "success", msg: "Status updated" }];
      if (this.misbehave.statusReassigns !== undefined) conv.assignee_id = this.misbehave.statusReassigns;
      conv.status = status;
      conv.threads.push({ type: "lineitem", body: `You marked as ${STATUS_NAMES[status]}` });
      if (this.misbehave.statusAddsMessage) conv.threads.push({ id: this.nextThreadId++, type: "message", body: "oops", to: [conv.customer_email] });
      return [200, { status: "success", msg: "Status updated", redirect_url: `${this.base}/conversation/${id}` }];
    }
    // send_reply, existing conversation (ConversationsController::ajax, abridged).
    if (id === 10) return [200, { status: "error", msg: "Not enough permissions" }];
    if (!form.get("body")) return [200, { status: "error", msg: "The body field is required. " }];
    const answer = this.misbehave.forwardAnswer as { status?: unknown } | undefined;
    if (answer && typeof answer === "object" && answer.status === "error") return [200, answer];
    const isForward = Number(form.get("subtype") ?? 0) === 1 && !this.misbehave.forwardIgnoresSubtype;
    const isNote = !!form.get("is_note"); // PHP empty(): "" and absent are false ("0" too, ignored here)
    const to = form.getAll("to_email[]");
    if (isForward && !to[0]) return [200, { status: "error", msg: "Please specify a recipient." }];
    const status = Number(form.get("status") ?? 0);
    if (status) conv.status = status;
    const userId = Number(form.get("user_id") ?? 0);
    conv.assignee_id = userId === -1 ? -1 : userId || conv.assignee_id;
    if (isForward && this.misbehave.forwardReassigns !== undefined) conv.assignee_id = this.misbehave.forwardReassigns;
    if (isForward && this.misbehave.forwardChangesStatus !== undefined) conv.status = this.misbehave.forwardChangesStatus;
    const body = form.get("body") ?? "";
    if (isForward) {
      this.forwards.push({ conversation_id: id, to });
      if (this.misbehave.forwardAddsMessage) {
        conv.threads.push({ id: this.nextThreadId++, type: "message", body, to: [conv.customer_email] });
      } else if (this.misbehave.forwardHidesChildLink) {
        conv.threads.push({ id: this.nextThreadId++, type: "note", body, to: [to[0]!], forward: true });
      } else {
        conv.threads.push({ id: this.nextThreadId++, type: "note", body, to: [to[0]!], forward_child: 500 + this.forwards.length });
      }
    } else if (isNote) {
      conv.threads.push({ id: this.nextThreadId++, type: "note", body });
    } else {
      conv.threads.push({ id: this.nextThreadId++, type: "message", body, to: [conv.customer_email] });
    }
    if (this.misbehave.forwardAnswer !== undefined) return [200, this.misbehave.forwardAnswer];
    return [200, { status: "success", msg: "", redirect_url: `${this.base}/conversation/${id}` }];
  }

  private issue(sid: string): string {
    const v = "eyJ" + rand();
    this.cookieToSid.set(v, sid);
    this.issued.push(v);
    return v;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const prefix = this.opts.prefix ?? "";
    const fullPath = url.pathname;
    if (prefix) {
      if (fullPath !== prefix && !fullPath.startsWith(prefix + "/")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("outside the app prefix");
        this.requests.push({ method: req.method ?? "GET", path: fullPath, cookie: req.headers.cookie });
        return;
      }
      url.pathname = fullPath.slice(prefix.length) || "/";
    }
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? "")
        .split(/;\s*/)
        .filter(Boolean)
        .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
    );
    this.requests.push({ method: req.method ?? "GET", path: fullPath, cookie: req.headers.cookie });
    let sid = cookies.laravel_session ? this.cookieToSid.get(cookies.laravel_session) : undefined;
    if (!sid) {
      sid = rand();
      this.sessions.set(sid, { authed: false, token: rand() });
    }
    let sess = this.sessions.get(sid)!;
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const xhr = req.headers["x-requested-with"] === "XMLHttpRequest";

    const send = (status: number, text: string, headers: Record<string, string> = {}) => {
      res.setHeader("Set-Cookie", [
        `laravel_session=${this.issue(sid!)}; expires=Thu, 22-Oct-2099 12:00:00 GMT; Max-Age=7200; path=/; httponly`,
      ]);
      res.writeHead(status, { "Content-Type": headers["Content-Type"] ?? "text/html; charset=UTF-8", ...headers });
      res.end(text);
    };
    const redirect = (to: string) => send(302, "", { Location: this.base + to });
    const json = (status: number, obj: unknown) => send(status, JSON.stringify(obj), { "Content-Type": "application/json" });

    if (req.method === "POST") {
      const tok = form.get("_token") ?? req.headers["x-csrf-token"];
      if (tok !== sess.token) return json(419, { message: "CSRF token mismatch." });
    }

    switch (`${req.method} ${url.pathname}`) {
      case "GET /login":
        if (sess.authed) return redirect("/home");
        return send(200, loginPage(this.base, sess.token));
      case "POST /login": {
        this.loginPosts++;
        if (this.opts.loginDelayMs) await new Promise((r) => setTimeout(r, this.opts.loginDelayMs));
        if (form.get("email") === (this.opts.email ?? "agent@example.com") && form.get("password") === (this.opts.password ?? "s3cret-pass")) {
          // session regeneration: new sid, new token
          this.sessions.delete(sid);
          for (const [v, s] of this.cookieToSid) if (s === sid) this.cookieToSid.delete(v);
          sid = rand();
          sess = { authed: true, token: rand() };
          this.sessions.set(sid, sess);
          return redirect("/home");
        }
        return redirect("/login");
      }
      case "GET /":
      case "GET /home":
        if (!sess.authed) return xhr ? json(401, { message: "Unauthenticated." }) : redirect("/login");
        return send(200, dashboard(this.base, sess.token, sess.userId, this.dashboardMailboxes));
      case `GET /users/profile/${sess.userId ?? 7}`:
        if (!sess.authed) return redirect("/login");
        return send(200, profile(sess.token, sess.userId));
      case "GET /login-form-200":
        return send(200, loginPage(this.base, sess.token));
      case "GET /slow":
        await this.slowGate;
        return send(200, "slow ok", { "Content-Type": "text/plain" });
      case "GET /loop":
        return redirect("/loop");
      case "GET /mailbox/1":
        if (!sess.authed) return redirect("/login");
        return send(200, mailboxPage(this.base, sess.token, this.tags));
      case "GET /conversation/1":
        if (!sess.authed) return redirect("/login");
        if (this.convs.has(1)) return send(200, simConversationPage(this.base, sess.token, 1, this.convs.get(1)!, sess.userId ?? 7));
        return send(200, conversationPage(sess.token, this.tags, this.base));
      case "GET /search":
        if (!sess.authed) return redirect("/login");
        this.searchRequests.push(new URLSearchParams(url.searchParams));
        {
          const q = url.searchParams.get("q") ?? "";
          // FreeScout 1.8: "#N" with any filter skips the filtered query and the view fails on ->links() (§10.1).
          if (/^#\d+$/.test(q.trim()) && [...url.searchParams.keys()].some((k) => k.startsWith("f["))) {
            return send(500, "<h1>Server Error</h1>");
          }
          const p = new URLSearchParams(url.searchParams);
          if (this.searchForceAssigned !== undefined) p.set("f[assigned]", String(this.searchForceAssigned));
          return send(200, searchPage(this.base, sess.token, p, this.searchConvs, this.searchAssignees, this.searchMailboxes, this.searchFilterNames));
        }
      case "GET /tags/ajax":
      case "POST /tags/ajax":
        if (!sess.authed) return json(401, { message: "Unauthenticated." });
        if (!this.tags) return send(404, "not found");
        return json(...this.tagsAjax(req.method === "POST" ? form : url.searchParams));
      case "GET /reports/productivity":
      case "GET /reports/satisfaction":
      case "GET /reports/conversations":
      case "GET /reports/time-tracking": {
        if (!this.reports || this.reports.mode === "absent") return send(404, "not found");
        if (!sess.authed) return redirect("/login");
        const name = url.pathname.slice("/reports/".length);
        switch (this.reports.mode ?? "ok") {
          case "forbidden":
            return send(403, "<h1>Forbidden</h1>");
          case "redirect":
            return redirect("/");
          case "login":
            return send(200, loginPage(this.base, sess.token));
          case "no_form":
            return send(200, dashboard(this.base, sess.token, sess.userId));
        }
        return send(200, reportPage(name, sess.token));
      }
      case "POST /reports/ajax": {
        if (!this.reports || this.reports.mode === "absent") return send(404, "not found");
        if (!sess.authed) return json(401, { message: "Unauthenticated." });
        this.reportPosts.push([...form.entries()]);
        if (this.reports.ajaxError !== undefined) return json(200, { status: "error", msg: this.reports.ajaxError });
        if (this.reports.answer !== undefined) return json(200, this.reports.answer);
        return send(200, reportAjaxFixture(form), { "Content-Type": "application/json" });
      }
      case "POST /conversation/ajax": {
        if (!sess.authed) return json(401, { message: "Unauthenticated." });
        if (form.get("action") === "forbidden") return json(403, { message: "This action is unauthorized." });
        const sim = this.convAjax(form);
        if (sim && this.misbehave.forwardDropsConnection && form.get("subtype") === "1") {
          this.misbehave.forwardDropsConnection = false;
          req.socket.destroy();
          return;
        }
        if (sim) return json(...sim);
        return json(200, { status: "success", action: form.get("action") });
      }
      default: {
        const m = /^\/conversation\/(\d+)$/.exec(url.pathname);
        const conv = m && req.method === "GET" ? this.convs.get(Number(m[1])) : undefined;
        if (conv) {
          if (!sess.authed) return redirect("/login");
          if (this.misbehave.rereadFailsAfterForward && this.forwards.length) {
            this.misbehave.rereadFailsAfterForward = false;
            return send(502, "Bad Gateway");
          }
          return send(200, simConversationPage(this.base, sess.token, Number(m![1]), conv, sess.userId ?? 7));
        }
        return send(404, "not found");
      }
    }
  }
}

export interface FakeThread {
  /** Lineitems have no id (FreeScout renders them without data-thread_id). */
  id?: number;
  type: "customer" | "message" | "note" | "draft" | "lineitem";
  body: string;
  to?: string[];
  /** Forward note: number of the child "Fwd:" conversation (rendered with a .thread-badge). */
  forward_child?: number;
  /** Forward note rendered with the badge but without the child-conversation link. */
  forward?: boolean;
}

export interface FakeConv {
  number: number;
  mailbox_id: number;
  status: number;
  /** -1 = unassigned. */
  assignee_id: number;
  customer_email: string;
  /** Unsent draft conversation (create view). */
  draft: boolean;
  /** Render the page without the customer panel (#conv-layout-customer), e.g. a theme/layout change. */
  no_customer_panel?: boolean;
  threads: FakeThread[];
}

const STATUS_NAMES: Record<number, string> = { 1: "Active", 2: "Pending", 3: "Closed", 4: "Spam" };

/** Conversation page with the selectors parseConversation reads (synthetic content). Threads newest first. */
export function simConversationPage(base: string, token: string, id: number, c: FakeConv, userId = 7): string {
  const statusItems = [1, 2, 3, 4]
    .map((v) => `<li${v === c.status ? ' class="active"' : ""}><a href="#" data-status="${v}">${STATUS_NAMES[v]}</a></li>`)
    .join("");
  const users: Array<[number, string]> = [[-1, "Anyone"], [7, "Me"], [8, "Other Agent"]];
  const userItems = users.map(([u, n]) => `<li${u === c.assignee_id ? ' class="active"' : ""}><a href="#" data-user_id="${u}">${n}</a></li>`).join("");
  const assigneeName = users.find(([u]) => u === c.assignee_id)?.[1] ?? "Someone";
  const thread = (t: FakeThread): string => {
    if (t.type === "lineitem") {
      return `<div class="thread thread-type-lineitem"><div class="thread-message"><div class="thread-title"><a href="${base}/users/profile/${userId}">you</a> ${esc(t.body.replace(/^You /, ""))}</div></div></div>`;
    }
    const person =
      t.type === "customer"
        ? `<a href="${base}/customers/5/edit">Cust Omer</a>`
        : t.type === "draft"
          ? "you [Draft]"
          : `<a href="${base}/users/profile/${userId}">you</a>`;
    const fwd =
      t.forward_child !== undefined || t.forward
        ? `<div class="thread-badge" title="Forward"><i class="glyphicon glyphicon-arrow-right"></i></div>`
        : "";
    // Real markup (captured from the demo, 2026-10-27): the badge sits in .thread-message before .thread-header, and the
    // child link is FreeScout chrome inside .thread-body but OUTSIDE .thread-content: `.alert.alert-note`.
    const fwdAlert = t.forward_child !== undefined ? `<div class="alert alert-note">You forwarded this conversation. Forwarded conversation: <a href="${base}/conversation/${t.forward_child + 1000}">#${t.forward_child}</a></div>` : "";
    const recips = t.to?.length ? `<div class="thread-recipients"><div><strong>To:</strong> ${esc(t.to.join(", "))}</div></div>` : "";
    const content = t.type === "draft" ? `<div class="thread-body">${t.body}</div>` : `<div class="thread-body">${fwdAlert}<div class="thread-content">${t.body}</div></div>`;
    return `<div class="thread thread-type-${t.type}" id="thread-${t.id}" data-thread_id="${t.id}"><div class="thread-message">${fwd}<div class="thread-header"><div class="thread-title"><div class="thread-person"><strong>${person}</strong></div>${recips}</div><div class="thread-info"><a href="#thread-${t.id}" class="thread-date" title="Oct 26, 2026 10:00">now</a></div></div>${content}</div></div>`;
  };
  const layoutClass = c.draft ? "conv-new" : "conv-type-email";
  const menus = c.draft
    ? ""
    : `<div id="conv-assignee"><span class="conv-info-val"><span>${assigneeName}</span></span><ul class="dropdown-menu conv-user">${userItems}</ul></div>` +
      `<div id="conv-status"><span class="conv-info-val"><span>${STATUS_NAMES[c.status]}</span></span><ul class="dropdown-menu conv-status">${statusItems}</ul></div>`;
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"></head>
<body data-auth_user_id="${userId}" data-conversation_id="${id}" data-mailbox_id="${c.mailbox_id}"><span class="nav-user">Agnes</span>
<div id="conv-layout" class="${layoutClass}"><div id="conv-toolbar">${menus}</div>
<div id="conv-subject"><div class="conv-numnav"># <strong>${c.number}</strong></div><div class="conv-subjtext"><span>Fake subject ${id}</span></div></div>
${c.no_customer_panel ? "" : `<div id="conv-layout-customer"><div class="customer-snippet"><a href="${base}/customers/5/edit" class="customer-name">Cust Omer</a>
<ul class="customer-contacts"><li class="customer-email"><a href="#" class="contact-main">${esc(c.customer_email)}</a></li></ul></div></div>`}
<div id="conv-layout-main">${[...c.threads].reverse().map(thread).join("\n")}</div></div></body></html>`;
}

function tagUrl(base: string, name: string): string {
  return `${base}/search?f%5Btag%5D=${encodeURIComponent(name)}`;
}

function rand(): string {
  return randomBytes(12).toString("hex");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

export function loginPage(base: string, token: string): string {
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"><title>FreeScout</title></head><body>
<form class="form-horizontal margin-top" method="POST" action="${base}/login">
<input type="hidden" name="_token" value="${token}">
<input id="email" type="email" class="form-control" name="email" value="" required autofocus>
<input id="password" type="password" class="form-control" name="password" required>
<input type="checkbox" name="remember" > Remember Me
<button type="submit" class="btn btn-primary">Login</button></form></body></html>`;
}

export function dashboard(base: string, token: string, userId = 7, mailboxes?: Array<[number, string]>): string {
  const cards = (mailboxes ?? [])
    .map(([id, name]) => `<div class="dash-card" data-mailbox-id="${id}"><a class="mailbox-name" href="${base}/mailbox/${id}">${esc(name)}</a></div>`)
    .join("");
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"><title>Dashboard - FreeScout</title></head>
<body class="locale-en  " data-auth_user_id="${userId}">${cards}<nav class="navbar"><ul class="nav navbar-nav navbar-right"><li class="dropdown">
<a href="#" class="dropdown-toggle dropdown-toggle-icon dropdown-toggle-account" title="Account"><span class="nav-user">Agnes</span></a>
<ul class="dropdown-menu"><li><a href="${base}/users/profile/${userId}">Your Profile</a></li>
<li><form id="logout-form" action="${base}/logout" method="POST"><input type="hidden" name="_token" value="${token}"></form></li></ul></li></ul></nav></body></html>`;
}

export function profile(token: string, userId = 7): string {
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"></head><body data-user_id="${userId}" data-auth_user_id="${userId}">
<form method="POST"><input name="first_name" value="Agnes"><input name="last_name" value="Agent"><input name="email" value="agent@example.com"></form></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** List-view tag chips, reconstructed from freescout-refresh v1.8.0 selectors (list markup not observed). */
export function tagChips(tags: string[]): string {
  return tags.map((t, i) => `<span class="tag" data-tag-id="${i + 1}"><a class="tag-name" href="#">${esc(t)}</a></span>`).join("");
}

/** Conversation-page tag box and add control in the observed module markup (synthetic names). */
export function convTagsMarkup(base: string, tags: string[]): { box: string; control: string } {
  const chips = tags
    .map(
      (t, i) =>
        `<span class="tag tag-c-${i % 10}"><a class="tag-name" href="${esc(tagUrl(base, t))}" target="_blank">${esc(t)}</a> ` +
        `<a class="tag-remove" href="#" title="Remove Tag">×</a></span>`,
    )
    .join(" ");
  return {
    box: `<div id="conv_tags"> ${chips} </div>`,
    control:
      `<div class="dropdown"><span class="conv-add-tags conv-action glyphicon glyphicon-tag" data-toggle="dropdown" title="Tag"></span>` +
      `<ul class="dropdown-menu" id="add-tag-wrap"><li><div class="input-group"><select class="form-control tag-input" multiple></select>` +
      `<span class="input-group-btn"><button class="btn btn-default" type="button">OK</button></span></div></li></ul></div>`,
  };
}

export function mailboxPage(base: string, token: string, tags?: string[]): string {
  const chips = tags?.length ? `<div class="conv-tags">${tagChips(tags)}</div>` : "";
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"></head><body>
<table class="table-conversations table" data-page="1"><tbody>
<tr class="conv-row conv-active" data-conversation_id="1"><td class="conv-subject">${chips}
<a href="${base}/conversation/1?folder_id=1"><p>Hello</p></a></td></tr></tbody></table></body></html>`;
}

export function conversationPage(token: string, tags?: string[], base = ""): string {
  const markup = tags ? convTagsMarkup(base, tags) : { box: "", control: "" };
  const module = markup.control;
  const box = markup.box;
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"></head><body>
<div id="conv-toolbar"><div class="conv-actions">${module}</div></div><div id="conv-subject">${box}</div></body></html>`;
}

export interface FakeSearchConv {
  id: number;
  mailbox_id: number;
  /** "YYYY-MM-DD HH:MM" in the app timezone. */
  created_at: string;
  /** 1 active, 2 pending, 3 closed, 4 spam. */
  status: number;
  /** null = unassigned. */
  user_id: number | null;
  subject: string;
  /** 1 draft, 2 published (default), 3 deleted. */
  state?: number;
  /** Tags module names; rendered as span.conv-tags inside the subject paragraph, like production (2026-10-31). */
  tags?: string[];
  /** Followed by the current user (f[following]=yes). */
  following?: boolean;
  /** Attachment file names (f[attachment name] substring match; the module's exact semantics are unverified). */
  attachment_names?: string[];
}

/** Demo `conversations` (mailbox 1), docs/freescout-endpoints.md §10.4. Subjects are synthetic. */
export const DEMO_SEARCH_CONVS: FakeSearchConv[] = [
  [1, "2026-10-26 17:12", 1, null],
  [2, "2026-10-25 19:12", 1, 2],
  [3, "2026-10-23 20:32", 2, 2],
  [4, "2026-10-26 10:12", 1, null],
  [5, "2026-10-19 19:52", 3, 2],
  [6, "2026-10-26 05:12", 1, 1],
  [7, "2026-10-24 19:52", 2, null],
  [8, "2026-10-12 22:52", 3, 1],
  [9, "2026-10-26 15:12", 1, 2],
].map(([id, created_at, status, user_id]) => ({
  id: id as number,
  mailbox_id: 1,
  created_at: created_at as string,
  status: status as number,
  user_id: user_id as number | null,
  subject: `Fake subject ${id}`,
}));

/** `Conversation::$search_filters` in FreeScout 1.8.248 (demo container source), i.e. the core filter menu. */
export const CORE_SEARCH_FILTERS = [
  "assigned", "customer", "mailbox", "status", "state", "subject", "attachments", "type", "body", "number", "following", "id", "after", "before",
];

/** FreeScout's date filter: strtotime + date('Y-m-d'); anything unparsable silently becomes 1970-01-01. */
function fsDate(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : "1970-01-01";
}

/** The search results page: filter dropdowns + table.table-conversations with tfoot totals, or .empty-content. */
export function searchPage(
  base: string,
  token: string,
  p: URLSearchParams,
  convs: FakeSearchConv[],
  assignees: Array<[number, string]>,
  mailboxes: Array<[number, string]>,
  filterNames: string[] = [...CORE_SEARCH_FILTERS, "tag", "attachment name"],
): string {
  const viewable = new Set(mailboxes.map(([id]) => id));
  let rows = convs.filter((c) => viewable.has(c.mailbox_id));
  const q = p.get("q");
  if (q) rows = rows.filter((c) => c.subject.toLowerCase().includes(q.toLowerCase()) || `#${c.id}` === q);
  const mb = Number(p.get("f[mailbox]"));
  if (mb && viewable.has(mb)) rows = rows.filter((c) => c.mailbox_id === mb); // otherwise silently dropped
  const after = p.get("f[after]");
  if (after) rows = rows.filter((c) => c.created_at >= `${fsDate(after)} 00:00`);
  const before = p.get("f[before]");
  if (before) rows = rows.filter((c) => c.created_at <= `${fsDate(before)} 23:59`);
  const assigned = p.get("f[assigned]");
  if (assigned) rows = rows.filter((c) => (assigned === "-1" ? c.user_id === null : c.user_id === Number(assigned)));
  const statuses = p.getAll("f[status][]").map(Number); // a scalar f[status] is ignored, like FreeScout
  if (statuses.length) rows = rows.filter((c) => statuses.includes(c.status));
  const states = p.getAll("f[state][]").map(Number);
  if (states.length) rows = rows.filter((c) => states.includes(c.state ?? 2));
  const num = p.get("f[number]");
  if (num) rows = rows.filter((c) => c.id === Number(num)); // demo: number == id
  const id = p.get("f[id]");
  if (id) rows = rows.filter((c) => c.id === Number(id));
  if (p.get("f[following]") === "yes") rows = rows.filter((c) => c.following === true);
  const tag = p.get("f[tag]");
  if (tag) rows = rows.filter((c) => (c.tags ?? []).includes(tag));
  const att = p.get("f[attachment name]");
  if (att) rows = rows.filter((c) => (c.attachment_names ?? []).some((n) => n.toLowerCase().includes(att.toLowerCase())));
  rows.sort((a, b) => b.id - a.id);
  const pageNo = Math.max(1, Number(p.get("page") ?? 1) || 1);
  const pageRows = rows.slice((pageNo - 1) * 50, pageNo * 50);
  const opts = (list: Array<[number, string]>, sel: string | null) =>
    list.map(([id, n]) => `<option value="${id}"${String(id) === sel ? " selected" : ""}>${esc(n)}</option>`).join("");
  const menu = `<ul class="sidebar-menu">${filterNames.map((n) => `<li><a href="#" data-filter="${esc(n)}">${esc(n)}:</a></li>`).join("")}</ul>`;
  const form =
    menu + `<form class="search-filters"><select name="f[assigned]" class="form-control" ${assigned ? "" : "disabled"}><option value=""></option>` +
    `<option value="-1"${assigned === "-1" ? ' selected="selected"' : ""}>Unassigned</option>${opts(assignees, assigned)}</select>` +
    `<select name="f[mailbox]" class="form-control" disabled><option value=""></option>${opts(mailboxes, p.get("f[mailbox]"))}</select></form>`;
  const body = pageRows.length
    ? `<table class="table-conversations table" data-page="${pageNo}"><tbody>${pageRows
        .map(
          (c) =>
            `<tr class="conv-row${c.status === 1 ? " conv-active" : ""}" data-conversation_id="${c.id}"><td class="conv-subject">` +
            `<a href="${base}/conversation/${c.id}"><p>${c.tags?.length ? `<span class="conv-tags">${c.tags.map((t) => `<span class="tag tag-c-0" data-tag-url="${base}/search?f%5Btag%5D=${encodeURIComponent(t)}">${esc(t)}</span>`).join(" ")}</span>&nbsp;` : ""}${esc(c.subject)}</p></a></td></tr>`,
        )
        .join("")}</tbody><tfoot><tr><td class="conv-totals" colspan="6"><strong>${rows.length}</strong> conversations&nbsp;|&nbsp; ` +
      `<strong>${(pageNo - 1) * 50 + 1}</strong>-<strong>${(pageNo - 1) * 50 + pageRows.length}</strong></td></tr></tfoot></table>`
    : `<div class="empty-content"><i class="glyphicon glyphicon-search"></i><div>Nothing found</div></div>`;
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${token}"></head><body>${form}${body}</body></html>`;
}

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/fixtures/${name}`, import.meta.url)), "utf8");

/**
 * GET /reports/<name>: the scrubbed productivity page fixture (a rendered DOM, so it also carries a report; the MCP
 * never reads numbers from the page) with this session's CSRF token, retitled for satisfaction.
 */
export function reportPage(name: string, token: string): string {
  let html = fixture("reports-productivity-page.html").replaceAll("CSRFTOKEN", token);
  if (name === "satisfaction") {
    html = html.replace('data-report-name="productivity"', 'data-report-name="satisfaction" data-chart-type="pie"').replaceAll("Productivity Report", "Satisfaction Report");
  }
  // 2026-10-31 captures: the conversations and time tracking forms are the productivity form without the user select;
  // the time tracking page (slug time-tracking) renders data-report-name="time".
  if (name === "conversations" || name === "time-tracking") {
    const [wire, title, attrs] =
      name === "conversations" ? ["conversations", "Conversations Report", ""] : ["time", "Time Tracking Report", ' data-chart-type="column"'];
    html = html
      .replace(/<div class="rpt-filter">\s*User [\s\S]*?<\/select><\/span>[\s\S]*?<\/div>/, "")
      .replace('data-report-name="productivity"', `data-report-name="${wire}"${attrs}`)
      .replaceAll("Productivity Report", title);
  }
  return html;
}

/**
 * POST /reports/ajax answer from the fixtures: satisfaction -> reports-satisfaction-ajax.json; productivity with
 * chart[group_by]=m -> the 12-month fixture; productivity with filters[user] -> the one-user 10-day fixture; any other
 * productivity -> the all-users 28-day fixture. The fixtures answer for fixed ranges, whatever dates were sent.
 */
export function reportAjaxFixture(form: URLSearchParams): string {
  if (form.get("action") !== "report") return JSON.stringify({ status: "error", msg: "Unknown action" });
  const name = form.get("report_name");
  if (name === "satisfaction") return fixture("reports-satisfaction-ajax.json");
  if (name === "conversations") return fixture("reports-conversations-ajax.json");
  if (name === "time") return fixture("reports-time-tracking-ajax.json");
  if (name !== "productivity") return JSON.stringify({ status: "error", msg: "Unknown report" });
  if (form.get("chart[group_by]") === "m") return fixture("reports-productivity-ajax-by-month.json");
  if (form.has("filters[user]")) return fixture("reports-productivity-ajax-user.json");
  return fixture("reports-productivity-ajax.json");
}
