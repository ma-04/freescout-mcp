import * as cheerio from "cheerio";

/** `<meta name="csrf-token" content="...">` from a Laravel page, if present. */
export function extractCsrfMeta(html: string): string | undefined {
  const m =
    /<meta\s+[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i.exec(html);
  return m?.[1];
}

/** The hidden `_token` input of the first form whose action ends in /login. */
export function extractLoginFormToken(html: string): string | undefined {
  const $ = cheerio.load(html);
  const form = loginForm($);
  const v = (form ?? $("form").first()).find('input[name="_token"]').attr("value");
  return v || undefined;
}

function loginForm($: cheerio.CheerioAPI) {
  const forms = $("form").filter((_, el) => {
    const action = ($(el).attr("action") ?? "").split(/[?#]/)[0]!.replace(/\/+$/, "");
    return /(^|\/)login$/i.test(action);
  });
  const f = forms.filter((_, el) => $(el).find('input[name="email"], input[name="password"]').length > 0).first();
  return f.length ? f : undefined;
}

/**
 * True when the HTML is FreeScout's login page (a form posting to .../login
 * with an email or password input). Cheap regex prefilter before parsing.
 */
export function isLoginFormHtml(html: string): boolean {
  if (!/<form/i.test(html) || !/login/i.test(html)) return false;
  if (!/name=["'](email|password)["']/i.test(html)) return false;
  return loginForm(cheerio.load(html)) !== undefined;
}

export function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType && /html/i.test(contentType)) return true;
  return /^\s*<(!doctype|html)/i.test(body);
}
