# SQL Cockpit TypeScript SDK

The official TypeScript client for the SQL Cockpit portal API. Use it to read your account, tenants, team, Agents, instances and support tickets, and to manage team members and open tickets from your own code.

It has no runtime dependencies and uses the built-in `fetch`, so it runs on Node.js 18 or later, Deno and Bun. It is not meant for browsers: a portal API key is a secret and should stay on a server.

## Install

There is no npm release yet. Install from GitHub:

```sh
npm install github:sql-cockpit/sql-cockpit-typescript
```

npm builds the package on install with its `prepare` script. Recent npm versions warn that the script is not yet covered by `allowScripts`; run `npm install-scripts approve @sql-cockpit/sdk` to allow it. The package name is `@sql-cockpit/sdk`.

## Your first program

Create an API key in the portal under **Settings > Developer access**, then put it in the environment:

```sh
export SQL_COCKPIT_API_KEY=your-key
```

```ts
import { SqlCockpit } from '@sql-cockpit/sdk';

const client = new SqlCockpit(); // reads SQL_COCKPIT_API_KEY

const account = await client.account.get();
console.log(`Name:  ${account.name}`);
console.log(`Email: ${account.email}`);
console.log(`Plan:  ${account.plan?.name ?? 'no plan'}`);
```

CommonJS works too: `const { SqlCockpit } = require('@sql-cockpit/sdk');`.

## Methods

Every method returns a promise of the response's `data`, already unwrapped. List methods return arrays. Field names are kept as the API sends them (`created_at`, `tenant_id` and so on).

| Method | HTTP operation | Returns |
| --- | --- | --- |
| `client.account.get()` | `GET /account` | `Account` |
| `client.account.usage()` | `GET /usage` | `Usage` |
| `client.tenants.list()` | `GET /tenants` | `Tenant[]` |
| `client.team.list(tenantId)` | `GET /tenants/{tenantId}/members` | `Team` (owner, `members`, roles, seats) |
| `client.team.add(tenantId, { name, email, role })` | `POST /tenants/{tenantId}/members` | `MemberResult` |
| `client.team.changeRole(tenantId, membershipId, { role })` | `PATCH /tenants/{tenantId}/members/{membershipId}` | `MemberResult` |
| `client.team.remove(tenantId, membershipId)` | `DELETE /tenants/{tenantId}/members/{membershipId}` | `RemovedResult` |
| `client.team.resendInvite(tenantId, membershipId)` | `POST /tenants/{tenantId}/members/{membershipId}/resend` | `SentResult` |
| `client.agents.list({ tenantId?, status? })` | `GET /agents` | `Agent[]` |
| `client.instances.list({ tenantId? })` | `GET /instances` | `Instance[]` |
| `client.support.list({ status? })` | `GET /support-tickets` | `TicketSummary[]` |
| `client.support.get(ticketId)` | `GET /support-tickets/{ticketId}` | `Ticket` |
| `client.support.create({ subject, message, tenantId?, agentId? })` | `POST /support-tickets` | `Ticket` |

`team.changeRole` and `team.remove` send `confirm: true` for you. The API asks for it so a change is never made by accident, so only call them when you mean it.

Ids in a path (`tenantId`, `membershipId`, `ticketId`) and the `tenantId` and `agentId` filters must be UUIDs. Anything else is refused with a `ValidationError` before a request is sent.

Plans, billing and deleting anything other than a team membership are not part of the API. Do those in the portal.

## Errors

Every error the SDK throws is a `SqlCockpitError` with:

- `code`: the API's error code, such as `not_found` or `validation_failed`, or one of the SDK's own (`invalid_config`, `invalid_argument`, `unexpected_redirect`, `invalid_response`, `response_too_large`, `connection_error`, `timeout`)
- `status`: the HTTP status, or 0 when no response arrived
- `message`: what went wrong, in plain words
- `fields`: for validation errors, the messages for each field

Catch a subclass to handle one case:

| Class | When |
| --- | --- |
| `AuthenticationError` | 401. The key is missing, wrong, revoked or expired. |
| `PermissionDeniedError` | 403. The key lacks the scope, or your role cannot do this. |
| `NotFoundError` | 404. Not found, or not something your account can reach. |
| `ValidationError` | 400 or 422, or a bad id caught before sending. See `fields`. |
| `RateLimitError` | 429. `retryAfter` is the wait in seconds. |
| `ServerError` | 5xx. |
| `ConnectionError` | The portal could not be reached. |
| `TimeoutError` | No answer within `timeoutMs`. |

```ts
import { NotFoundError, ValidationError } from '@sql-cockpit/sdk';

try {
  await client.team.add(tenantId, { name: 'Sam Lee', email: 'sam@example.com', role: 'developer' });
} catch (error) {
  if (error instanceof ValidationError) console.error(error.fields);
  else if (error instanceof NotFoundError) console.error('No such tenant.');
  else throw error;
}
```

GET requests are retried on 429 and 5xx, up to `maxRetries` times (2 by default). The SDK waits for Retry-After when the portal sends it, but never more than 30 seconds. Writes (POST, PATCH, DELETE) are never retried, so a ticket or invitation is never sent twice.

## Cancellation

Every method takes an optional last argument with a `signal`:

```ts
const tickets = await client.support.list({ status: 'open' }, { signal: AbortSignal.timeout(5000) });
```

When the signal aborts, the promise rejects with the signal's reason (an `AbortError` unless you gave another reason), and any retry wait stops.

## Configuration

```ts
const client = new SqlCockpit({
  apiKey: process.env.SQL_COCKPIT_API_KEY,
  portalUrl: 'https://portal.sql-cockpit.com',
  timeoutMs: 20000,
  maxRetries: 2,
  fetch: globalThis.fetch,
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | `SQL_COCKPIT_API_KEY` | Required. |
| `portalUrl` | `SQL_COCKPIT_PORTAL_URL`, then `https://portal.sql-cockpit.com` | Must use https. http is allowed for `localhost`, `127.0.0.1` and `[::1]`. |
| `timeoutMs` | `20000` | Per attempt. |
| `maxRetries` | `2` | 0 to 2. GET requests only. |
| `fetch` | the global `fetch` | Pass your own for proxies or tests. |

## Safety

- The API key is never stored on a visible property. `JSON.stringify(client)` and `console.log(client)` show only the URL and settings, and the key is removed from any error message that echoes it.
- Redirects are refused, not followed, so the key is never sent to another address.
- Responses over 2 MiB are refused.
- Each request sends `User-Agent: sql-cockpit-typescript/<version>` where the runtime allows it.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT
