import type { FreeScoutClient } from "../client.js";

export interface ToolContext {
  client: FreeScoutClient;
  /**
   * Parsed FREESCOUT_FORWARD_ALLOW from the server's own environment (never from a request). forward_conversation is
   * registered only when this is non-empty, and every recipient must match it.
   */
  forwardAllow: readonly string[];
  /** FREESCOUT_STATS_DELAY_MS from the server environment: pause between consecutive ticket_volume and agent_stats requests (default 200). */
  statsDelayMs?: number;
}
