import { SqlCockpitError, ValidationError } from './errors.js';
import { send, type FetchLike, type RequestSpec, type TransportConfig } from './http.js';
import type {
  Account,
  AddTeamMemberParams,
  AddTeamMemberRequest,
  Agent,
  ChangeRoleParams,
  ChangeRoleRequest,
  ConfirmRequest,
  CreateTicketParams,
  CreateTicketRequest,
  Instance,
  ListAgentsParams,
  ListInstancesParams,
  ListTicketsParams,
  MemberResult,
  RemovedResult,
  RequestOptions,
  SentResult,
  Team,
  Tenant,
  Ticket,
  TicketSummary,
  Usage,
} from './types.js';

export const DEFAULT_PORTAL_URL = 'https://portal.sql-cockpit.com';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface SqlCockpitOptions {
  /** A portal API key. Defaults to the SQL_COCKPIT_API_KEY environment variable. */
  apiKey?: string;
  /** The portal's address. Defaults to SQL_COCKPIT_PORTAL_URL, then https://portal.sql-cockpit.com. */
  portalUrl?: string;
  /** How long one attempt may take, in milliseconds. Default 20000. */
  timeoutMs?: number;
  /** How many times a failed GET (429 or 5xx) is retried. Default 2, at most 2. Writes are never retried. */
  maxRetries?: number;
  /** A fetch implementation to use instead of the global one. */
  fetch?: FetchLike;
}

export interface AccountResource {
  /** GET /account */
  get(options?: RequestOptions): Promise<Account>;
  /** GET /usage */
  usage(options?: RequestOptions): Promise<Usage>;
}

export interface TenantsResource {
  /** GET /tenants */
  list(options?: RequestOptions): Promise<Tenant[]>;
}

export interface TeamResource {
  /** GET /tenants/{tenantId}/members. Returns the whole team: owner, members, roles and seats. */
  list(tenantId: string, options?: RequestOptions): Promise<Team>;
  /** POST /tenants/{tenantId}/members */
  add(tenantId: string, params: AddTeamMemberParams, options?: RequestOptions): Promise<MemberResult>;
  /** PATCH /tenants/{tenantId}/members/{membershipId}, sent with confirm: true. */
  changeRole(tenantId: string, membershipId: string, params: ChangeRoleParams, options?: RequestOptions): Promise<MemberResult>;
  /** DELETE /tenants/{tenantId}/members/{membershipId}, sent with confirm: true. */
  remove(tenantId: string, membershipId: string, options?: RequestOptions): Promise<RemovedResult>;
  /** POST /tenants/{tenantId}/members/{membershipId}/resend */
  resendInvite(tenantId: string, membershipId: string, options?: RequestOptions): Promise<SentResult>;
}

export interface AgentsResource {
  /** GET /agents */
  list(params?: ListAgentsParams, options?: RequestOptions): Promise<Agent[]>;
}

export interface InstancesResource {
  /** GET /instances */
  list(params?: ListInstancesParams, options?: RequestOptions): Promise<Instance[]>;
}

export interface SupportResource {
  /** GET /support-tickets */
  list(params?: ListTicketsParams, options?: RequestOptions): Promise<TicketSummary[]>;
  /** GET /support-tickets/{ticketId} */
  get(ticketId: string, options?: RequestOptions): Promise<Ticket>;
  /** POST /support-tickets */
  create(params: CreateTicketParams, options?: RequestOptions): Promise<Ticket>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The transport config (which holds the API key) lives here, not on the instance, so the key can
// never show up in JSON.stringify, util.inspect, console.log or an error report of the client.
const transports = new WeakMap<SqlCockpit, TransportConfig>();

/** The SQL Cockpit portal API client. */
export class SqlCockpit {
  readonly portalUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;

  readonly account: AccountResource;
  readonly tenants: TenantsResource;
  readonly team: TeamResource;
  readonly agents: AgentsResource;
  readonly instances: InstancesResource;
  readonly support: SupportResource;

  constructor(options: SqlCockpitOptions = {}) {
    const portalUrl = normalizePortalUrl(options.portalUrl ?? readEnv('SQL_COCKPIT_PORTAL_URL'));
    const apiKey = normalizeApiKey(options.apiKey ?? readEnv('SQL_COCKPIT_API_KEY'));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw configError('timeoutMs must be a whole number of milliseconds between 1 and 600000.');
    }
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
      throw configError('maxRetries must be 0, 1 or 2.');
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof fetchImpl !== 'function') {
      throw configError('No fetch is available. Use Node.js 18 or later, Deno or Bun, or pass options.fetch.');
    }

    this.portalUrl = portalUrl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    transports.set(this, {
      baseUrl: portalUrl,
      apiKey,
      timeoutMs,
      maxRetries,
      fetch: options.fetch ? fetchImpl : (url, init) => fetchImpl(url, init),
    });

    const call = <T>(spec: RequestSpec): Promise<T> => {
      const config = transports.get(this);
      if (!config) return Promise.reject(configError('This client is not initialised.'));
      return send<T>(config, spec);
    };

    this.account = Object.freeze({
      get: (options?: RequestOptions) => call<Account>({ method: 'GET', path: '/account', signal: options?.signal }),
      usage: (options?: RequestOptions) => call<Usage>({ method: 'GET', path: '/usage', signal: options?.signal }),
    });

    this.tenants = Object.freeze({
      list: async (options?: RequestOptions) =>
        (await call<{ tenants: Tenant[] }>({ method: 'GET', path: '/tenants', signal: options?.signal })).tenants,
    });

    this.team = Object.freeze({
      list: async (tenantId: string, options?: RequestOptions) =>
        call<Team>({ method: 'GET', path: `/tenants/${uuid(tenantId, 'tenantId')}/members`, signal: options?.signal }),
      add: async (tenantId: string, params: AddTeamMemberParams, options?: RequestOptions) => {
        const body: AddTeamMemberRequest = { name: params.name, email: params.email, role: params.role };
        return call<MemberResult>({ method: 'POST', path: `/tenants/${uuid(tenantId, 'tenantId')}/members`, body, signal: options?.signal });
      },
      changeRole: async (tenantId: string, membershipId: string, params: ChangeRoleParams, options?: RequestOptions) => {
        const body: ChangeRoleRequest = { role: params.role, confirm: true };
        return call<MemberResult>({ method: 'PATCH', path: memberPath(tenantId, membershipId), body, signal: options?.signal });
      },
      remove: async (tenantId: string, membershipId: string, options?: RequestOptions) => {
        const body: ConfirmRequest = { confirm: true };
        return call<RemovedResult>({ method: 'DELETE', path: memberPath(tenantId, membershipId), body, signal: options?.signal });
      },
      resendInvite: async (tenantId: string, membershipId: string, options?: RequestOptions) =>
        call<SentResult>({ method: 'POST', path: `${memberPath(tenantId, membershipId)}/resend`, signal: options?.signal }),
    });

    this.agents = Object.freeze({
      list: async (params: ListAgentsParams = {}, options?: RequestOptions) => {
        const query = { tenant_id: optionalUuid(params.tenantId, 'tenantId'), status: params.status };
        return (await call<{ agents: Agent[] }>({ method: 'GET', path: '/agents', query, signal: options?.signal })).agents;
      },
    });

    this.instances = Object.freeze({
      list: async (params: ListInstancesParams = {}, options?: RequestOptions) => {
        const query = { tenant_id: optionalUuid(params.tenantId, 'tenantId') };
        return (await call<{ instances: Instance[] }>({ method: 'GET', path: '/instances', query, signal: options?.signal }))
          .instances;
      },
    });

    this.support = Object.freeze({
      list: async (params: ListTicketsParams = {}, options?: RequestOptions) => {
        const query = { status: params.status };
        return (await call<{ tickets: TicketSummary[] }>({ method: 'GET', path: '/support-tickets', query, signal: options?.signal }))
          .tickets;
      },
      get: async (ticketId: string, options?: RequestOptions) =>
        (await call<{ ticket: Ticket }>({ method: 'GET', path: `/support-tickets/${uuid(ticketId, 'ticketId')}`, signal: options?.signal }))
          .ticket,
      create: async (params: CreateTicketParams, options?: RequestOptions) => {
        const body: CreateTicketRequest = { subject: params.subject, message: params.message };
        const tenantId = optionalUuid(params.tenantId, 'tenantId');
        const agentId = optionalUuid(params.agentId, 'agentId');
        if (tenantId !== undefined) body.tenant_id = tenantId;
        if (agentId !== undefined) body.agent_id = agentId;
        return (await call<{ ticket: Ticket }>({ method: 'POST', path: '/support-tickets', body, signal: options?.signal })).ticket;
      },
    });
  }

  /** What JSON.stringify shows. The API key is never included. */
  toJSON(): { portalUrl: string; timeoutMs: number; maxRetries: number } {
    return { portalUrl: this.portalUrl, timeoutMs: this.timeoutMs, maxRetries: this.maxRetries };
  }

  /** What util.inspect and console.log show in Node.js. The API key is never included. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SqlCockpit ${JSON.stringify(this.toJSON())}`;
  }
}

function memberPath(tenantId: string, membershipId: string): string {
  return `/tenants/${uuid(tenantId, 'tenantId')}/members/${uuid(membershipId, 'membershipId')}`;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${name} must be a UUID.`, {
      code: 'invalid_argument',
      fields: { [name]: ['Must be a UUID.'] },
    });
  }
  return value.toLowerCase();
}

function optionalUuid(value: unknown, name: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : uuid(value, name);
}

/** https only, except http on localhost, 127.0.0.1 and [::1]. No credentials, query or fragment. */
export function normalizePortalUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(String(value || DEFAULT_PORTAL_URL).trim());
  } catch {
    throw configError('portalUrl is not a valid URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configError('portalUrl must not contain credentials, a query string or a fragment.');
  }
  const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw configError('portalUrl must use https:// (http:// is only allowed for localhost).');
  }
  // Accept the API base URL too: https://portal.sql-cockpit.com/api/portal/v1 works like https://portal.sql-cockpit.com.
  return url
    .toString()
    .replace(/\/+$/, '')
    .replace(/\/api\/portal\/v1$/i, '');
}

function normalizeApiKey(value: string | undefined): string {
  const key = String(value ?? '').trim();
  if (!key) {
    throw configError('An API key is required. Pass apiKey or set SQL_COCKPIT_API_KEY. Create a key in the portal under Settings > Developer access.');
  }
  if (key.length < 20 || key.length > 200 || /\s/.test(key)) {
    throw configError('The API key does not look like a SQL Cockpit portal API key.');
  }
  return key;
}

function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const value = env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    // Deno without --allow-env throws on access; treat it as unset.
    return undefined;
  }
}

function configError(message: string): SqlCockpitError {
  return new SqlCockpitError(message, { code: 'invalid_config' });
}
