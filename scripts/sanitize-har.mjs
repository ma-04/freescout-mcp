#!/usr/bin/env node
// Sanitize a browser HAR export so it can be shared for endpoint discovery.
//
// Keeps only the request/response details needed to document FreeScout endpoints (method, URL,
// query and form fields, response body) for requests whose path matches a keep-path (default
// "/reports"). Fail-closed: strips every header and cookie, blanks the value of every field whose
// name looks secret (token, password, passwd, secret, csrf, xsrf, api_key, apikey, auth, cookie,
// remember, session; matched as a substring after dropping brackets, "-", "_", "." and spaces and
// lowercasing, at any depth
// of JSON, urlencoded, multipart, query and HAR params; "auth" also hits e.g. "author", which is
// accepted), scrubs HTML anywhere (including HTML inside JSON strings and text/plain bodies), drops
// Laravel encrypted blobs (eyJ..., 80+ chars) from any text, removes <script>/<style> blocks, and
// finally replaces every secret value it saw anywhere in the HAR (cookies, auth/CSRF headers,
// blanked fields) wherever it still occurs in the output. It refuses to write if one survives.
//
// Node 20+, ESM, zero dependencies. Never prints header, cookie or secret values.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const USAGE = `Usage: node scripts/sanitize-har.mjs <in.har> <out.json> [--keep-path /reports]... [--all-paths]

  <in.har>            HAR 1.2 file exported from browser DevTools
  <out.json>          where to write the sanitized JSON (must not be <in.har>; keep it under captures/)
  --keep-path <str>   keep entries whose URL path contains <str> (case-insensitive);
                      repeatable; default: /reports
  --all-paths         keep every non-static entry regardless of path
  -h, --help          show this help

Removes all headers (except content-type, x-requested-with, accept on the request), all cookies,
every token/password/secret/csrf/auth/cookie/remember/session-like field, Laravel encrypted values
and binary bodies. Review the output before sharing it.`;

// Static assets are never interesting for endpoint discovery.
const STATIC_EXT = [".js", ".css", ".png", ".jpg", ".svg", ".woff", ".woff2", ".ico", ".map", ".gif"];
// A field whose name (brackets dropped, lowercased) contains one of these has its value blanked.
const SECRET_WORDS = ["token", "password", "passwd", "secret", "csrf", "xsrf", "api_key", "apikey", "auth", "cookie", "remember", "session"];
// Request headers whose values are kept (lowercased names). Everything else is dropped.
const KEPT_HEADERS = new Set(["content-type", "x-requested-with", "accept"]);
// Laravel encrypted cookie/token: base64 JSON starting with {"iv": ... -> "eyJ", 80+ characters.
// Also matches the URL-encoded form (%3D padding).
const LARAVEL_BLOB = /eyJ[A-Za-z0-9+/=_%-]{77,}/g;
// Secret values shorter than this are blanked in place but not hunted for elsewhere (too likely to hit normal text).
const MIN_SECRET_LEN = 6;
const MAX_BODY_BYTES = 400 * 1024;
const MAX_DEPTH = 6;
const BLANK = "";

function fail(message) {
  process.stderr.write(`sanitize-har: ${message}\n`);
  process.exit(1);
}

// ---- argument parsing -------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const keepPaths = [];
  let allPaths = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === "--all-paths") {
      allPaths = true;
    } else if (arg === "--keep-path") {
      const value = argv[++i];
      if (!value) fail(`--keep-path needs a value\n\n${USAGE}`);
      keepPaths.push(value.toLowerCase());
    } else if (arg.startsWith("--")) {
      fail(`unknown option ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) fail(`expected <in.har> and <out.json>\n\n${USAGE}`);
  return { input: positional[0], output: positional[1], keepPaths: keepPaths.length ? keepPaths : ["/reports"], allPaths };
}

// ---- secret bookkeeping -----------------------------------------------------------------------

/** Every secret value seen anywhere in the HAR; replaced in the whole output at the end. */
const secrets = new Set();

function remember(value) {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    for (const v of Array.isArray(value) ? value : Object.values(value)) remember(v);
    return;
  }
  const v = String(value).trim();
  if (v.length >= MIN_SECRET_LEN) secrets.add(v);
  // Also the URL-decoded form, so an encoded value found in a URL or form is caught raw too.
  try {
    const d = decodeURIComponent(v.replace(/\+/g, " "));
    if (d !== v && d.trim().length >= MIN_SECRET_LEN) secrets.add(d.trim());
  } catch {
    /* not URL-encoded */
  }
}

/** Header and cookie values: whole value, every cookie pair value, the credential after an auth scheme. */
function rememberHeader(name, value) {
  const n = String(name ?? "").toLowerCase();
  const v = String(value ?? "");
  if (n === "cookie") {
    for (const pair of v.split(";")) remember(pair.slice(pair.indexOf("=") + 1));
  } else if (n === "set-cookie") {
    for (const line of v.split("\n")) {
      const first = line.split(";")[0] ?? "";
      remember(first.slice(first.indexOf("=") + 1));
    }
    return;
  } else if (n === "authorization" || n === "proxy-authorization") {
    remember(v.replace(/^\S+\s+/, ""));
  }
  remember(v);
}

function collectSecrets(entry) {
  for (const part of [entry?.request, entry?.response]) {
    for (const h of Array.isArray(part?.headers) ? part.headers : []) {
      if (isSecretKey(h?.name)) rememberHeader(h.name, h.value);
    }
    for (const c of Array.isArray(part?.cookies) ? part.cookies : []) remember(c?.value);
  }
  try {
    const u = new URL(String(entry?.request?.url ?? ""));
    remember(decodeURIComponent(u.password));
  } catch {
    /* not a URL */
  }
}

// ---- value scrubbing --------------------------------------------------------------------------

// Brackets, "-", "_", "." and spaces are dropped before matching, so api_key, api-key, apiKey and data[api_key] all hit.
const SECRET_STEMS = SECRET_WORDS.map((w) => w.replace(/[-_]/g, ""));
const isSecretKey = (name) => {
  const k = String(name ?? "").replace(/[[\]\-_.\s]/g, "").toLowerCase();
  return SECRET_STEMS.some((w) => k.includes(w));
};
const scrubBlobs = (text) => text.replace(LARAVEL_BLOB, BLANK);
const looksUrlencoded = (text) => /^[^\s=&<{]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(text.trim());

/** Any text of unknown type: JSON, urlencoded and HTML-looking content get the matching scrub; blobs always go. */
function scrubText(text, depth = 0) {
  if (typeof text !== "string" || !text) return text;
  if (depth > MAX_DEPTH) return scrubBlobs(text);
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(t), depth + 1));
    } catch {
      /* not JSON */
    }
  }
  if (looksUrlencoded(t) && t.includes("=")) return scrubUrlencoded(t, depth + 1);
  if (text.includes("<")) return scrubHtml(text);
  return scrubBlobs(text);
}

/** [{name, value}] list with secret names blanked and the rest scrubbed. */
function scrubParams(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => {
    const name = String(p?.name ?? "");
    if (isSecretKey(name)) {
      remember(p?.value);
      return { name, value: BLANK };
    }
    return { name, value: scrubText(String(p?.value ?? "")) };
  });
}

/** Recursively blank secret keys in parsed JSON; string values are scrubbed as text (HTML inside JSON etc.). */
function scrubJson(value, depth = 0) {
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, depth));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        remember(v);
        out[k] = BLANK;
      } else out[k] = scrubJson(v, depth);
    }
    return out;
  }
  return typeof value === "string" ? scrubText(value, depth + 1) : value;
}

function scrubUrlencoded(text, depth = 0) {
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(text)) {
    if (isSecretKey(k)) {
      remember(v);
      out.append(k, BLANK);
    } else out.append(k, scrubText(v, depth + 1));
  }
  return out.toString();
}

/** multipart/form-data: each part by its name="..."; secret parts and file contents are blanked. No boundary: all of it. */
function scrubMultipart(text, mimeType) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(mimeType) ?? /^--([^\r\n]+)\r?\n/.exec(text);
  const boundary = m ? (m[1] ?? m[2]) : null;
  if (!boundary || !text.includes(`--${boundary}`)) {
    remember(text);
    return "[multipart body removed: boundary not found]";
  }
  const parts = text.split(`--${boundary}`);
  return parts
    .map((part, i) => {
      if (i === 0 || part.startsWith("--")) return part; // preamble / closing delimiter
      const sepAt = part.search(/\r?\n\r?\n/);
      if (sepAt < 0) {
        remember(part);
        return "\r\n";
      }
      const sepLen = /^\r?\n\r?\n/.exec(part.slice(sepAt))[0].length;
      const head = part.slice(0, sepAt + sepLen);
      const rawBody = part.slice(sepAt + sepLen);
      const tail = /\r?\n$/.exec(rawBody)?.[0] ?? "";
      const body = rawBody.slice(0, rawBody.length - tail.length);
      const name = /\bname\s*=\s*"([^"]*)"/i.exec(head)?.[1] ?? /\bname\s*=\s*([^\s;]+)/i.exec(head)?.[1] ?? "";
      if (isSecretKey(name)) {
        remember(body);
        return `${head}${tail}`;
      }
      if (/\bfilename\s*=/i.test(head)) return `${head}[file content removed]${tail}`;
      return `${head}${scrubText(body)}${tail}`;
    })
    .join(`--${boundary}`);
}

const unquote = (v) => (/^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v);

/** One HTML tag: attributes with a secret name, and value/content of a field whose name is secret (or a password input). */
function scrubTag(tag) {
  const nameM = /\sname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const fieldName = nameM ? (nameM[2] ?? nameM[3] ?? nameM[4] ?? "") : "";
  const secretField = (fieldName && isSecretKey(fieldName)) || /\stype\s*=\s*["']?password\b/i.test(tag);
  return tag.replace(/(\s)([^\s=/>"']+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>"']+)/g, (whole, sp, attr, eq, val) => {
    const a = attr.toLowerCase();
    if (isSecretKey(a) || (secretField && (a === "value" || a === "content"))) {
      remember(unquote(val));
      return `${sp}${attr}${eq}""`;
    }
    return whole;
  });
}

/** HTML: drop scripts/styles, blank secret fields and attributes, drop Laravel blobs anywhere (attributes too). */
function scrubHtml(html) {
  const out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[a-zA-Z][^>]*>/g, scrubTag);
  return scrubBlobs(out);
}

/** Request or response body by its MIME type; anything unrecognised is scrubbed as generic text. */
function scrubBody(text, mimeType) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime.includes("multipart/") || (/^--\S+\r?\n/.test(text) && /content-disposition/i.test(text))) {
    return scrubMultipart(text, String(mimeType ?? "")); // boundary is case-sensitive
  }
  if (mime.includes("json")) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(text)));
    } catch {
      return scrubText(text);
    }
  }
  if (mime.includes("x-www-form-urlencoded")) return scrubUrlencoded(text);
  if (mime.includes("html") || /^\s*<(!doctype|html)/i.test(text)) return scrubHtml(text);
  return scrubText(text);
}

/** URL with secret query values blanked; returns origin + path + query (no fragment, no userinfo). */
function scrubUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { url: scrubBlobs(String(raw)), pathname: String(raw) };
  }
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (isSecretKey(k)) {
      remember(v);
      params.append(k, BLANK);
    } else params.append(k, scrubText(v));
  }
  const query = params.toString();
  return { url: `${url.origin}${url.pathname}${query ? `?${query}` : ""}`, pathname: url.pathname };
}

/** Text-like MIME types whose bodies are kept (after scrubbing); anything else is binary and dropped. */
const isTextMime = (mime) => !mime || /^text\/|json|xml|javascript|x-www-form-urlencoded|html/i.test(mime);

/** Replace every remembered secret (raw, URL-encoded, JSON-escaped forms) in every string of the output. */
function replaceSecrets(value, needles) {
  if (typeof value === "string") {
    let s = value;
    for (const n of needles) if (s.includes(n)) s = s.split(n).join(BLANK);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => replaceSecrets(v, needles));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[replaceSecrets(k, needles)] = replaceSecrets(v, needles);
    return out;
  }
  return value;
}

function needlesFor(set) {
  const out = new Set();
  for (const s of set) {
    out.add(s);
    out.add(encodeURIComponent(s));
    out.add(new URLSearchParams({ x: s }).toString().slice(2));
    out.add(JSON.stringify(s).slice(1, -1));
    out.add(s.replace(/\//g, "\\/"));
  }
  // Longest first, so a secret containing another is removed whole.
  return [...out].filter((n) => n.length >= MIN_SECRET_LEN).sort((a, b) => b.length - a.length);
}

// ---- entry conversion -------------------------------------------------------------------------

function sanitizeEntry(entry, url) {
  const req = entry.request ?? {};
  const res = entry.response ?? {};

  // Only a few harmless request header values survive; names are lowercased.
  const headersKept = (Array.isArray(req.headers) ? req.headers : [])
    .filter((h) => KEPT_HEADERS.has(String(h?.name ?? "").toLowerCase()))
    .map((h) => ({ name: String(h.name).toLowerCase(), value: String(h.value ?? "") }));

  const request = {
    method: String(req.method ?? ""),
    url,
    queryString: Array.isArray(req.queryString) ? scrubParams(req.queryString) : [],
    headersKept,
  };
  if (req.postData) {
    const postData = { mimeType: String(req.postData.mimeType ?? "") };
    if (typeof req.postData.text === "string") postData.text = scrubBody(req.postData.text, postData.mimeType);
    if (Array.isArray(req.postData.params) && req.postData.params.length) postData.params = scrubParams(req.postData.params);
    request.postData = postData;
  }

  const content = res.content ?? {};
  const mimeType = String(content.mimeType ?? "");
  let text = typeof content.text === "string" ? content.text : "";
  if (text && !isTextMime(mimeType)) {
    text = `[binary body removed: ${mimeType}]`;
  } else {
    if (text && content.encoding === "base64") text = Buffer.from(text, "base64").toString("utf8");
    text = scrubBody(text, mimeType);
  }

  const response = { status: Number(res.status ?? 0), mimeType, text };
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    response.text = Buffer.from(text, "utf8").subarray(0, MAX_BODY_BYTES).toString("utf8");
    response.truncated = true;
  }

  return { startedDateTime: String(entry.startedDateTime ?? ""), request, response };
}

// ---- main ---------------------------------------------------------------------------------------

function main() {
  const { input, output, keepPaths, allPaths } = parseArgs(process.argv.slice(2));
  const real = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
  if (resolve(input) === resolve(output) || real(input) === real(output)) {
    fail("refusing to write the output over the input HAR; give a different <out.json>");
  }
  const capturesDir = resolve("captures") + sep;
  if (!resolve(output).startsWith(capturesDir)) {
    process.stderr.write(`sanitize-har: note: ${output} is outside captures/ (which is git-ignored); do not commit it.\n`);
  }

  let har;
  try {
    har = JSON.parse(readFileSync(input, "utf8"));
  } catch (err) {
    fail(`cannot read or parse ${input} as JSON (${err.code ?? err.name})`);
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) fail(`${input} is not a HAR file (no log.entries array)`);

  for (const entry of entries) collectSecrets(entry);

  const kept = [];
  let droppedPath = 0;
  let droppedStatic = 0;
  for (const entry of entries) {
    const { url, pathname } = scrubUrl(entry?.request?.url ?? "");
    const lowerPath = pathname.toLowerCase();
    if (STATIC_EXT.some((ext) => lowerPath.endsWith(ext))) {
      droppedStatic++;
      continue;
    }
    if (!allPaths && !keepPaths.some((p) => lowerPath.includes(p))) {
      droppedPath++;
      continue;
    }
    kept.push(sanitizeEntry(entry, url));
  }

  const needles = needlesFor(secrets);
  const doc = replaceSecrets(
    {
      sanitizedBy: "scripts/sanitize-har.mjs",
      keepPaths: allPaths ? ["*"] : keepPaths,
      entries: kept,
    },
    needles,
  );
  const out = JSON.stringify(doc, null, 2);
  // Fail closed: nothing remembered as secret may survive, nor any Laravel blob.
  const survivors = [...secrets].filter((v) => out.includes(v) || out.includes(JSON.stringify(v).slice(1, -1))).length;
  if (survivors || new RegExp(LARAVEL_BLOB.source).test(out)) {
    fail(`refusing to write: ${survivors} secret value(s) or an encrypted blob would survive (please report this)`);
  }
  try {
    writeFileSync(output, `${out}\n`);
  } catch (err) {
    fail(`cannot write ${output} (${err.code ?? err.name})`);
  }

  process.stderr.write(
    [
      `entries in:        ${entries.length}`,
      `kept:              ${kept.length}`,
      `dropped by path:   ${droppedPath}`,
      `dropped as static: ${droppedStatic}`,
      `secret values blanked everywhere: ${secrets.size}`,
      `output size:       ${Buffer.byteLength(out, "utf8")} bytes -> ${output}`,
      `Review the output before sharing it (it may contain agent names, customer comments).`,
    ].join("\n") + "\n",
  );
}

main();
