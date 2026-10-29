import { parseForwardAllow } from "./forward-allow.js";
import { log } from "./log.js";

export { parseForwardAllow, recipientAllowed } from "./forward-allow.js";

/** Default pause between consecutive ticket_volume requests (FREESCOUT_STATS_DELAY_MS overrides; 0 = none). */
export const DEFAULT_STATS_DELAY_MS = 200;

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/** Settings shared by both transports: which FreeScout to talk to, and how. */
export interface BaseConfig {
  baseUrl: string;
  timeoutMs: number;
  /**
   * FREESCOUT_FORWARD_ALLOW, parsed: exact addresses and `@domain` entries. Empty = forward_conversation is not
   * registered. Always from the server's environment; never from a request header.
   */
  forwardAllow: string[];
  /** FREESCOUT_STATS_DELAY_MS: pause between consecutive ticket_volume requests (default 200, 0 allowed). */
  statsDelayMs: number;
}

/** stdio mode: one FreeScout identity, taken from the environment. */
export interface Config extends BaseConfig {
  cookie?: string;
  user?: string;
  password?: string;
}

/** HTTP mode: identities arrive per MCP session in request headers, never from the environment. */
export interface HttpConfig extends BaseConfig {
  host: string;
  port: number;
  /** Bearer token every request must present. */
  token: string;
  sessionTtlMs: number;
  maxSessions: number;
}

/** FREESCOUT_URL (validated, http:// refused unless allowed, user:pass@ stripped) and FREESCOUT_TIMEOUT_MS. */
export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  const url = env.FREESCOUT_URL?.trim();
  if (!url) throw new Error("FREESCOUT_URL is required (e.g. https://support.example.com)");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`FREESCOUT_URL is not a valid URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("FREESCOUT_URL must be http(s)");
  if (parsed.protocol === "http:" && !LOOPBACK.test(parsed.hostname)) {
    if (env.FREESCOUT_ALLOW_INSECURE !== "1") {
      throw new Error(
        `FREESCOUT_URL uses plain http:// (${parsed.host}): the session cookie and password would be sent unencrypted. ` +
          "Use the https:// URL of your FreeScout, or set FREESCOUT_ALLOW_INSECURE=1 if you really mean it.",
      );
    }
    log.warn(`FREESCOUT_URL is plain http:// (${parsed.host}); FREESCOUT_ALLOW_INSECURE=1 is set, so credentials travel unencrypted`);
  }
  if (parsed.username || parsed.password) {
    log.warn("FREESCOUT_URL contains user:pass@; it is ignored (use FREESCOUT_USER/FREESCOUT_PASSWORD)");
    parsed.username = "";
    parsed.password = "";
  }
  return {
    baseUrl: parsed.toString(),
    timeoutMs: positiveInt(env.FREESCOUT_TIMEOUT_MS, 30_000),
    forwardAllow: parseForwardAllow(env.FREESCOUT_FORWARD_ALLOW),
    statsDelayMs: nonNegativeInt(env.FREESCOUT_STATS_DELAY_MS, DEFAULT_STATS_DELAY_MS),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = loadBaseConfig(env);
  const cookie = env.FREESCOUT_COOKIE?.trim() || undefined;
  const user = env.FREESCOUT_USER?.trim() || undefined;
  const password = env.FREESCOUT_PASSWORD || undefined;
  if (!cookie && !(user && password)) {
    throw new Error("Set FREESCOUT_COOKIE, or FREESCOUT_USER and FREESCOUT_PASSWORD (or both).");
  }
  return { ...base, cookie, user, password };
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*", ""]);

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const base = loadBaseConfig(env);
  const token = env.MCP_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error("MCP_TOKEN is required in HTTP mode (every request must send Authorization: Bearer <MCP_TOKEN>). Generate one with: openssl rand -hex 32");
  }
  if (token.length < 32) throw new Error("MCP_TOKEN is too short; use at least 32 characters (openssl rand -hex 32)");
  const host = (env.MCP_HOST ?? "127.0.0.1").trim();
  if (WILDCARD_HOSTS.has(host) && env.MCP_ALLOW_PUBLIC_BIND !== "1") {
    throw new Error(
      `MCP_HOST=${host || "(empty)"} would listen on every interface, including public ones. Bind to loopback (127.0.0.1) ` +
        "or to your Tailscale IP (100.x.y.z) instead. Set MCP_ALLOW_PUBLIC_BIND=1 only when something else restricts " +
        "access, e.g. inside a container whose port is published on the Tailscale IP only.",
    );
  }
  for (const k of ["FREESCOUT_COOKIE", "FREESCOUT_USER", "FREESCOUT_PASSWORD"]) {
    if (env[k]) log.warn(`${k} is set but ignored in HTTP mode; each client sends its own X-FreeScout-* headers`);
  }
  const port = positiveInt(env.MCP_PORT, 8787);
  if (port > 65535) throw new Error(`MCP_PORT is not a valid port: ${env.MCP_PORT}`);
  return {
    ...base,
    host,
    port,
    token,
    sessionTtlMs: positiveInt(env.MCP_SESSION_TTL_MS, 30 * 60_000),
    maxSessions: positiveInt(env.MCP_MAX_SESSIONS, 100),
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
