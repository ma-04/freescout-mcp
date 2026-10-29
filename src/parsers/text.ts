import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

/** Collapse runs of whitespace (including &nbsp;) to single spaces and trim. */
export function squish(s: string | undefined | null): string {
  return (s ?? "").replace(/[\s ]+/g, " ").trim();
}

/** squish() that returns null for empty strings. */
export function textOrNull(s: string | undefined | null): string | null {
  const t = squish(s);
  return t ? t : null;
}

export function intOrNull(s: string | undefined | null): number | null {
  const m = /-?\d+/.exec(s ?? "");
  return m ? Number(m[0]) : null;
}

const BLOCK = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "tr",
  "section", "article", "header", "footer", "hr", "dl", "dt", "dd", "address", "figure",
]);
const SKIP = new Set(["script", "style", "head", "title", "meta", "link", "noscript", "template"]);

/**
 * Convert an HTML fragment (string or cheerio selection) to readable plain text:
 * paragraphs and block elements become line breaks, <br> a newline, list items
 * "- ", links "text (url)" when the URL adds information. Whitespace is squeezed
 * and runs of blank lines collapsed to one.
 */
export function htmlToText(input: string | cheerio.Cheerio<AnyNode>): string {
  const nodes: AnyNode[] =
    typeof input === "string" ? (cheerio.load(input, null, false).root().contents().toArray() as AnyNode[]) : input.contents().toArray();
  const out: string[] = [];
  for (const n of nodes) walk(n, out);
  return out
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(node: AnyNode, out: string[]): void {
  if (node.type === "text") {
    out.push((node as unknown as { data: string }).data.replace(/[\s ]+/g, " "));
    return;
  }
  if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
  const el = node as Element;
  const name = el.name.toLowerCase();
  if (SKIP.has(name)) return;
  if (name === "br") {
    out.push("\n");
    return;
  }
  if (name === "pre") {
    out.push("\n" + rawText(el) + "\n");
    return;
  }
  const block = BLOCK.has(name);
  if (block) out.push("\n");
  if (name === "li") out.push("- ");
  if (name === "td" || name === "th") out.push(" ");
  for (const c of el.children) walk(c as AnyNode, out);
  if (name === "a") {
    const href = el.attribs?.href ?? "";
    const text = rawText(el).trim();
    if (/^(https?:|mailto:)/i.test(href) && !text.includes(href.replace(/^mailto:/i, ""))) out.push(` (${href})`);
  }
  if (block && name !== "li") out.push(name === "p" ? "\n\n" : "\n");
}

/** textContent without re-parenting the node (cheerio.load(node) would move it out of its tree). */
function rawText(node: AnyNode): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  const kids = (node as Element).children;
  return kids ? kids.map((c) => rawText(c as AnyNode)).join("") : "";
}
