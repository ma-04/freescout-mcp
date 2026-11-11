import type { FreeScoutClient } from "../client.js";
import type { ReplyGate } from "../reply-gate.js";

export interface ToolContext {
  client: FreeScoutClient;
  /**
   * Parsed FREESCOUT_FORWARD_ALLOW from the server's own environment (never from a request). forward_conversation is
   * registered only when this is non-empty, and every recipient must match it.
   */
  forwardAllow: readonly string[];
  /** FREESCOUT_STATS_DELAY_MS from the server environment: pause between consecutive ticket_volume and agent_stats requests (default 200). */
  statsDelayMs?: number;
  /**
   * FREESCOUT_REPLY_ENABLED / FREESCOUT_REPLY_MAILBOXES from the server's own environment (never from a request).
   * send_reply is registered only when `reply.enabled`; absent = disabled.
   */
  reply?: ReplyGate;
  /**
   * FREESCOUT_CREATE_SEND (server environment only), already combined with FREESCOUT_REPLY_ENABLED: create_conversation
   * may send (send=true) only when this is true and `reply.enabled`. Absent = draft-only.
   */
  createSend?: boolean;
}
