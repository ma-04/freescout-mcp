/**
 * Forward recipient rules (FREESCOUT_FORWARD_ALLOW). Pure functions, no I/O.
 *
 * FreeScout's `Conversation::sanitizeEmails()` parses `Name <email>` / `Name email` (it splits on whitespace) and
 * creates a Customer from the name part, and `MailHelper::sanitizeEmails` splits lists. So a recipient must be one
 * bare, lowercase address: no whitespace, angle brackets, quotes, commas or semicolons.
 */

// Local part: letters, digits and . _ + - only. RFC 5322 also allows ! # $ % & ' * / = ? ^ ` { | } ~, but `%` and `!`
// are legacy source-routing characters some MTAs still honour (victim%evil.example@team.example), so they are refused.
const LOCAL = "[a-z0-9_+-]+(?:\\.[a-z0-9_+-]+)*";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = `${LABEL}(?:\\.${LABEL})+`;

/** Exactly one lowercase address: one `@`, dotted domain, no consecutive/leading/trailing dots. */
export const RECIPIENT_RE = new RegExp(`^${LOCAL}@${DOMAIN}$`);
const DOMAIN_RE = new RegExp(`^${DOMAIN}$`);

export const MAX_RECIPIENT_LENGTH = 254;

/** True when `email` is a single bare lowercase address FreeScout will not reinterpret. */
export function isStrictRecipient(email: unknown): email is string {
  return typeof email === "string" && email.length >= 3 && email.length <= MAX_RECIPIENT_LENGTH && RECIPIENT_RE.test(email);
}

/**
 * `@domain` entries that would let the LLM forward to anyone: public free-mail providers, and bare public suffixes
 * (registries where unrelated people/companies hold addresses). Exact addresses on these domains remain allowed.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "mail.com", "yandex.com", "yandex.ru", "gmx.com",
  "gmx.de", "zoho.com",
]);
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "co.za",
  "co.kr", "com.br", "com.cn", "com.mx", "com.sg", "com.tr", "com.ar", "com.hk",
]);

/**
 * Parse FREESCOUT_FORWARD_ALLOW: entries separated by commas and/or whitespace; each is an exact email
 * (`ops@example.com`) or a domain (`@example.com`, exact domain only, no subdomains). Lowercased, de-duplicated.
 * Throws on any malformed entry so a typo cannot silently widen or disable the list.
 */
export function parseForwardAllow(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    if (!part) continue;
    const entry = part.toLowerCase();
    const ok = !entry.includes("*") && (entry.startsWith("@") ? DOMAIN_RE.test(entry.slice(1)) && entry.length <= MAX_RECIPIENT_LENGTH : isStrictRecipient(entry));
    if (!ok) {
      throw new Error(
        `FREESCOUT_FORWARD_ALLOW: invalid entry ${JSON.stringify(part)}. Use comma-separated exact addresses ` +
          "(ops@example.com) or domains (@example.com); no names, quotes, wildcards or angle brackets.",
      );
    }
    const domain = entry.startsWith("@") ? entry.slice(1) : null;
    if (domain !== null && (FREE_MAIL_DOMAINS.has(domain) || PUBLIC_SUFFIXES.has(domain))) {
      throw new Error(
        `FREESCOUT_FORWARD_ALLOW: refusing domain entry ${JSON.stringify(part)}: ${domain} is a ` +
          `${FREE_MAIL_DOMAINS.has(domain) ? "public free-mail provider" : "public suffix"}, so it would allow forwarding ` +
          `to anyone with an address there. List exact addresses instead (e.g. someone@${domain}).`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Is `email` (already normalised) permitted by the allow-list? Exact address, or exact domain for `@domain`. */
export function recipientAllowed(email: string, allow: readonly string[]): boolean {
  const e = email.trim().toLowerCase();
  if (!isStrictRecipient(e)) return false;
  const domain = e.slice(e.lastIndexOf("@") + 1);
  return allow.some((entry) => (entry.startsWith("@") ? entry.slice(1) === domain : entry === e));
}

/** One line for the startup log. Allow-list entries are configuration, not secrets. */
export function describeForwarding(allow: readonly string[]): string {
  return allow.length
    ? `forward_conversation enabled for ${allow.length} allow-list entr${allow.length === 1 ? "y" : "ies"}: ${allow.join(", ")}`
    : "forward_conversation disabled (FREESCOUT_FORWARD_ALLOW is not set)";
}
