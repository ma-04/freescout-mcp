import type { CheerioAPI } from "cheerio";
import { squish } from "./text.js";

export interface FilterOption {
  id: number;
  name: string;
}

export interface SearchFilterOptions {
  /** Users from `<select name="f[assigned]">` (without the empty option and `-1` Unassigned). Null if the select is absent. */
  assignees: FilterOption[] | null;
  /** Mailboxes from `<select name="f[mailbox]">` (without the empty option). Null if the select is absent. */
  mailboxes: FilterOption[] | null;
}

/**
 * The filter form on FreeScout's search page (docs/freescout-endpoints.md §10.2). The selects are rendered
 * `disabled` while their filter is inactive; the options are still there.
 */
export function parseSearchFilters($: CheerioAPI): SearchFilterOptions {
  return { assignees: options($, "f[assigned]"), mailboxes: options($, "f[mailbox]") };
}

function options($: CheerioAPI, name: string): FilterOption[] | null {
  const select = $(`select[name="${name}"]`).first();
  if (!select.length) return null;
  const out: FilterOption[] = [];
  select.find("option").each((_, el) => {
    const value = ($(el).attr("value") ?? "").trim();
    if (!/^[1-9]\d*$/.test(value)) return; // skips "" and -1 (Unassigned)
    const id = Number(value);
    out.push({ id, name: squish($(el).text()) });
  });
  return out;
}

/**
 * The value FreeScout marked `selected` in `<select name="f[assigned]">`: the assigned filter it actually applied
 * ("-1" = Unassigned, or a user id). Null when the select is absent or nothing (or the empty option) is selected.
 * Users limited to their own conversations get `f[assigned]` forced to themselves server-side (§10.1), and the
 * dropdown then shows their id selected although nothing (or something else) was requested.
 */
export function selectedAssigned($: CheerioAPI): string | null {
  const select = $('select[name="f[assigned]"]').first();
  if (!select.length) return null;
  const opt = select.find("option[selected]").first();
  if (!opt.length) return null;
  const value = (opt.attr("value") ?? "").trim();
  return value === "" ? null : value;
}

/**
 * Filter names the search page offers (`data-filter` on the sidebar filter menu `ul.sidebar-menu` and on the form
 * groups in `#search-filters`, from FreeScout's `search.filters_list`, which modules extend: the Tags module adds
 * "tag"). Other `[data-filter]` elements on the page are ignored. Null when neither container has filter markup.
 * FreeScout silently ignores an `f[...]` key it has no handler for, so a filter sent to an install without its
 * handler returns unfiltered results; callers compare against this list.
 */
export function offeredFilters($: CheerioAPI): string[] | null {
  const names = new Set<string>();
  $("ul.sidebar-menu [data-filter], #search-filters [data-filter]").each((_, el) => {
    const v = squish($(el).attr("data-filter"));
    if (v) names.add(v);
  });
  return names.size ? [...names] : null;
}
