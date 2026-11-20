import type { FieldErrors } from './types.js';

/**
 * Base class for every error the SDK throws.
 *
 * `code` is the portal's `error.code` (for example `not_found`) or one of the SDK's own codes:
 * `invalid_config`, `invalid_argument`, `unexpected_redirect`, `invalid_response`,
 * `response_too_large`, `connection_error`, `timeout`.
 * `status` is the HTTP status, or 0 when no response was received.
 */
export class SqlCockpitError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: FieldErrors | undefined;

  constructor(message: string, options: { code: string; status?: number; fields?: FieldErrors; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status ?? 0;
    this.fields = options.fields;
  }
}

/** 401: the API key is missing, invalid, revoked or expired. */
export class AuthenticationError extends SqlCockpitError {}

/** 403: the key lacks the scope, or your role cannot do this. */
export class PermissionDeniedError extends SqlCockpitError {}

/** 404: not found, or not something your account can reach. */
export class NotFoundError extends SqlCockpitError {}

/** 400 or 422 from the portal, or an argument the SDK refused before sending. See `fields`. */
export class ValidationError extends SqlCockpitError {}

/** 429: too many requests. `retryAfter` is the wait in seconds, when the portal sent one. */
export class RateLimitError extends SqlCockpitError {
  readonly retryAfter: number | undefined;

  constructor(message: string, options: { code: string; status?: number; fields?: FieldErrors; retryAfter?: number }) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx: the portal failed. GET requests are retried before this is thrown. */
export class ServerError extends SqlCockpitError {}

/** The portal could not be reached (DNS, TLS, refused connection and so on). */
export class ConnectionError extends SqlCockpitError {}

/** The portal did not answer within `timeoutMs`. */
export class TimeoutError extends SqlCockpitError {}
