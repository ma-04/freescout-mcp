/**
 * Logging to stderr only (stdout carries the MCP stdio transport) with
 * secret redaction applied to every line and every error message we surface.
 */

const MAX_SECRETS = 500;
const secrets = new Set<string>();
/**
 * Configured secrets (password, pasted cookie values): never evicted by the per-response churn.
 * Reference-counted, so an HTTP-mode session can release the identity it pinned (removeSecret)
 * without unmasking a value that another live session or the env config still uses.
 */
const pinned = new Map<string, number>();

/** The value plus its URL-decoded / URL-encoded variants (those leak in practice too). */
function variants(value: string): string[] {
  const out = [value];
  try {
    const dec = decodeURIComponent(value);
    if (dec !== value && dec.length >= 6) out.push(dec);
  } catch {
    /* not URI-encoded */
  }
  const enc = encodeURIComponent(value);
  if (enc !== value) out.push(enc);
  return out;
}

/**
 * Register a value that must never appear in logs or error messages. `pin` it when it comes from
 * configuration; otherwise it is dropped (oldest first) once MAX_SECRETS rotated values pile up.
 */
export function addSecret(value: string | undefined | null, pin = false): void {
  if (!value || value.length < 6) return; // too short to redact safely without mangling text
  if (pin) {
    for (const v of variants(value)) pinned.set(v, (pinned.get(v) ?? 0) + 1);
    return;
  }
  if (secrets.has(value)) return;
  for (const v of variants(value)) secrets.add(v);
  while (secrets.size > MAX_SECRETS) {
    const first = secrets.values().next().value as string;
    secrets.delete(first);
  }
}

/** Release one pin taken with addSecret(value, true). The value stays masked while other pins remain. */
export function removeSecret(value: string | undefined | null): void {
  if (!value || value.length < 6) return;
  for (const v of variants(value)) {
    const n = pinned.get(v);
    if (n === undefined) continue;
    if (n <= 1) pinned.delete(v);
    else pinned.set(v, n - 1);
  }
}

const PATTERNS: Array<[RegExp, string]> = [
  // Cookie / Set-Cookie pairs for session-ish cookies.
  [/\b((?:laravel|freescout)_session|XSRF-TOKEN|remember_web_[0-9a-f]+)=([^;\s,"']+)/gi, "$1=<redacted>"],
  // Form fields and headers carrying secrets.
  [/\b(_token|password|FREESCOUT_PASSWORD|FREESCOUT_COOKIE)=([^&\s"']+)/gi, "$1=<redacted>"],
  [/\b(x-csrf-token|x-xsrf-token|x-freescout-cookie|x-freescout-password|authorization|cookie|set-cookie)\s*:\s*[^\n]+/gi, "$1: <redacted>"],
  [/(name="csrf-token"\s+content=")[^"]+/gi, "$1<redacted>"],
  [/(name="_token"\s+value=")[^"]+/gi, "$1<redacted>"],
];

export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : input instanceof Error ? input.message : safeStringify(input);
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  // Longest first so a secret containing another secret is fully masked.
  const list = [...pinned.keys(), ...secrets].sort((a, b) => b.length - a.length);
  for (const v of list) {
    if (s.includes(v)) s = s.split(v).join("<redacted>");
  }
  return s;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.FREESCOUT_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return ORDER[lvl] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

function write(level: LogLevel, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const tail = extra === undefined ? "" : " " + redact(extra);
  process.stderr.write(`[freescout-mcp] ${level.toUpperCase()} ${redact(msg)}${tail}\n`);
}

export const log: Logger = {
  debug: (m, e) => write("debug", m, e),
  info: (m, e) => write("info", m, e),
  warn: (m, e) => write("warn", m, e),
  error: (m, e) => write("error", m, e),
};

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
