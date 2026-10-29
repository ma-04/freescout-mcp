import { redact } from "./log.js";

export const AUTH_ERROR_MESSAGE =
  "FreeScout session expired or invalid. Paste a fresh cookie (FREESCOUT_COOKIE) or set FREESCOUT_USER/FREESCOUT_PASSWORD to enable auto login.";

export type AuthErrorReason = "logged_out" | "login_failed" | "no_credentials";

/** The FreeScout session is not (or no longer) authenticated. */
export class AuthError extends Error {
  readonly reason: AuthErrorReason;
  constructor(reason: AuthErrorReason = "logged_out", message: string = AUTH_ERROR_MESSAGE) {
    super(redact(message));
    this.name = "AuthError";
    this.reason = reason;
  }
}

/** Any other non-success answer from FreeScout. Message is always redacted. */
export class FreeScoutError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(redact(message));
    this.name = "FreeScoutError";
    this.status = status;
  }
}

/** Authenticated, but this user is not allowed to see/do the thing (HTTP 403). */
export class PermissionError extends FreeScoutError {
  constructor(message: string) {
    super(message, 403);
    this.name = "PermissionError";
  }
}
