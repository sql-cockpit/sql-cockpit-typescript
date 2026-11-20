export {
  SqlCockpit,
  DEFAULT_PORTAL_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type SqlCockpitOptions,
  type AccountResource,
  type TenantsResource,
  type TeamResource,
  type AgentsResource,
  type InstancesResource,
  type SupportResource,
} from './client.js';
export {
  SqlCockpitError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ServerError,
  ConnectionError,
  TimeoutError,
} from './errors.js';
export { MAX_RESPONSE_BYTES, MAX_RETRY_DELAY_MS, type FetchLike, type HttpMethod } from './http.js';
export type * from './types.js';
export { VERSION } from './version.js';
