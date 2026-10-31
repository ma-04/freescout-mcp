/**
 * Streamable HTTP transport. One McpServer + Session + FreeScoutClient per MCP session, created from
 * the FreeScout identity the client sends in X-FreeScout-* headers on the initialize request.
 *
 * Every /mcp request must carry `Authorization: Bearer <MCP_TOKEN>` and the same identity headers the
 * session was created with. Nothing identity-related is kept beyond the in-memory session; logs never
 * contain header values.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { FreeScoutClient } from "./client.js";
import { log as defaultLog, redact, type Logger } from "./log.js";
import { Session } from "./session.js";
import { registerTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export const HEADER_COOKIE = "x-freescout-cookie";
export const HEADER_USER = "x-freescout-user";
export const HEADER_PASSWORD = "x-freescout-password";

export const HTTP_AUTH_ERROR_MESSAGE =
  "FreeScout session expired or invalid. Reconnect with a fresh cookie in the X-FreeScout-Cookie header, or send " +
  "X-FreeScout-User and X-FreeScout-Password to enable auto login.";

const IDENTITY_HELP =
  "Missing FreeScout identity. Send your FreeScout session on every request: either " +
  "'X-FreeScout-Cookie: <raw Cookie header value from a logged-in browser>' or " +
  "'X-FreeScout-User: <email>' plus 'X-FreeScout-Password: <password>' (or both).";

export interface HttpServerOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** MCP_TOKEN: required bearer token. */
  token: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  /** Request body limit in bytes (default 1 MB). */
  maxBodyBytes?: number;
  /** Origins allowed in addition to "no Origin header" (default: none, i.e. every browser origin is refused). */
  allowedOrigins?: string[];
  /** Consecutive login failures per session before failing fast (default 3), and for how long (default 60 s). */
  maxLoginFailures?: number;
  loginCooldownMs?: number;
  /**
   * Parsed FREESCOUT_FORWARD_ALLOW from the server environment (default: none, so forward_conversation is not
   * registered). Shared by every session; no request header can set or widen it.
   */
  forwardAllow?: readonly string[];
  /** FREESCOUT_STATS_DELAY_MS: pause between consecutive ticket_volume and agent_stats requests (default 200 ms). */
  statsDelayMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

interface Identity {
  cookie?: string;
  user?: string;
  password?: string;
  /** HMAC of the identity headers under a per-process key; compared in constant time. */
  digest: Buffer;
}

interface Entry {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  session: Session;
  digest: Buffer;
  lastSeen: number;
}

export interface McpHttpServer {
  server: Server;
  /** Live MCP sessions (exposed for tests and the reaper). */
  readonly sessionCount: number;
  /** Close sessions idle for longer than the TTL. Runs on a timer; callable directly in tests. */
  reap(): Promise<number>;
  /** Close every session and stop listening. */
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

export function createMcpHttpServer(opts: HttpServerOptions): McpHttpServer {
  const log = opts.logger ?? defaultLog;
  const now = opts.now ?? Date.now;
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const maxSessions = opts.maxSessions ?? 100;
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const hmacKey = randomBytes(32);
  const tokenDigest = digestOf(hmacKey, opts.token);
  const sessions = new Map<string, Entry>();
  const forwardAllow = Object.freeze([...(opts.forwardAllow ?? [])]);
  let pending = 0;

  const forget = (id: string, why: string): Entry | undefined => {
    const e = sessions.get(id);
    if (!e) return undefined;
    sessions.delete(id);
    void e.session.dispose();
    log.info(`session ${shortId(id)} closed (${why}); ${sessions.size} active`);
    return e;
  };

  const reap = async (): Promise<number> => {
    const cutoff = now() - ttl;
    const idle = [...sessions.values()].filter((e) => e.lastSeen < cutoff);
    for (const e of idle) {
      forget(e.id, "idle");
      await e.server.close().catch(() => undefined);
    }
    return idle.length;
  };

  const openSession = async (req: IncomingMessage, res: ServerResponse, body: unknown, ident: Identity): Promise<void> => {
    if (sessions.size + pending >= maxSessions) await reap();
    if (sessions.size + pending >= maxSessions) {
      throw new HttpError(503, `Too many MCP sessions (${maxSessions}); try again later`);
    }
    const session = new Session({
      baseUrl: opts.baseUrl,
      cookie: ident.cookie,
      user: ident.user,
      password: ident.password,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      logger: log,
      maxLoginFailures: opts.maxLoginFailures ?? 3,
      loginCooldownMs: opts.loginCooldownMs ?? 60_000,
      authErrorMessage: HTTP_AUTH_ERROR_MESSAGE,
      now,
    });
    const server = new McpServer({ name: "freescout-mcp", version: VERSION });
    registerTools(server, { client: new FreeScoutClient(session), forwardAllow, statsDelayMs: opts.statsDelayMs });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { id, transport, server, session, digest: ident.digest, lastSeen: now() });
        log.info(`session ${shortId(id)} opened (auth: ${ident.cookie ? "cookie" : "credentials"}); ${sessions.size} active`);
      },
      onsessionclosed: (id) => void forget(id, "deleted by client"),
    });
    transport.onclose = () => {
      if (transport.sessionId) forget(transport.sessionId, "transport closed");
    };
    await server.connect(transport);
    pending++;
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      pending--;
    }
    if (!transport.sessionId || !sessions.has(transport.sessionId)) {
      // initialize was rejected (bad params, protocol version...): nothing to keep.
      await server.close().catch(() => undefined);
      await session.dispose();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (url.pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      return sendJson(res, 200, { ok: true, version: VERSION });
    }
    if (url.pathname !== "/mcp") throw new HttpError(404, "Not found");

    // MCP spec (Streamable HTTP, security warning): validate Origin to stop DNS-rebinding attacks from
    // browsers. MCP clients send no Origin; any browser origin is refused unless explicitly allowed.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, "Forbidden: Origin not allowed");

    if (!bearerOk(req.headers.authorization, hmacKey, tokenDigest)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="freescout-mcp"');
      throw new HttpError(401, "Unauthorized: send Authorization: Bearer <MCP_TOKEN>");
    }
    if (method !== "GET" && method !== "POST" && method !== "DELETE") {
      res.setHeader("Allow", "GET, POST, DELETE");
      throw new HttpError(405, "Method not allowed");
    }

    let body: unknown;
    if (method === "POST") {
      const raw = await readBody(req, maxBody);
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "Parse error: invalid JSON", -32700);
      }
    }

    const ident = readIdentity(req.headers, hmacKey);
    if (!ident) throw new HttpError(401, IDENTITY_HELP, -32001);

    const sid = header(req.headers, "mcp-session-id");
    if (sid) {
      const entry = sessions.get(sid);
      if (!entry) throw new HttpError(404, "Session not found", -32001);
      if (!timingSafeEqual(entry.digest, ident.digest)) {
        throw new HttpError(403, "Forbidden: the X-FreeScout-* identity headers differ from the ones this MCP session was created with; start a new session");
      }
      entry.lastSeen = now();
      await entry.transport.handleRequest(req, res, body);
      return;
    }
    if (method !== "POST" || !isInitializeRequest(body)) {
      throw new HttpError(400, "Bad Request: no Mcp-Session-Id header; the first request must be initialize");
    }
    await openSession(req, res, body, ident);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (e.status >= 500) log.warn(`HTTP ${e.status}: ${e.message}`);
        return sendJsonRpcError(res, e.status, e.code, e.message);
      }
      log.error(`request failed: ${redact(e)}`);
      sendJsonRpcError(res, 500, -32603, "Internal server error");
    });
  });
  // Bound slow clients; SSE GET streams are long-lived, so no overall request timeout.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;

  const timer = setInterval(() => void reap(), Math.max(1_000, Math.min(60_000, ttl / 2)));
  timer.unref();

  return {
    server,
    get sessionCount() {
      return sessions.size;
    },
    reap,
    async close() {
      clearInterval(timer);
      for (const e of [...sessions.values()]) {
        forget(e.id, "shutdown");
        await e.server.close().catch(() => undefined);
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function digestOf(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function bearerOk(auth: string | undefined, key: Buffer, expected: Buffer): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth ?? "");
  if (!m) return false;
  return timingSafeEqual(digestOf(key, m[1]!), expected);
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  const s = Array.isArray(v) ? v.join(", ") : v;
  return s?.trim() || undefined;
}

/** Node hands header bytes over as latin1; a UTF-8 password/user would otherwise arrive mangled. */
function utf8(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const dec = Buffer.from(v, "latin1").toString("utf8");
  return dec.includes("�") ? v : dec;
}

function readIdentity(h: IncomingHttpHeaders, key: Buffer): Identity | undefined {
  const cookie = header(h, HEADER_COOKIE);
  const user = utf8(header(h, HEADER_USER));
  const rawPw = h[HEADER_PASSWORD];
  const password = utf8(typeof rawPw === "string" && rawPw.length ? rawPw : undefined);
  if (!cookie && !(user && password)) return undefined;
  const digest = digestOf(key, JSON.stringify([cookie ?? "", user ?? "", password ?? ""]));
  return { cookie, user, password, digest };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, `Payload too large (limit ${limit} bytes)`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `Payload too large (limit ${limit} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  if (res.headersSent) return void res.end();
  const text = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (status === 413) res.setHeader("Connection", "close");
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
