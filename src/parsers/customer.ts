import type { CheerioAPI } from "cheerio";
import { intOrNull, squish, textOrNull } from "./text.js";

export interface CustomerSnippet {
  id: number | null;
  name: string | null;
  email: string | null;
  extra: string | null;
}

/** `.customer-snippet` (customer page sidebar, conversation sidebar). */
export function parseCustomerSnippet($: CheerioAPI): CustomerSnippet | null {
  const s = $(".customer-snippet").first();
  if (!s.length) return null;
  const a = s.find("a.customer-name").first();
  return {
    id: intOrNull(/\/customers\/(\d+)/.exec(a.attr("href") ?? "")?.[1]),
    name: textOrNull(a.text()),
    email: textOrNull(s.find(".customer-email a.contact-main").first().text()),
    extra: textOrNull(s.find(".customer-extra").first().text()),
  };
}

export interface CustomerProfile {
  first_name: string | null;
  last_name: string | null;
  emails: string[];
  phones: string[];
  company: string | null;
  job_title: string | null;
  websites: string[];
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  notes: string | null;
}

/** Edit form on `GET /customers/{id}/edit` (read only; we never post it). */
export function parseCustomerEdit($: CheerioAPI): CustomerProfile {
  const form = $("form").filter((_, f) => $(f).find('input[name="first_name"]').length > 0).first();
  const val = (name: string) => textOrNull(form.find(`input[name="${name}"]`).attr("value"));
  const all = (sel: string) =>
    form
      .find(sel)
      .toArray()
      .map((i) => squish($(i).attr("value")))
      .filter(Boolean);
  const countrySel = form.find('select[name="country"] option[selected]').first();
  return {
    first_name: val("first_name"),
    last_name: val("last_name"),
    emails: all('input[name="emails[]"]'),
    phones: all('input[name^="phones["][name$="[value]"]'),
    company: val("company"),
    job_title: val("job_title"),
    websites: all('input[name="websites[]"]'),
    address: val("address"),
    city: val("city"),
    state: val("state"),
    zip: val("zip"),
    country: countrySel.length && countrySel.attr("value") ? squish(countrySel.text()) : null,
    notes: textOrNull(form.find('textarea[name="notes"]').text()),
  };
}

export interface CustomerSearchHit {
  id: number;
  name: string | null;
  email: string | null;
}

/** `GET /search?q=…&mode=customers` cards (`.table-customers a.card[href*=/customers/{id}/edit]`). */
export function parseCustomerSearch($: CheerioAPI): CustomerSearchHit[] {
  const out: CustomerSearchHit[] = [];
  $(".table-customers a[href*='/customers/']").each((_, el) => {
    const a = $(el);
    const id = intOrNull(/\/customers\/(\d+)/.exec(a.attr("href") ?? "")?.[1]);
    if (id === null || out.some((h) => h.id === id)) return;
    out.push({
      id,
      name: textOrNull(a.find("h4").first().text()) ?? textOrNull(a.attr("title")),
      email: textOrNull(a.find("p small").first().text()),
    });
  });
  return out;
}
