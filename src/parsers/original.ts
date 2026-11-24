import type { CheerioAPI } from "cheerio";
import { htmlToText } from "./text.js";

/** Header fields returned by get_original_email; the rest (Received, DKIM, ...) is left out. */
export const ORIGINAL_HEADER_NAMES = ["from", "to", "cc", "reply-to", "date", "subject", "message-id", "in-reply-to"] as const;
export type OriginalHeaderName = (typeof ORIGINAL_HEADER_NAMES)[number];

export interface ParsedOriginal {
  /** Plain text of the stored original message (HTML converted), quoted history included. */
  body: string;
  /** Selected headers of the received email; null when FreeScout stored none (agent replies, notes). */
  headers: Partial<Record<OriginalHeaderName, string>> | null;
}

/**
 * The fragment of `GET /conversation/ajax-html/show_original?thread_id=N` (FreeScout's "Show Original" modal): tabs
 * Preview (`<iframe srcdoc>`: the message as received, before FreeScout cut the quoted history), Body
 * (`[id^=tab_body_] pre`: the thread body FreeScout kept, the same text get_conversation shows) and, for received
 * emails only, Headers (`[id^=tab_headers_] pre`). The preview is preferred (live check 2026-11-24: on a reply where
 * FreeScout kept only the quoted agent text, only the preview had the customer's words); Body is the fallback.
 * Null when the fragment has neither (unexpected markup).
 */
export function parseOriginal($: CheerioAPI): ParsedOriginal | null {
  const bodyPre = $('[id^="tab_body_"] pre').first();
  const iframe = $('[id^="tab_preview_"] iframe[srcdoc]').first();
  let source: string | null = null;
  if (iframe.length) source = iframe.attr("srcdoc") ?? "";
  else if (bodyPre.length) source = bodyPre.text();
  if (source === null) return null;
  // A plain-text email is stored as text: keep its line breaks instead of collapsing them as HTML.
  const body = /<\/?[a-z][^>]*>/i.test(source) ? htmlToText(source) : source.replace(/\r\n?/g, "\n").trim();
  const headersPre = $('[id^="tab_headers_"] pre').first();
  return { body, headers: headersPre.length ? pickHeaders(headersPre.text()) : null };
}

/** Unfold RFC 5322 header lines and keep the first value of each wanted field. */
export function pickHeaders(raw: string): Partial<Record<OriginalHeaderName, string>> {
  const out: Partial<Record<OriginalHeaderName, string>> = {};
  const wanted = new Set<string>(ORIGINAL_HEADER_NAMES);
  const unfolded = raw.replace(/\r\n?/g, "\n").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (wanted.has(name) && !(name in out)) out[name as OriginalHeaderName] = m[2]!.trim();
  }
  return out;
}
