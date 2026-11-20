// Types for the SQL Cockpit portal API v1. They follow the schemas in the OpenAPI document
// (portal-v1.json). Field names are kept exactly as the API sends them (snake_case).

/** Every role a tenant member can hold. */
export type Role = 'owner' | 'admin' | 'developer' | 'operator' | 'read-only';

/** The roles you can give someone. The owner role cannot be assigned. */
export type AssignableRole = 'admin' | 'developer' | 'operator' | 'read-only';

export type AgentStatus = 'pending' | 'active' | 'revoked' | 'suspended';

export type TicketStatus = 'open' | 'pending' | 'sent' | 'waiting_on_customer' | 'resolved' | 'closed';

/** The error codes the portal API returns in `error.code`. */
export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error'
  | 'bad_request';

/** Per-field validation messages, keyed by field name. */
export type FieldErrors = Record<string, string[]>;

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: FieldErrors;
  };
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

// Account

export interface AccountPlan {
  name: string;
  description: string | null;
}

export interface AccountSubscription {
  status: string;
  cycle: 'month' | 'year';
  started_at: string | null;
  trial_ends_at: string | null;
  ends_at: string | null;
}

export interface ConnectedVia {
  type: 'api_key' | 'oauth';
  name: string;
  scopes: string[];
  expires_at: string | null;
}

export interface Account {
  name: string;
  email: string;
  email_verified: boolean;
  billing_account: boolean;
  team_member: boolean;
  plan: AccountPlan | null;
  subscription: AccountSubscription | null;
  connected_via: ConnectedVia;
  api_key_name: string | null;
  portal_url: string;
  billing_note: string;
}

export interface Allowance {
  key: string;
  label: string;
  metered: boolean;
  used: number;
  limit: number | null;
  unlimited: boolean;
  included: boolean;
  remaining: number | null;
  at_limit: boolean;
}

export interface UsagePeriod {
  start: string;
  end: string;
}

export interface Usage {
  billing_account: boolean;
  team_member_only?: boolean;
  message?: string;
  plan: string | null;
  period: UsagePeriod | null;
  allowances: Allowance[];
}

// Tenants and team

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  subdomain: string | null;
  domain: string | null;
  status: string;
  your_role: Role;
  is_owner: boolean;
  abilities: string[];
  agents_count: number;
  created_at: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  role_label: string;
  status: 'active' | 'pending_password';
  joined_at: string | null;
  added_at: string;
}

export interface Team {
  tenant: { id: string; name: string };
  owner: { name: string; email: string };
  members: Member[];
  you_can_manage: boolean;
  /** The roles you may assign, or null when you cannot manage the team. */
  assignable_roles: AssignableRole[] | null;
  role_summaries: Record<string, string>;
  /** Seats used and included, or null when you cannot manage the team. */
  seats: { used: number; limit: number | null } | null;
}

export interface AddTeamMemberParams {
  /** 2 to 120 characters. */
  name: string;
  /** Up to 254 characters. */
  email: string;
  role: AssignableRole;
}

export interface ChangeRoleParams {
  role: AssignableRole;
}

/** The request body sent by `team.add`. */
export interface AddTeamMemberRequest {
  name: string;
  email: string;
  role: AssignableRole;
}

/** The request body sent by `team.changeRole`. */
export interface ChangeRoleRequest {
  role: AssignableRole;
  confirm: true;
}

/** The request body sent by `team.remove`. */
export interface ConfirmRequest {
  confirm: true;
}

/** What `team.add` and `team.changeRole` return. */
export interface MemberResult {
  member: Member;
  message: string;
}

/** What `team.remove` returns. */
export interface RemovedResult {
  removed: true;
  email: string;
  tenant_id: string;
}

/** What `team.resendInvite` returns. */
export interface SentResult {
  sent: true;
  email: string;
}

// Agents and instances

export interface AgentCommand {
  type: string;
  status: string;
  created_at: string;
}

export interface Agent {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  name: string;
  hostname: string | null;
  status: AgentStatus;
  connection: string;
  update_channel: string | null;
  desired_role: string | null;
  last_seen_at: string | null;
  registered_at: string | null;
  revoked_at: string | null;
  latest_command: AgentCommand | null;
}

export interface ListAgentsParams {
  /** Only the Agents of this tenant (a UUID). */
  tenantId?: string;
  /** Only Agents in this status. */
  status?: AgentStatus;
}

export interface Instance {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  hostname: string | null;
  public_url: string | null;
  hosting_mode: string;
  status: string;
  revision: number;
  applied_revision: number | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface ListInstancesParams {
  /** Only the instances of this tenant (a UUID). */
  tenantId?: string;
}

// Support tickets

export interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  status_label: string;
  priority: 'normal' | 'high';
  tenant: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  portal_url: string;
}

export interface TicketReply {
  from: 'you' | 'sql_cockpit_team';
  body: string;
  created_at: string;
}

/**
 * A ticket. `support.get` returns every field. `support.create` returns the summary fields plus
 * `message`, which then holds the portal's confirmation rather than the ticket text.
 */
export interface Ticket extends TicketSummary {
  message?: string;
  agent?: { id: string; name: string; hostname: string | null } | null;
  team_response?: string | null;
  responded_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  replies?: TicketReply[];
}

export interface ListTicketsParams {
  /** Only tickets in this status. */
  status?: TicketStatus;
}

export interface CreateTicketParams {
  /** 4 to 160 characters. */
  subject: string;
  /** 10 to 5000 characters. */
  message: string;
  /** The tenant the ticket is about (a UUID). */
  tenantId?: string;
  /** An Agent of `tenantId` (a UUID). Naming an Agent raises the ticket as high priority. */
  agentId?: string;
}

/** The request body sent by `support.create`. */
export interface CreateTicketRequest {
  subject: string;
  message: string;
  tenant_id?: string;
  agent_id?: string;
}

/** Options every method accepts. */
export interface RequestOptions {
  /** Cancels the request. The promise rejects with the signal's reason. */
  signal?: AbortSignal;
}
