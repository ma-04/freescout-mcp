import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { htmlToText } from "./text.js";

/** Header fields returned by get_original_email; the rest (Received, DKIM, ...) is left out. */
export const ORIGINAL_HEADER_NAMES = ["from", "to", "cc", "reply-to", "date", "subject", "message-id", "in-reply-to"] as const;
export type OriginalHeaderName = (typeof ORIGINAL_HEADER_NAMES)[number];

/** Longest header value returned (a mass-Cc'd or crafted header is cut with " …"). */
export const HEADER_VALUE_MAX = 2_000;

export interface ParsedOriginal {
  /** Plain text of the stored original message (HTML converted), quoted history included. */
  body: string;
  /** Selected headers of the received email; null when FreeScout stored none (agent replies, notes). */
  headers: Partial<Record<OriginalHeaderName, string>> | null;
}

/**
 * The raw response of `GET /conversation/ajax-html/show_original?thread_id=N` (FreeScout's "Show Original" modal):
 * tabs Preview (`<iframe srcdoc>`: the message as received, before FreeScout cut the quoted history), Body
 * (`[id^=tab_body_] pre`: the thread body FreeScout kept, the same text get_conversation shows) and, for received
 * emails only, Headers (`[id^=tab_headers_] pre`). The preview is preferred (live check 2026-11-24: on a reply where
 * FreeScout kept only the quoted agent text, only the preview had the customer's words); Body is the fallback.
 * Takes the raw text, not a parsed page: the srcdoc value must be cut from the source (see srcdocSource).
 * Null when the fragment has neither tab (unexpected markup).
 */
export function parseOriginal(raw: string): ParsedOriginal | null {
  const $ = cheerio.load(raw, { sourceCodeLocationInfo: true });
  const iframe = $('[id^="tab_preview_"] iframe[srcdoc]').get(0);
  const bodyPre = $('[id^="tab_body_"] pre').first();
  let source: string | null = null;
  if (iframe) source = srcdocSource(raw, iframe);
  else if (bodyPre.length) source = bodyPre.text();
  if (source === null) return null;
  const body = looksLikeHtml(source) ? htmlToText(source) : decodeEntities(source.replace(/\r\n?/g, "\n")).trim();
  const headersPre = $('[id^="tab_headers_"] pre').first();
  return { body, headers: headersPre.length ? pickHeaders(headersPre.text()) : null };
}

/**
 * FreeScout escapes only `"` (as `&quot;`) in the preview's srcdoc; the stored HTML goes in otherwise as is. Decoding
 * the attribute like a browser would turn the body's own `&lt;b&gt;` (text the customer typed) into markup that
 * htmlToText drops, so the value is cut from the raw source at the parser's offsets (linear, scoped to this element,
 * any quoting) and only `&quot;` is undone. Known limit, inherent to that escaping: a stored attribute that itself
 * contained `&quot;` comes back as a bare `"`.
 */
function srcdocSource(raw: string, iframe: Element): string {
  // parse5 records per-attribute offsets (sourceCodeLocationInfo); domhandler's type omits `attrs`.
  type Loc = { startOffset: number; endOffset: number };
  const loc = (iframe.sourceCodeLocation as { attrs?: Record<string, Loc> } | null | undefined)?.attrs?.["srcdoc"];
  const decoded = iframe.attribs["srcdoc"] ?? "";
  if (!loc) return decoded;
  const m = /^srcdoc\s*=\s*(["']?)([\s\S]*)$/i.exec(raw.slice(loc.startOffset, loc.endOffset));
  if (!m) return decoded;
  let value = m[2]!;
  if (m[1] && value.endsWith(m[1])) value = value.slice(0, -1);
  return value.replace(/&quot;/g, '"');
}

/**
 * HTML when it has a common email element. Not "any <word>": a plain-text email with "<sam@example.org>",
 * "<https://...>" or "the <style> tag" must keep its line breaks and text.
 */
const HTML_TAG =
  /<\/?(?:html|body|p|div|br|span|a|b|i|u|em|strong|font|table|tbody|thead|tr|td|th|ul|ol|li|blockquote|pre|code|h[1-6]|img|hr|center|section|article|header|footer)(?=[\s/>])[^<>]*>/i;
function looksLikeHtml(s: string): boolean {
  return HTML_TAG.test(s);
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Entities of a plain-text body (the browser would decode them too); unknown ones stay as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/** Unfold RFC 5322 header lines and keep the first value of each wanted field, capped at HEADER_VALUE_MAX. */
export function pickHeaders(raw: string): Partial<Record<OriginalHeaderName, string>> {
  const out: Partial<Record<OriginalHeaderName, string>> = {};
  const wanted = new Set<string>(ORIGINAL_HEADER_NAMES);
  const unfolded = raw.replace(/\r\n?/g, "\n").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const m = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (!wanted.has(name) || name in out) continue;
    const v = m[2]!.trim();
    out[name as OriginalHeaderName] = v.length > HEADER_VALUE_MAX ? v.slice(0, HEADER_VALUE_MAX) + " …" : v;
  }
  return out;
}
