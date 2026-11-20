import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  SqlCockpitError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import type { FieldErrors } from './types.js';
import { VERSION } from './version.js';

/** Responses larger than this are refused (2 MiB). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The longest the SDK waits before a retry, whatever Retry-After says. */
export const MAX_RETRY_DELAY_MS = 30_000;

/** The `fetch` the SDK calls. Any WHATWG-compatible fetch works. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike;
}

export interface RequestSpec {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

const PATH_PATTERN = /^\/[a-z0-9/_-]*$/i;

/** Sends one API call, retrying GETs on 429 and 5xx, and returns the unwrapped `data`. */
export async function send<T>(config: TransportConfig, spec: RequestSpec): Promise<T> {
  if (!PATH_PATTERN.test(spec.path)) {
    throw new SqlCockpitError('Refusing to call an unexpected portal path.', { code: 'invalid_argument' });
  }
  const url = new URL(`${config.baseUrl}/api/portal/v1${spec.path}`);
  for (const [name, value] of Object.entries(spec.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(name, value);
  }

  const retries = spec.method === 'GET' ? config.maxRetries : 0;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(spec.signal);
    try {
      return await attemptOnce<T>(config, spec, url.toString());
    } catch (error) {
      const retryable = error instanceof RateLimitError || error instanceof ServerError;
      if (!retryable || attempt >= retries) throw error;
      await sleep(retryDelayMs(error, attempt), spec.signal);
    }
  }
}

async function attemptOnce<T>(config: TransportConfig, spec: RequestSpec, url: string): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onAbort = () => controller.abort(spec.signal?.reason);
  spec.signal?.addEventListener('abort', onAbort, { once: true });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    // Browsers drop this header silently; Node, Deno and Bun send it.
    'User-Agent': `sql-cockpit-typescript/${VERSION}`,
  };
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    let response: Response;
    try {
      response = await config.fetch(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error, spec.signal, timedOut, config);
    }

    // With redirect: 'manual' a runtime hands back the 3xx itself, or an opaque redirect response.
    // Never follow it: the Authorization header must not travel to another URL.
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await discard(response);
      throw new SqlCockpitError('The portal answered with a redirect, which the SDK does not follow. Check portalUrl.', {
        code: 'unexpected_redirect',
        status: response.status,
      });
    }

    let text: string;
    try {
      text = await readLimited(response);
    } catch (error) {
      if (error instanceof SqlCockpitError) throw error;
      throw transportError(error, spec.signal, timedOut, config);
    }

    let payload: unknown;
    let parsed = true;
    try {
      payload = JSON.parse(text);
    } catch {
      parsed = false;
    }

    if (response.ok && parsed && isObject(payload) && payload.ok === true) {
      return payload.data as T;
    }
    if (response.ok && !parsed) {
      throw new SqlCockpitError(`The portal returned an unexpected response (HTTP ${response.status}).`, {
        code: 'invalid_response',
        status: response.status,
      });
    }
    throw apiError(response, isObject(payload) ? payload.error : undefined, config.apiKey);
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener('abort', onAbort);
  }
}

function apiError(response: Response, rawError: unknown, apiKey: string): SqlCockpitError {
  const status = response.status;
  const error = isObject(rawError) ? rawError : {};
  const code = typeof error.code === 'string' ? error.code : codeForStatus(status);
  const message = redact(
    typeof error.message === 'string' && error.message ? error.message : `The portal request failed (HTTP ${status}).`,
    apiKey,
  );
  const fields = parseFields(error.fields, apiKey);
  const options = { code, status, ...(fields ? { fields } : {}) };

  if (status === 401) return new AuthenticationError(message, options);
  if (status === 403) return new PermissionDeniedError(message, options);
  if (status === 404) return new NotFoundError(message, options);
  if (status === 400 || status === 422) return new ValidationError(message, options);
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new RateLimitError(message, { ...options, ...(retryAfter === undefined ? {} : { retryAfter }) });
  }
  if (status >= 500) return new ServerError(message, options);
  return new SqlCockpitError(message, options);
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  422: 'validation_failed',
  429: 'rate_limited',
};

function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? 'server_error' : 'invalid_response');
}

function parseFields(value: unknown, apiKey: string): FieldErrors | undefined {
  if (!isObject(value)) return undefined;
  const fields: FieldErrors = {};
  for (const [name, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) {
      fields[name] = messages.filter((m): m is string => typeof m === 'string').map((m) => redact(m, apiKey));
    }
  }
  return fields;
}

function transportError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean, config: TransportConfig): unknown {
  if (signal?.aborted) return signal.reason;
  if (timedOut) {
    return new TimeoutError(`The SQL Cockpit portal did not answer within ${config.timeoutMs} ms.`, { code: 'timeout' });
  }
  // fetch errors describe the network failure; they never include request headers.
  return new ConnectionError('Could not reach the SQL Cockpit portal. Check portalUrl and your connection.', {
    code: 'connection_error',
    cause: error,
  });
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await discard(response);
    throw tooLarge(response.status);
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw tooLarge(response.status);
    return new TextDecoder().decode(buffer);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function tooLarge(status: number): SqlCockpitError {
  return new SqlCockpitError('The portal response was larger than 2 MiB and was not read.', {
    code: 'response_too_large',
    status,
  });
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to clean up.
  }
}

/** Retry-After as whole seconds: either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function retryDelayMs(error: RateLimitError | ServerError, attempt: number): number {
  if (error instanceof RateLimitError && error.retryAfter !== undefined) {
    return Math.min(error.retryAfter * 1000, MAX_RETRY_DELAY_MS);
  }
  const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
  return Math.min(backoff, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function redact(text: string, apiKey: string): string {
  return apiKey && text.includes(apiKey) ? text.split(apiKey).join('[redacted]') : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
