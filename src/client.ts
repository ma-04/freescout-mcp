import * as cheerio from "cheerio";
import { FreeScoutError, PermissionError } from "./errors.js";
import { Session, type AjaxForm, type SessionHealth } from "./session.js";

export interface HtmlPage {
  $: cheerio.CheerioAPI;
  url: string;
  status: number;
}

export interface WhoAmI {
  id: number | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  /** Role label as shown on the profile page (e.g. "Administrator", "User"). */
  role: string | null;
  isAdmin: boolean;
  profileUrl: string | null;
  baseUrl: string;
}

/** Thin read layer over Session. Page parsers live in src/parsers/, tool operations in src/operations.ts. */
export class FreeScoutClient implements FreeScoutPort {
  constructor(readonly session: Session) {}

  /** Form-encoded ajax POST with CSRF handling (see Session.ajaxPost). Callers must check the envelope. */
  ajaxPost<T = unknown>(path: string, form: Record<string, string | readonly string[]>): Promise<T> {
    return this.session.ajaxPost<T>(path, form satisfies AjaxForm);
  }

  /** FREESCOUT_URL, normalised (path ends in "/"): the base every app path resolves under. */
  get baseUrl(): URL {
    return this.session.baseUrl;
  }

  get health(): SessionHealth {
    return this.session.health;
  }

  /** GET an authenticated HTML page and return a cheerio root. */
  async getHtml(path: string): Promise<HtmlPage> {
    const res = await this.session.request(path);
    if (res.status === 403) throw new PermissionError(`FreeScout denied access to ${new URL(res.url).pathname} (HTTP 403)`);
    if (res.status === 404) throw new FreeScoutError(`FreeScout page not found: ${new URL(res.url).pathname}`, 404);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Session follows same-origin redirects itself, so this is a redirect to another origin
      // (typically http -> https, or a different host name).
      const target = new URL(location, res.url);
      throw new FreeScoutError(
        `FreeScout ${new URL(res.url).pathname} redirected (HTTP ${res.status}) to another origin: ${target.origin}${target.pathname}. ` +
          `This server does not follow cross-origin redirects; set FREESCOUT_URL to ${target.origin}${basePath(this.session.baseUrl)} if that is your FreeScout.`,
        res.status,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new FreeScoutError(`FreeScout ${new URL(res.url).pathname} returned HTTP ${res.status}`, res.status);
    }
    return { $: cheerio.load(res.text), url: res.url, status: res.status };
  }

  /**
   * Logged-in user. The header only shows the first name (span.nav-user) and the
   * user id (body[data-auth_user_id]); full name, email and role come from the
   * user's own profile page (/users/profile/{id}).
   */
  async whoami(): Promise<WhoAmI> {
    const home = await this.getHtml("/");
    const header = parseHeaderUser(home.$, home.url);
    const out: WhoAmI = {
      id: header.id,
      firstName: header.navName,
      lastName: null,
      name: header.navName,
      email: null,
      role: header.isAdmin ? "Administrator" : null,
      isAdmin: header.isAdmin,
      profileUrl: header.profileUrl,
      baseUrl: this.session.baseUrl.toString(),
    };
    if (header.profileUrl) {
      try {
        const prof = await this.getHtml(header.profileUrl);
        Object.assign(out, parseProfile(prof.$), { isAdmin: header.isAdmin });
        // Non-admins' own profile has no role <select>; FreeScout only has two roles.
        if (!out.role) out.role = header.isAdmin ? "Administrator" : "User";
      } catch (e) {
        if (!(e instanceof PermissionError) && !(e instanceof FreeScoutError && e.status === 404)) throw e;
      }
    }
    return out;
  }
}

function basePath(base: URL): string {
  return base.pathname === "/" ? "" : base.pathname;
}

export function parseHeaderUser($: cheerio.CheerioAPI, pageUrl: string) {
  const idAttr = $("body").attr("data-auth_user_id");
  const id = idAttr && /^\d+$/.test(idAttr) ? Number(idAttr) : null;
  const navName = $(".nav-user").first().text().trim() || null;
  const isAdmin = $("body").hasClass("user-is-admin");
  const href = $('a[href*="/users/profile/"]').first().attr("href");
  const profileUrl = href ? new URL(href, pageUrl).toString() : null;
  return { id, navName, isAdmin, profileUrl };
}

export function parseProfile($: cheerio.CheerioAPI) {
  const val = (name: string) => ($(`input[name="${name}"]`).attr("value") ?? "").trim() || null;
  const firstName = val("first_name");
  const lastName = val("last_name");
  const email = val("email");
  const roleOpt = $('select[name="role"] option[selected]').first().text().trim();
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;
  const out: { firstName: string | null; lastName: string | null; name: string | null; email: string | null; role?: string } = {
    firstName,
    lastName,
    name,
    email,
  };
  if (roleOpt) out.role = roleOpt;
  return out;
}

/** The two primitives tool operations need; FreeScoutClient implements it, unit tests stub it. */
export interface FreeScoutPort {
  /** FREESCOUT_URL (path ending in "/"), when known; stubs may omit it (then the base path is "/"). */
  readonly baseUrl?: URL;
  getHtml(path: string): Promise<HtmlPage>;
  /**
   * Array values are sent as repeated `key[]` pairs. Two array-valued keys exist: add_tag's tag_names (pinned by
   * assertTagForm; remove_tag's form has no arrays, assertTagRemoveForm) and forward's to_email, exactly one element (pinned by assertForwardForm).
   */
  ajaxPost<T = unknown>(path: string, form: Record<string, string | readonly string[]>): Promise<T>;
}
