import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import type { FreeScoutPort, HtmlPage } from "../src/client.js";
import { FreeScoutError, PermissionError } from "../src/errors.js";
import { getOriginalEmail } from "../src/operations.js";
import { parseConversation } from "../src/parsers/conversation.js";
import { parseOriginal, pickHeaders } from "../src/parsers/original.js";

const BASE = "https://freescout.example.com";
/** FreeScout's srcdoc escaping: only the double quote. */
const escQuot = (s: string) => s.replace(/"/g, "&quot;");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Synthetic "Show Original" fragment, same shape as FreeScout's (tabs Preview / Body / Headers). */
function fragment(body: string, headers?: string, kept = body): string {
  return `<ul class="nav nav-tabs nav-tabs-no-bottom">
	<li role="presentation" class="active"><a data-toggle="tab" href="#tab_preview_1">Preview</a></li>
	<li role="presentation"><a data-toggle="tab" href="#tab_body_1">Body</a></li>
	${headers ? '<li role="presentation"><a data-toggle="tab" href="#tab_headers_1">Headers</a></li>' : ""}</ul>
<div class="tab-content">
	<div id="tab_preview_1" class="tab-pane fade in active"><iframe sandbox="" srcdoc="${escQuot(body)}" frameborder="0" class="preview-iframe tab-body"></iframe></div>
	<div id="tab_body_1" class="tab-pane fade"><pre class="pre-wrap">${esc(kept)}</pre></div>
	${headers ? `<div id="tab_headers_1" class="tab-pane fade"><pre class="pre-wrap">${esc(headers)}</pre></div>` : ""}
</div>`;
}

const CUSTOMER_BODY =
  `<p>It works now, thanks. You can close the ticket.</p><p>Sam</p>` +
  `<div class="gmail_quote"><div class="gmail_attr">On Mon, Demo Support &lt;support@example.com&gt; wrote:</div>` +
  `<blockquote class="gmail_quote"><html><head><style>p { margin:0 }</style></head><body><p>Could you retest?</p></body></html></blockquote></div>`;
const HEADERS = [
  "Received: by mx.example.net with SMTP id abc",
  "        for <support@example.com>; Mon, 2 Nov 2026 06:13:31 -0800",
  "DKIM-Signature: v=1; a=rsa-sha256; d=example.org;",
  "From: Sam Customer <sam@example.org>",
  "Date: Mon, 2 Nov 2026 06:13:28 -0800",
  "Message-ID: <abc@mail.example.org>",
  "Subject: Re: [#9] Login page",
  " is blank",
  "To: Demo Support <support@example.com>",
  "In-Reply-To: <reply-20-x@example.com>",
].join("\n");

function port(pages: Record<number, string | Error>): FreeScoutPort & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async getHtml(path: string): Promise<HtmlPage> {
      gets.push(path);
      const m = /^\/conversation\/ajax-html\/show_original\?thread_id=(\d+)$/.exec(path);
      if (!m) throw new Error(`unexpected GET ${path}`);
      const p = pages[Number(m[1])];
      if (p === undefined) throw new FreeScoutError("FreeScout page not found: /conversation/ajax-html/show_original", 404);
      if (p instanceof Error) throw p;
      return { $: cheerio.load(p), url: new URL(path, BASE).toString(), status: 200, text: p };
    },
    async ajaxPost<T>(): Promise<T> {
      throw new Error("no ajax expected");
    },
  };
}

describe("parseOriginal", () => {
  it("returns the customer's text first, drops head/style of quoted mail, and picks allow-listed headers", () => {
    const r = parseOriginal(cheerio.load(fragment(CUSTOMER_BODY, HEADERS)))!;
    expect(r.body.startsWith("It works now, thanks. You can close the ticket.\n\nSam")).toBe(true);
    expect(r.body).toContain("Could you retest?");
    expect(r.body).not.toContain("margin");
    expect(r.headers).toEqual({
      from: "Sam Customer <sam@example.org>",
      date: "Mon, 2 Nov 2026 06:13:28 -0800",
      "message-id": "<abc@mail.example.org>",
      subject: "Re: [#9] Login page is blank",
      to: "Demo Support <support@example.com>",
      "in-reply-to": "<reply-20-x@example.com>",
    });
  });

  it("has null headers for an agent reply (two tabs)", () => {
    const r = parseOriginal(cheerio.load(fragment("<p>Hi Sam,</p><p>Could you retest?</p>")))!;
    expect(r).toEqual({ body: "Hi Sam,\n\nCould you retest?", headers: null });
  });

  it("reads the preview (as received), not the Body tab (FreeScout's cut body)", () => {
    const r = parseOriginal(cheerio.load(fragment(CUSTOMER_BODY, HEADERS, "<p>Could you retest?</p>")))!;
    expect(r.body.startsWith("It works now")).toBe(true);
  });

  it("keeps line breaks of a plain-text body and falls back to the Body tab", () => {
    expect(parseOriginal(cheerio.load(fragment("line one\r\nline two\n\n-- \nSam")))!.body).toBe("line one\nline two\n\n-- \nSam");
    const bodyOnly = `<div id="tab_body_2"><pre class="pre-wrap">${esc("<p>only body</p>")}</pre></div>`;
    expect(parseOriginal(cheerio.load(bodyOnly))!.body).toBe("only body");
  });

  it("keeps entity-escaped text the customer typed (srcdoc is only quote-escaped)", async () => {
    const body = `<p>I get &lt;b&gt;Fatal error&lt;/b&gt; from &lt;sam@example.org&gt; &amp; &lt;script&gt;x&lt;/script&gt; "quoted"</p>`;
    const r = await getOriginalEmail(port({ 21: fragment(body) }), 21);
    expect(r.body).toBe('I get <b>Fatal error</b> from <sam@example.org> & <script>x</script> "quoted"');
  });

  it("is null for unexpected markup", () => {
    expect(parseOriginal(cheerio.load("<html><body><h1>Dashboard</h1></body></html>"))).toBeNull();
  });

  it("pickHeaders keeps the first value of a repeated field", () => {
    expect(pickHeaders("To: a@example.com\nTo: b@example.com")).toEqual({ to: "a@example.com" });
  });
});

describe("getOriginalEmail", () => {
  it("GETs the show_original fragment once and returns body + headers", async () => {
    const p = port({ 20: fragment(CUSTOMER_BODY, HEADERS) });
    const r = await getOriginalEmail(p, 20);
    expect(p.gets).toEqual(["/conversation/ajax-html/show_original?thread_id=20"]);
    expect(r.thread_id).toBe(20);
    expect(r.headers?.from).toBe("Sam Customer <sam@example.org>");
    expect(r.body_truncated).toBeUndefined();
  });

  it("truncates the body to maxChars", async () => {
    const r = await getOriginalEmail(port({ 20: fragment(`<p>${"x".repeat(500)}</p>`, HEADERS) }), 20, 200);
    expect(r.body.length).toBe(202);
    expect(r.body_truncated).toBe(true);
  });

  it("maps 404 to a clear not-found error and passes permission errors through", async () => {
    await expect(getOriginalEmail(port({}), 999)).rejects.toThrow(/Thread 999 not found, or FreeScout has no original/);
    await expect(getOriginalEmail(port({ 5: new PermissionError("denied") }), 5)).rejects.toBeInstanceOf(PermissionError);
  });

  it("fails loudly on unexpected markup", async () => {
    await expect(getOriginalEmail(port({ 7: "<p>login</p>" }), 7)).rejects.toThrow(/Unexpected FreeScout markup/);
  });
});

describe("get_conversation has_original", () => {
  it("marks threads whose menu offers Show Original", () => {
    const html = readFileSync(fileURLToPath(new URL("../docs/fixtures/conversation-9.html", import.meta.url)), "utf8");
    const c = parseConversation(cheerio.load(html), `${BASE}/conversation/9?folder_id=17`);
    const flagged = c.threads.filter((t) => t.has_original).map((t) => t.thread_id);
    expect(flagged.sort()).toEqual([18, 20]);
  });
});
