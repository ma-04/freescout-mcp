import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/sanitize-har.mjs: the HAR sanitizer the user runs on their own Reports capture before
// handing it over (docs/reports-capture.md). These tests run the real script with node.

const SCRIPT = join(process.cwd(), "scripts", "sanitize-har.mjs");
const SESSION = "SECRET_SESSION_COOKIE_VALUE_123";
const XSRF = "SECRET_XSRF_HEADER_VALUE_456";
const BEARER = "SECRET_BEARER_789";
const CSRF = "SECRETCSRFTOKENabcdef";
const LARAVEL = `eyJpdiI6${"A".repeat(150)}`;

const base = "https://support.example.test";
const entry = (url: string, extra: Record<string, unknown> = {}) => ({
  startedDateTime: "2026-10-28T10:00:00.000Z",
  request: {
    method: "GET",
    url,
    httpVersion: "HTTP/1.1",
    headers: [
      { name: "Cookie", value: `laravel_session=${SESSION}` },
      { name: "Authorization", value: `Bearer ${BEARER}` },
      { name: "X-XSRF-TOKEN", value: XSRF },
      { name: "X-Requested-With", value: "XMLHttpRequest" },
      { name: "Accept", value: "application/json" },
    ],
    cookies: [{ name: "laravel_session", value: SESSION }],
    queryString: [],
    ...extra,
  },
  response: {
    status: 200,
    headers: [{ name: "Set-Cookie", value: `laravel_session=${SESSION}` }],
    cookies: [{ name: "laravel_session", value: SESSION }],
    content: { mimeType: "application/json", text: '{"ok":true}' },
  },
});

const har = {
  log: {
    version: "1.2",
    entries: [
      entry(`${base}/reports/productivity?from=2026-09-01&_token=${CSRF}`, {
        queryString: [
          { name: "from", value: "2026-09-01" },
          { name: "_token", value: CSRF },
        ],
      }),
      {
        ...entry(`${base}/Reports/ajax`, {
          method: "POST",
          postData: {
            mimeType: "application/x-www-form-urlencoded; charset=UTF-8",
            text: `action=report&_token=${CSRF}&user_id=3&blob=${LARAVEL}`,
            params: [
              { name: "action", value: "report" },
              { name: "_token", value: CSRF },
            ],
          },
        }),
      },
      (() => {
        const e = entry(`${base}/reports/satisfaction`);
        const html =
          `<!DOCTYPE html><html><head><meta name="csrf-token" content="${CSRF}">` +
          `<script>var secret="${CSRF}";</script><style>.x{}</style></head>` +
          `<body><input type="hidden" name="_token" value="${CSRF}"><table><td>Great support</td></table></body></html>`;
        e.response.content = { mimeType: "text/html; charset=UTF-8", text: Buffer.from(html).toString("base64"), encoding: "base64" } as never;
        return e;
      })(),
      entry(`${base}/mailbox/1`),
      entry(`${base}/reports/js/reports.js`),
      entry(`${base}/reports/img/logo.png`),
    ],
  },
};

let dir: string;
let inFile: string;
const run = (args: string[]) => execFileSync("node", [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
const sanitize = (extra: string[] = []) => {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
  run([inFile, out, ...extra]);
  const text = readFileSync(out, "utf8");
  return { text, json: JSON.parse(text) as { entries: Array<Record<string, any>> } };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sanitize-har-"));
  inFile = join(dir, "in.har");
  writeFileSync(inFile, JSON.stringify(har));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sanitize-har", () => {
  it("keeps only /reports entries (case-insensitive) and drops static assets", () => {
    const { json } = sanitize();
    const urls = json.entries.map((e) => e.request.url);
    expect(urls).toEqual([
      `${base}/reports/productivity?from=2026-09-01&_token=`,
      `${base}/Reports/ajax`,
      `${base}/reports/satisfaction`,
    ]);
  });

  it("removes cookies, auth headers and every secret value", () => {
    const { text, json } = sanitize();
    for (const secret of [SESSION, XSRF, BEARER, CSRF, LARAVEL.slice(0, 60)]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"cookies"/);
    expect(text).not.toMatch(/"headers"/);
    expect(json.entries[0].request.headersKept).toEqual([
      { name: "x-requested-with", value: "XMLHttpRequest" },
      { name: "accept", value: "application/json" },
    ]);
  });

  it("blanks _token in query, urlencoded text and params", () => {
    const { json } = sanitize();
    expect(json.entries[0].request.queryString).toEqual([
      { name: "from", value: "2026-09-01" },
      { name: "_token", value: "" },
    ]);
    const post = json.entries[1].request.postData;
    expect(post.text).toBe("action=report&_token=&user_id=3&blob=");
    expect(post.params).toEqual([
      { name: "action", value: "report" },
      { name: "_token", value: "" },
    ]);
  });

  it("decodes base64 bodies and strips scripts, styles and csrf values from HTML", () => {
    const { json } = sanitize();
    const body = json.entries[2].response.text as string;
    expect(body).toContain("Great support");
    expect(body).not.toMatch(/<script|<style/i);
    expect(body).toContain('<meta name="csrf-token" content="">');
    expect(body).toContain('name="_token" value=""');
  });

  it("--all-paths keeps non-report entries but still drops static assets", () => {
    const { json } = sanitize(["--all-paths"]);
    expect(json.entries.map((e) => e.request.url)).toContain(`${base}/mailbox/1`);
    expect(json.entries).toHaveLength(4);
  });

  it("--keep-path selects other paths", () => {
    const { json } = sanitize(["--keep-path", "/mailbox"]);
    expect(json.entries.map((e) => e.request.url)).toEqual([`${base}/mailbox/1`]);
  });

  it("exits non-zero on bad usage and unparsable input", () => {
    expect(spawnSync("node", [SCRIPT]).status).toBe(1);
    expect(spawnSync("node", [SCRIPT, inFile, join(dir, "x.json"), "--bogus"]).status).toBe(1);
    const bad = join(dir, "bad.har");
    writeFileSync(bad, "not json");
    const r = spawnSync("node", [SCRIPT, bad, join(dir, "y.json")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });
});

// Red-team shapes (2026-10-28 review, M4). Each shape carries its own secret, none of which appears in a header or
// cookie, so the structural scrub has to catch it; the onclick case is caught by the literal "seen elsewhere" pass.
describe("sanitize-har: fail-closed shapes from the 2026-10-28 review", () => {
  const S = {
    multipartToken: "MPTOKENsecret0123456789abcdefghijklmnop",
    multipartPass: "hunter2multipart",
    jsonHtmlToken: "JSONHTMLtoken0123456789abcdefghijklmn",
    jsonHtmlMeta: "JSONMETAcsrf0123456789abcdefghijklmnop",
    userPassword: "nestedUserPass99",
    confirm: "confirmPass77x",
    current: "currentPass55y",
    dataToken: "DATATOKENnested0123456789abcdefghijkl",
    csrfKey: "CSRFKEYjson0123456789abcdefghijklmnopq",
    accessToken: "ACCESSTOKENjson0123456789abcdefghijk",
    headerKey: "XCSRFKEYjson0123456789abcdefghijklmno",
    listToken: "LISTTOKENjson0123456789abcdefghijklmn",
    plainToken: "PLAINTEXTtoken0123456789abcdefghijklm",
    htmlInputToken: "ONCLICKtoken0123456789abcdefghijklmnop",
    passwordInput: "pwInputConfirm42",
    typePassword: "typePasswordVal1",
    blob: `eyJpdiI6${"B".repeat(90)}`,
    apiKey: "APIKEYvalue0123456789",
    remember: "rememberMeValue1234",
  };
  const e = (url: string, request: Record<string, unknown>, content: Record<string, unknown>) => ({
    startedDateTime: "2026-10-28T10:00:00.000Z",
    request: { method: "POST", url, headers: [], ...request },
    response: { status: 200, headers: [], content },
  });
  const crafted = {
    log: {
      entries: [
        // 1. multipart body with _token and password parts; 2. JSON response whose string value is HTML.
        e(
          `${base}/reports/ajax`,
          {
            postData: {
              mimeType: "multipart/form-data; boundary=----X",
              text:
                `------X\r\nContent-Disposition: form-data; name="_token"\r\n\r\n${S.multipartToken}\r\n` +
                `------X\r\nContent-Disposition: form-data; name="password"\r\n\r\n${S.multipartPass}\r\n` +
                `------X\r\nContent-Disposition: form-data; name="period"\r\n\r\nweek\r\n------X--\r\n`,
            },
          },
          {
            mimeType: "application/json",
            text: JSON.stringify({
              status: "success",
              html: `<form><input type="hidden" name="_token" value="${S.jsonHtmlToken}"></form><meta name="csrf-token" content="${S.jsonHtmlMeta}">`,
            }),
          },
        ),
        // 3. nested/suffixed urlencoded keys; 5. blobs in HTML attributes; onclick token; inputs with value first.
        e(
          `${base}/reports/save`,
          {
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text:
                `user%5Bpassword%5D=${S.userPassword}&password_confirmation=${S.confirm}&current_password=${S.current}` +
                `&data[_token]=${S.dataToken}&api-key=${S.apiKey}&remember_me=${S.remember}&period=week`,
            },
          },
          {
            mimeType: "text/html",
            text:
              `<!doctype html><div data-x="${S.blob}" onclick="var t='${S.htmlInputToken}'"></div>` +
              `<input value="${S.htmlInputToken}" name="_token"><input name="password_confirmation" value="${S.passwordInput}">` +
              `<input type="password" name="pw" value="${S.typePassword}"><td>Week 43</td>`,
          },
        ),
        // 4. JSON keys csrf_token, access_token, X-CSRF-TOKEN, nested lists; 6. text/plain urlencoded response.
        e(
          `${base}/reports/j`,
          {
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({
                headers: { "X-CSRF-TOKEN": S.headerKey },
                csrf_token: S.csrfKey,
                access_token: S.accessToken,
                list: [{ _token: S.listToken }],
                period: "month",
              }),
            },
          },
          { mimeType: "text/plain", text: `_token=${S.plainToken}` },
        ),
        // Binary export (I4).
        e(`${base}/reports/export`, {}, { mimeType: "application/vnd.ms-excel", encoding: "base64", text: Buffer.from("PK\u0003\u0004binary").toString("base64") }),
      ],
    },
  };

  let cdir: string;
  let cin: string;
  beforeAll(() => {
    cdir = mkdtempSync(join(tmpdir(), "sanitize-har-crafted-"));
    cin = join(cdir, "crafted.har");
    writeFileSync(cin, JSON.stringify(crafted));
  });
  afterAll(() => rmSync(cdir, { recursive: true, force: true }));

  it("no secret of any shape survives anywhere in the output", () => {
    const out = join(cdir, "out.json");
    execFileSync("node", [SCRIPT, cin, out], { stdio: ["ignore", "pipe", "pipe"] });
    const text = readFileSync(out, "utf8");
    for (const [what, secret] of Object.entries(S)) expect(text, what).not.toContain(secret.slice(0, 40));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9+/=_%-]{20,}/);
    // Non-secret content survives.
    const json = JSON.parse(text) as { entries: Array<Record<string, any>> };
    expect(json.entries[0].request.postData.text).toContain('name="period"\r\n\r\nweek');
    expect(json.entries[0].request.postData.text).toContain('name="_token"\r\n\r\n\r\n');
    expect(json.entries[1].request.postData.text).toContain("period=week");
    expect(json.entries[1].response.text).toContain("<td>Week 43</td>");
    expect(JSON.parse(json.entries[2].request.postData.text)).toMatchObject({ csrf_token: "", access_token: "", period: "month", list: [{ _token: "" }] });
    expect(json.entries[2].response.text).toBe("_token=");
    expect(json.entries[3].response.text).toBe("[binary body removed: application/vnd.ms-excel]");
  });

  it("a multipart body without a findable boundary is removed whole", () => {
    const har = { log: { entries: [e(`${base}/reports/m`, { postData: { mimeType: "multipart/form-data", text: `_token=${S.multipartToken}` } }, { mimeType: "text/html", text: "<p>ok</p>" })] } };
    const i = join(cdir, "nb.har");
    const o = join(cdir, "nb.json");
    writeFileSync(i, JSON.stringify(har));
    execFileSync("node", [SCRIPT, i, o], { stdio: ["ignore", "pipe", "pipe"] });
    const text = readFileSync(o, "utf8");
    expect(text).not.toContain(S.multipartToken);
    expect(text).toContain("[multipart body removed: boundary not found]");
  });

  it("refuses to write the output over the input", () => {
    const before = readFileSync(cin, "utf8");
    const r = spawnSync("node", [SCRIPT, cin, cin], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to write the output over the input/);
    const r2 = spawnSync("node", [SCRIPT, cin, join(cdir, ".", "crafted.har")], { encoding: "utf8" });
    expect(r2.status).toBe(1);
    expect(readFileSync(cin, "utf8")).toBe(before);
  });
});
