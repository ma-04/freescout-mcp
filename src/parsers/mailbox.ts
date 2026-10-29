import type { CheerioAPI } from "cheerio";
import { intOrNull, squish, textOrNull } from "./text.js";

export type FolderType = "unassigned" | "mine" | "starred" | "drafts" | "assigned" | "closed" | "spam" | "deleted";
export const FOLDER_TYPES: readonly FolderType[] = ["unassigned", "mine", "starred", "drafts", "assigned", "closed", "spam", "deleted"];

/** Folder::$type_icons in FreeScout (app/Folder.php); the sidebar <li> carries the icon name as its class. */
const ICON_TO_TYPE: Record<string, FolderType> = {
  "folder-open": "unassigned",
  "hand-right": "mine",
  star: "starred",
  duplicate: "drafts",
  user: "assigned",
  lock: "closed",
  "ban-circle": "spam",
  trash: "deleted",
};

export function folderTypeFromName(name: string): FolderType | null {
  const n = name.trim().toLowerCase();
  return (FOLDER_TYPES as readonly string[]).includes(n) ? (n as FolderType) : null;
}

export interface FolderInfo {
  id: number;
  name: string;
  type: FolderType | null;
  /** Active conversations count as FreeScout shows it (sidebar data-active-count or dashboard number). */
  active_count: number | null;
  url: string;
}

export interface MailboxSummary {
  id: number;
  name: string;
  email: string | null;
  url: string;
  folders: FolderInfo[];
}

function abs(href: string | undefined, base: string): string {
  return href ? new URL(href, base).toString() : "";
}

/** Dashboard (`GET /`): one `.dash-card[data-mailbox-id]` per mailbox the user can view. */
export function parseDashboard($: CheerioAPI, base: string): MailboxSummary[] {
  const out: MailboxSummary[] = [];
  $(".dash-card[data-mailbox-id]").each((_, el) => {
    const card = $(el);
    const id = intOrNull(card.attr("data-mailbox-id"));
    if (id === null) return;
    const nameA = card.find("a.mailbox-name").first();
    const folders: FolderInfo[] = [];
    card.find(".dash-card-list a.dash-card-list-item").each((_, a) => {
      const link = $(a);
      const href = link.attr("href") ?? "";
      const m = /\/mailbox\/(\d+)\/(\d+)/.exec(href);
      if (!m) return;
      const clone = link.clone();
      clone.find("strong, .waiting-since").remove();
      const name = squish(clone.text());
      folders.push({
        id: Number(m[2]),
        name,
        type: folderTypeFromName(name),
        active_count: intOrNull(link.find("strong").first().text()),
        url: abs(href, base),
      });
    });
    out.push({
      id,
      name: squish(nameA.text()),
      email: textOrNull(card.find(".dash-card-link a").first().text()),
      url: abs(nameA.attr("href") ?? `/mailbox/${id}`, base),
      folders,
    });
  });
  return out;
}

export interface MailboxSidebar {
  mailbox_id: number | null;
  name: string | null;
  email: string | null;
  folders: (FolderInfo & { current: boolean })[];
  current_folder_id: number | null;
}

/** Folder sidebar on `/mailbox/{id}[/{folder_id}]` and conversation pages: `ul#folders > li[data-folder_id]`. */
export function parseMailboxSidebar($: CheerioAPI, base: string): MailboxSidebar {
  const folders: MailboxSidebar["folders"] = [];
  let mailboxId: number | null = null;
  $("ul#folders > li[data-folder_id]").each((_, el) => {
    const li = $(el);
    const id = intOrNull(li.attr("data-folder_id"));
    if (id === null) return;
    const href = li.find("a").first().attr("href") ?? "";
    const m = /\/mailbox\/(\d+)\//.exec(href);
    if (m && mailboxId === null) mailboxId = Number(m[1]);
    const classes = (li.attr("class") ?? "").split(/\s+/).filter(Boolean);
    const name = squish(li.find(".folder-name").first().text());
    const iconType = classes.map((c) => ICON_TO_TYPE[c]).find(Boolean) ?? null;
    folders.push({
      id,
      name,
      type: iconType ?? folderTypeFromName(name),
      active_count: intOrNull(li.attr("data-active-count")),
      url: abs(href, base),
      current: classes.includes("active"),
    });
  });
  const bodyMailbox = intOrNull($("body").attr("data-mailbox_id")) ?? intOrNull($("#conv-list-col").attr("data-mailbox_id"));
  return {
    mailbox_id: mailboxId ?? bodyMailbox,
    name: textOrNull($(".sidebar-title-real.mailbox-name").first().text()),
    email: textOrNull($(".sidebar-title-email").first().text()),
    folders,
    current_folder_id: folders.find((f) => f.current)?.id ?? null,
  };
}
