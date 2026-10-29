/**
 * Parse a raw `Cookie:` request-header value (as copied from browser devtools)
 * into name/value pairs. Tolerates a leading "Cookie:" prefix, stray whitespace,
 * newlines, empty segments and quoted values.
 */
export function parseCookieHeader(raw: string | undefined | null): Array<{ name: string; value: string }> {
  if (!raw) return [];
  let s = raw.trim();
  s = s.replace(/^cookie\s*:\s*/i, "");
  const out = new Map<string, string>();
  for (const part of s.split(/;|\r?\n/)) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    let value = seg.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue; // RFC 6265 token
    out.set(name, value); // last one wins, like browsers
  }
  return [...out].map(([name, value]) => ({ name, value }));
}
