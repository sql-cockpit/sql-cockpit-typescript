# Changelog

## 0.1.0 - 2026-11-20

First release.

- `SqlCockpit` client for the portal API v1: account, usage, tenants, team members, Agents, instances and support tickets.
- Types for every request and response, taken from the OpenAPI document.
- Errors by HTTP status: `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ValidationError`, `RateLimitError`, `ServerError`, `ConnectionError`, `TimeoutError`.
- GET requests retry on 429 and 5xx (up to 2 times, honouring Retry-After up to 30 seconds). Writes are never retried.
- https only (http allowed for localhost), redirects refused, responses capped at 2 MiB, the API key kept out of logs and errors.
- ESM and CommonJS builds, no runtime dependencies.
