/**
 * Customer-reply gate (FREESCOUT_REPLY_ENABLED, FREESCOUT_REPLY_MAILBOXES). Pure functions, no I/O.
 *
 * send_reply emails the conversation's customer, so it exists only when the server operator turned it on in the
 * server's own environment. Nothing a tool argument or an HTTP header carries can set or widen this.
 */

export interface ReplyGate {
  /** FREESCOUT_REPLY_ENABLED is exactly `1` or `true`: send_reply is registered. */
  enabled: boolean;
  /** FREESCOUT_REPLY_MAILBOXES: mailbox ids replies are limited to. Empty = every mailbox the account can reply in. */
  mailboxes: number[];
  /** Set when the configuration is inconsistent but harmless (logged at startup). */
  warning?: string;
}

export const REPLY_DISABLED: ReplyGate = Object.freeze({ enabled: false, mailboxes: [] as number[] }) as ReplyGate;

/**
 * Parse the two variables. Unset/empty/`0`/`false` ENABLED = off. Any other value than `1` / `true` (case-insensitive) throws, so a
 * typo such as `yes` or `on` cannot be mistaken for either state. MAILBOXES: comma- and/or space-separated positive
 * integers, de-duplicated; anything else (`*`, `all`, `0`, `-1`, `1.5`, names) throws. MAILBOXES without ENABLED leaves
 * the tool off and returns a warning.
 */
export function parseReplyGate(env: { FREESCOUT_REPLY_ENABLED?: string; FREESCOUT_REPLY_MAILBOXES?: string }): ReplyGate {
  const rawEnabled = (env.FREESCOUT_REPLY_ENABLED ?? "").trim();
  let enabled = false;
  if (rawEnabled && !/^(0|false)$/i.test(rawEnabled)) {
    if (!/^(1|true)$/i.test(rawEnabled)) {
      throw new Error(
        `FREESCOUT_REPLY_ENABLED: invalid value ${JSON.stringify(rawEnabled)}. Set it to 1 (or true) to enable send_reply, ` +
          "or leave it unset/empty to keep it disabled.",
      );
    }
    enabled = true;
  }
  const mailboxes: number[] = [];
  for (const part of (env.FREESCOUT_REPLY_MAILBOXES ?? "").split(/[\s,]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(n)) {
      throw new Error(
        `FREESCOUT_REPLY_MAILBOXES: invalid entry ${JSON.stringify(part)}. Use comma-separated mailbox ids (e.g. 1,3); ` +
          "no names or wildcards. Leave it unset to allow every mailbox the account can reply in.",
      );
    }
    if (!mailboxes.includes(n)) mailboxes.push(n);
  }
  if (!enabled && mailboxes.length) {
    return {
      enabled: false,
      mailboxes,
      warning:
        "FREESCOUT_REPLY_MAILBOXES is set but FREESCOUT_REPLY_ENABLED is not 1/true: send_reply stays disabled. " +
        "Set FREESCOUT_REPLY_ENABLED=1 to enable it.",
    };
  }
  return { enabled, mailboxes };
}

/** True when a reply on `mailboxId` is allowed by the gate (enabled, and the mailbox list is empty or contains it). */
export function replyMailboxAllowed(gate: ReplyGate, mailboxId: number): boolean {
  return gate.enabled && (gate.mailboxes.length === 0 || gate.mailboxes.includes(mailboxId));
}

/** One line for the startup log. */
export function describeReply(gate: ReplyGate): string {
  if (!gate.enabled) return "send_reply disabled (FREESCOUT_REPLY_ENABLED is not set)";
  return gate.mailboxes.length
    ? `send_reply ENABLED: emails customers, limited to mailbox id${gate.mailboxes.length === 1 ? "" : "s"} ${gate.mailboxes.join(", ")}`
    : "send_reply ENABLED: emails customers, in every mailbox this account can reply in (FREESCOUT_REPLY_MAILBOXES not set)";
}
