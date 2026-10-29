import { FreeScoutError, PermissionError } from "./errors.js";

/** JSON envelope returned by `POST /conversation/ajax` (ConversationsController::ajax). */
export interface AjaxEnvelope {
  status?: string;
  msg?: string;
  [k: string]: unknown;
}

const PERMISSION_MSG = /not enough permissions|unauthori[sz]ed|access denied/i;

/**
 * FreeScout answers ajax errors with HTTP 200 and `{status:"error", msg}`; some actions even say
 * `status:"success"` with a permission `msg` (conversations_pagination). Throw on both.
 */
export function checkAjax<T extends AjaxEnvelope>(res: T | null | undefined, what: string): T {
  if (!res || typeof res !== "object") throw new FreeScoutError(`${what}: FreeScout returned an empty or non-object response`);
  const msg = typeof res.msg === "string" ? res.msg.trim() : "";
  if (msg && PERMISSION_MSG.test(msg)) {
    throw new PermissionError(`${what}: FreeScout said "${msg}"`);
  }
  if (res.status !== "success") {
    throw new FreeScoutError(`${what} failed: ${msg || `FreeScout returned status "${String(res.status ?? "missing")}"`}`);
  }
  return res;
}
