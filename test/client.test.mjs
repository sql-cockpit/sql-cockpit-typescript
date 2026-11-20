import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  SqlCockpit,
  SqlCockpitError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ServerError,
  ConnectionError,
  TimeoutError,
  VERSION,
  MAX_RESPONSE_BYTES,
} from '../dist/esm/index.js';

const KEY = 'scp_test_0123456789abcdefghijklmnop';
const BASE = 'https://portal.sql-cockpit.com/api/portal/v1';
const TENANT = '0b6c2f3e-8a4d-4c1e-9f7a-1d2e3f4a5b6c';
const MEMBER = '7e8f9a0b-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const TICKET = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const AGENT = 'c0ffee00-1234-4567-89ab-cdef01234567';

/** A fake fetch that answers from a queue and records every call. */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return typeof next === 'function' ? next(url, init) : next.clone();
  };
  fn.calls = calls;
  return fn;
}

function ok(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } });
}

function fail(status, code, message, extra = {}, headers = {}) {
  return new Response(JSON.stringify({ ok: false, error: { code, message, ...extra } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetch, options = {}) {
  return new SqlCockpit({ apiKey: KEY, fetch, ...options });
}

// Operations

const operations = [
  {
    name: 'account.get',
    run: (c) => c.account.get(),
    data: { name: 'Ada', email: 'ada@example.com' },
    expect: { method: 'GET', url: `${BASE}/account` },
    result: (data) => data,
  },
  {
    name: 'account.usage',
    run: (c) => c.account.usage(),
    data: { billing_account: true, plan: 'Team', period: null, allowances: [] },
    expect: { method: 'GET', url: `${BASE}/usage` },
    result: (data) => data,
  },
  {
    name: 'tenants.list',
    run: (c) => c.tenants.list(),
    data: { tenants: [{ id: TENANT, name: 'Acme' }] },
    expect: { method: 'GET', url: `${BASE}/tenants` },
    result: (data) => data.tenants,
  },
  {
    name: 'team.list',
    run: (c) => c.team.list(TENANT),
    data: { tenant: { id: TENANT, name: 'Acme' }, members: [], you_can_manage: true },
    expect: { method: 'GET', url: `${BASE}/tenants/${TENANT}/members` },
    result: (data) => data,
  },
  {
    name: 'team.add',
    run: (c) => c.team.add(TENANT, { name: 'Bo', email: 'bo@example.com', role: 'developer' }),
    data: { member: { id: MEMBER, email: 'bo@example.com' }, message: 'Added.' },
    status: 201,
    expect: { method: 'POST', url: `${BASE}/tenants/${TENANT}/members`, body: { name: 'Bo', email: 'bo@example.com', role: 'developer' } },
    result: (data) => data,
  },
  {
    name: 'team.changeRole',
    run: (c) => c.team.changeRole(TENANT, MEMBER, { role: 'admin' }),
    data: { member: { id: MEMBER, role: 'admin' }, message: 'Updated.' },
    expect: { method: 'PATCH', url: `${BASE}/tenants/${TENANT}/members/${MEMBER}`, body: { role: 'admin', confirm: true } },
    result: (data) => data,
  },
  {
    name: 'team.remove',
    run: (c) => c.team.remove(TENANT, MEMBER),
    data: { removed: true, email: 'bo@example.com', tenant_id: TENANT },
    expect: { method: 'DELETE', url: `${BASE}/tenants/${TENANT}/members/${MEMBER}`, body: { confirm: true } },
    result: (data) => data,
  },
  {
    name: 'team.resendInvite',
    run: (c) => c.team.resendInvite(TENANT, MEMBER),
    data: { sent: true, email: 'bo@example.com' },
    expect: { method: 'POST', url: `${BASE}/tenants/${TENANT}/members/${MEMBER}/resend` },
    result: (data) => data,
  },
  {
    name: 'agents.list (no filters)',
    run: (c) => c.agents.list(),
    data: { agents: [{ id: AGENT }] },
    expect: { method: 'GET', url: `${BASE}/agents` },
    result: (data) => data.agents,
  },
  {
    name: 'agents.list (filters)',
    run: (c) => c.agents.list({ tenantId: TENANT, status: 'active' }),
    data: { agents: [] },
    expect: { method: 'GET', url: `${BASE}/agents?tenant_id=${TENANT}&status=active` },
    result: (data) => data.agents,
  },
  {
    name: 'instances.list',
    run: (c) => c.instances.list({ tenantId: TENANT }),
    data: { instances: [{ id: TENANT, revision: 3 }] },
    expect: { method: 'GET', url: `${BASE}/instances?tenant_id=${TENANT}` },
    result: (data) => data.instances,
  },
  {
    name: 'support.list',
    run: (c) => c.support.list({ status: 'open' }),
    data: { tickets: [{ id: TICKET }] },
    expect: { method: 'GET', url: `${BASE}/support-tickets?status=open` },
    result: (data) => data.tickets,
  },
  {
    name: 'support.get',
    run: (c) => c.support.get(TICKET),
    data: { ticket: { id: TICKET, replies: [] } },
    expect: { method: 'GET', url: `${BASE}/support-tickets/${TICKET}` },
    result: (data) => data.ticket,
  },
  {
    name: 'support.create',
    run: (c) => c.support.create({ subject: 'Agent offline', message: 'It stopped reporting.', tenantId: TENANT, agentId: AGENT }),
    data: { ticket: { id: TICKET, priority: 'high' } },
    status: 201,
    expect: {
      method: 'POST',
      url: `${BASE}/support-tickets`,
      body: { subject: 'Agent offline', message: 'It stopped reporting.', tenant_id: TENANT, agent_id: AGENT },
    },
    result: (data) => data.ticket,
  },
];

for (const op of operations) {
  test(`${op.name} calls ${op.expect.method} ${op.expect.url.replace(BASE, '')} and unwraps data`, async () => {
    const fetch = fakeFetch(ok(op.data, op.status));
    const result = await op.run(client(fetch));
    assert.deepEqual(result, op.result(op.data));
    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, op.expect.url);
    assert.equal(call.init.method, op.expect.method);
    assert.deepEqual(call.body, op.expect.body);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.equal(call.init.headers['User-Agent'], `sql-cockpit-typescript/${VERSION}`);
    assert.equal(call.init.headers['Content-Type'], op.expect.body === undefined ? undefined : 'application/json');
  });
}

test('list methods return arrays', async () => {
  const c = client(fakeFetch(ok({ tenants: [], agents: [], instances: [], tickets: [] })));
  for (const list of [c.tenants.list(), c.agents.list(), c.instances.list(), c.support.list()]) {
    assert.ok(Array.isArray(await list));
  }
});

test('VERSION matches package.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

// Error mapping

const errorCases = [
  [401, 'unauthenticated', AuthenticationError],
  [403, 'forbidden', PermissionDeniedError],
  [404, 'not_found', NotFoundError],
  [422, 'validation_failed', ValidationError],
  [400, 'bad_request', ValidationError],
  [429, 'rate_limited', RateLimitError],
  [500, 'server_error', ServerError],
  [405, 'method_not_allowed', SqlCockpitError],
];

for (const [status, code, Class] of errorCases) {
  test(`HTTP ${status} becomes ${Class.name}`, async () => {
    const c = client(fakeFetch(fail(status, code, `Failed with ${code}.`)), { maxRetries: 0 });
    const error = await c.account.get().catch((e) => e);
    assert.ok(error instanceof Class, `expected ${Class.name}, got ${error?.constructor?.name}`);
    assert.ok(error instanceof SqlCockpitError);
    assert.equal(error.name, Class.name);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, `Failed with ${code}.`);
  });
}

test('validation errors carry fields', async () => {
  const fields = { email: ['The email is already a member.'], role: ['Pick a role.'] };
  const c = client(fakeFetch(fail(422, 'validation_failed', 'Check the fields.', { fields })));
  const error = await c.team.add(TENANT, { name: 'Bo', email: 'bo@example.com', role: 'admin' }).catch((e) => e);
  assert.ok(error instanceof ValidationError);
  assert.deepEqual(error.fields, fields);
});

test('429 exposes retryAfter in seconds', async () => {
  const c = client(fakeFetch(fail(429, 'rate_limited', 'Slow down.', {}, { 'retry-after': '17' })), { maxRetries: 0 });
  const error = await c.account.get().catch((e) => e);
  assert.ok(error instanceof RateLimitError);
  assert.equal(error.retryAfter, 17);
});

test('a non-JSON 502 from a proxy becomes ServerError', async () => {
  const c = client(fakeFetch(new Response('<html>Bad gateway</html>', { status: 502 })), { maxRetries: 0 });
  const error = await c.account.get().catch((e) => e);
  assert.ok(error instanceof ServerError);
  assert.equal(error.code, 'server_error');
  assert.equal(error.status, 502);
});

test('a non-JSON 200 is refused as invalid_response', async () => {
  const c = client(fakeFetch(new Response('not json', { status: 200 })));
  const error = await c.account.get().catch((e) => e);
  assert.ok(error instanceof SqlCockpitError);
  assert.equal(error.code, 'invalid_response');
});

test('a network failure becomes ConnectionError', async () => {
  const c = client(async () => {
    throw new TypeError('fetch failed');
  });
  const error = await c.account.get().catch((e) => e);
  assert.ok(error instanceof ConnectionError);
  assert.equal(error.code, 'connection_error');
  assert.equal(error.status, 0);
});

// Retries

test('GET retries 429 honouring Retry-After, then succeeds', async () => {
  const fetch = fakeFetch(fail(429, 'rate_limited', 'Slow down.', {}, { 'retry-after': '0' }), ok({ name: 'Ada' }));
  const account = await client(fetch).account.get();
  assert.equal(account.name, 'Ada');
  assert.equal(fetch.calls.length, 2);
});

test('GET retries 5xx at most twice', async () => {
  const fetch = fakeFetch(fail(503, 'server_error', 'Down.'));
  const error = await client(fetch).tenants.list().catch((e) => e);
  assert.ok(error instanceof ServerError);
  assert.equal(fetch.calls.length, 3);
});

test('maxRetries: 0 turns retries off', async () => {
  const fetch = fakeFetch(fail(500, 'server_error', 'Down.'));
  await assert.rejects(client(fetch, { maxRetries: 0 }).account.get(), ServerError);
  assert.equal(fetch.calls.length, 1);
});

test('writes are never retried', async () => {
  for (const run of [
    (c) => c.team.add(TENANT, { name: 'Bo', email: 'bo@example.com', role: 'admin' }),
    (c) => c.team.changeRole(TENANT, MEMBER, { role: 'admin' }),
    (c) => c.team.remove(TENANT, MEMBER),
    (c) => c.team.resendInvite(TENANT, MEMBER),
    (c) => c.support.create({ subject: 'Help', message: 'Something broke here.' }),
  ]) {
    const fetch = fakeFetch(fail(503, 'server_error', 'Down.'), fail(429, 'rate_limited', 'Slow.', {}, { 'retry-after': '0' }));
    await assert.rejects(run(client(fetch)), ServerError);
    assert.equal(fetch.calls.length, 1);
  }
});

test('4xx other than 429 is not retried', async () => {
  const fetch = fakeFetch(fail(404, 'not_found', 'Nope.'));
  await assert.rejects(client(fetch).support.get(TICKET), NotFoundError);
  assert.equal(fetch.calls.length, 1);
});

test('maxRetries above 2 is refused', () => {
  assert.throws(() => client(fakeFetch(ok({})), { maxRetries: 3 }), (e) => e.code === 'invalid_config');
});

// Redirects and response size

test('a redirect is refused and not followed', async () => {
  const fetch = fakeFetch(new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }));
  const error = await client(fetch).account.get().catch((e) => e);
  assert.ok(error instanceof SqlCockpitError);
  assert.equal(error.code, 'unexpected_redirect');
  assert.equal(error.status, 302);
  assert.equal(fetch.calls.length, 1);
});

test('a response declaring more than 2 MiB is refused', async () => {
  const fetch = fakeFetch(() => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }));
  const error = await client(fetch).account.get().catch((e) => e);
  assert.equal(error.code, 'response_too_large');
});

test('a streamed response over 2 MiB is cut off', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  const fetch = fakeFetch(() => {
    const body = new ReadableStream({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200 });
  });
  const error = await client(fetch).account.get().catch((e) => e);
  assert.equal(error.code, 'response_too_large');
  assert.ok(pulled <= MAX_RESPONSE_BYTES + 2 * chunk.byteLength, 'stopped reading soon after the cap');
});

test('a response just under 2 MiB is read', async () => {
  const padding = ' '.repeat(MAX_RESPONSE_BYTES - 200);
  const fetch = fakeFetch(() => new Response(`{"ok":true,"data":{"name":"Ada"}}${padding}`, { status: 200 }));
  const account = await client(fetch).account.get();
  assert.equal(account.name, 'Ada');
});

// Id validation

test('path ids must be UUIDs and nothing is sent otherwise', async () => {
  const fetch = fakeFetch(ok({}));
  const c = client(fetch);
  const bad = ['', 'abc', '../account', `${TENANT}/../x`, '00000000-0000-0000-0000-00000000000g'];
  for (const id of bad) {
    for (const run of [
      () => c.team.list(id),
      () => c.team.add(id, { name: 'Bo', email: 'bo@example.com', role: 'admin' }),
      () => c.team.changeRole(TENANT, id, { role: 'admin' }),
      () => c.team.remove(id, MEMBER),
      () => c.team.resendInvite(TENANT, id),
      () => c.support.get(id),
    ]) {
      const error = await run().catch((e) => e);
      assert.ok(error instanceof ValidationError, `refused ${JSON.stringify(id)}`);
      assert.equal(error.code, 'invalid_argument');
      assert.equal(error.status, 0);
    }
  }
  for (const run of [
    () => c.agents.list({ tenantId: 'nope' }),
    () => c.instances.list({ tenantId: 'nope' }),
    () => c.support.create({ subject: 'Help', message: 'Something broke here.', agentId: 'nope' }),
  ]) {
    const error = await run().catch((e) => e);
    assert.ok(error instanceof ValidationError);
    assert.ok(error.fields);
  }
  assert.equal(fetch.calls.length, 0);
});

test('method calls validate ids asynchronously (they reject, never throw)', () => {
  const c = client(fakeFetch(ok({})));
  const promise = c.team.list('bad');
  assert.ok(promise instanceof Promise);
  return assert.rejects(promise, ValidationError);
});

// Key safety

test('the API key never appears in JSON.stringify, inspect, keys or console output', () => {
  const c = client(fakeFetch(ok({})));
  assert.ok(!JSON.stringify(c).includes(KEY));
  assert.ok(!inspect(c, { showHidden: true, depth: Infinity, getters: true }).includes(KEY));
  assert.ok(!Object.keys(c).includes('apiKey'));
  assert.ok(!Object.getOwnPropertyNames(c).some((name) => String(c[name]).includes(KEY)));
  assert.ok(!Reflect.ownKeys(c).some((k) => {
    const v = c[k];
    return typeof v === 'string' && v.includes(KEY);
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { portalUrl: 'https://portal.sql-cockpit.com', timeoutMs: 20000, maxRetries: 2 });
});

test('the API key is redacted from errors that echo it', async () => {
  const fetch = fakeFetch(fail(401, 'unauthenticated', `Key ${KEY} was revoked.`, { fields: { key: [`${KEY} is bad`] } }));
  const error = await client(fetch).account.get().catch((e) => e);
  assert.ok(error instanceof AuthenticationError);
  assert.ok(!error.message.includes(KEY));
  assert.ok(error.message.includes('[redacted]'));
  assert.ok(!JSON.stringify(error).includes(KEY));
  assert.ok(!inspect(error, { showHidden: true, depth: Infinity }).includes(KEY));
  assert.ok(!String(error.stack).includes(KEY));
});

test('the API key is not in errors for any failure type', async () => {
  const cases = [
    fakeFetch(fail(500, 'server_error', 'Down.')),
    fakeFetch(new Response(null, { status: 307, headers: { location: 'http://x' } })),
    async () => {
      throw new TypeError('fetch failed');
    },
  ];
  for (const fetch of cases) {
    const error = await client(fetch, { maxRetries: 0 }).account.get().catch((e) => e);
    assert.ok(error instanceof SqlCockpitError);
    assert.ok(!inspect(error, { showHidden: true, depth: Infinity }).includes(KEY));
  }
  const config = (() => {
    try {
      new SqlCockpit({ apiKey: `${KEY} with spaces`, fetch: fakeFetch(ok({})) });
    } catch (e) {
      return e;
    }
  })();
  assert.equal(config.code, 'invalid_config');
  assert.ok(!inspect(config).includes(KEY));
});

// Timeouts and cancellation

const hang = (url, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError')));
  });

test('a slow portal gives TimeoutError', async () => {
  const error = await client(hang, { timeoutMs: 30 }).account.get().catch((e) => e);
  assert.ok(error instanceof TimeoutError);
  assert.equal(error.code, 'timeout');
});

test('aborting a signal rejects with the signal reason', async () => {
  const controller = new AbortController();
  const promise = client(hang).account.get({ signal: controller.signal });
  controller.abort();
  const error = await promise.catch((e) => e);
  assert.equal(error.name, 'AbortError');
  assert.ok(!(error instanceof SqlCockpitError));
});

test('an already-aborted signal sends nothing', async () => {
  const fetch = fakeFetch(ok({}));
  const reason = new Error('stop');
  await assert.rejects(client(fetch).tenants.list({ signal: AbortSignal.abort(reason) }), (e) => e === reason);
  assert.equal(fetch.calls.length, 0);
});

test('aborting during a retry wait stops the retries', async () => {
  const controller = new AbortController();
  const fetch = fakeFetch(fail(429, 'rate_limited', 'Slow.', {}, { 'retry-after': '20' }));
  const promise = client(fetch).account.get({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const error = await promise.catch((e) => e);
  assert.equal(error.name, 'AbortError');
  assert.equal(fetch.calls.length, 1);
});

test('every method passes the signal on', async () => {
  const fetch = fakeFetch(ok({ tenants: [], agents: [], instances: [], tickets: [], ticket: {} }));
  const c = client(fetch);
  const { signal } = new AbortController();
  await c.account.get({ signal });
  await c.account.usage({ signal });
  await c.tenants.list({ signal });
  await c.team.list(TENANT, { signal });
  await c.team.add(TENANT, { name: 'Bo', email: 'bo@example.com', role: 'admin' }, { signal });
  await c.team.changeRole(TENANT, MEMBER, { role: 'admin' }, { signal });
  await c.team.remove(TENANT, MEMBER, { signal });
  await c.team.resendInvite(TENANT, MEMBER, { signal });
  await c.agents.list({}, { signal });
  await c.instances.list({}, { signal });
  await c.support.list({}, { signal });
  await c.support.get(TICKET, { signal });
  await c.support.create({ subject: 'Help', message: 'Something broke here.' }, { signal });
  assert.equal(fetch.calls.length, 13);
  for (const call of fetch.calls) assert.ok(call.init.signal instanceof AbortSignal);
});

// Configuration

test('portalUrl must be https, except on loopback hosts', () => {
  const fetch = fakeFetch(ok({}));
  assert.throws(() => client(fetch, { portalUrl: 'http://portal.sql-cockpit.com' }), (e) => e.code === 'invalid_config');
  assert.throws(() => client(fetch, { portalUrl: 'ftp://localhost' }), (e) => e.code === 'invalid_config');
  assert.throws(() => client(fetch, { portalUrl: 'https://user:pw@portal.sql-cockpit.com' }), (e) => e.code === 'invalid_config');
  assert.throws(() => client(fetch, { portalUrl: 'https://portal.sql-cockpit.com/?x=1' }), (e) => e.code === 'invalid_config');
  assert.throws(() => client(fetch, { portalUrl: 'not a url' }), (e) => e.code === 'invalid_config');
  for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000']) {
    assert.equal(client(fetch, { portalUrl: url }).portalUrl, url);
  }
  assert.equal(client(fetch, { portalUrl: 'https://portal.example.com/' }).portalUrl, 'https://portal.example.com');
  assert.equal(client(fetch, { portalUrl: 'https://portal.example.com/api/portal/v1' }).portalUrl, 'https://portal.example.com');
});

test('a custom portalUrl is used for calls', async () => {
  const fetch = fakeFetch(ok({ tenants: [] }));
  await client(fetch, { portalUrl: 'http://localhost:8000' }).tenants.list();
  assert.equal(fetch.calls[0].url, 'http://localhost:8000/api/portal/v1/tenants');
});

test('defaults come from SQL_COCKPIT_API_KEY and SQL_COCKPIT_PORTAL_URL', async () => {
  const saved = { key: process.env.SQL_COCKPIT_API_KEY, url: process.env.SQL_COCKPIT_PORTAL_URL };
  try {
    process.env.SQL_COCKPIT_API_KEY = KEY;
    process.env.SQL_COCKPIT_PORTAL_URL = 'http://127.0.0.1:9000';
    const fetch = fakeFetch(ok({ name: 'Ada' }));
    const c = new SqlCockpit({ fetch });
    await c.account.get();
    assert.equal(fetch.calls[0].url, 'http://127.0.0.1:9000/api/portal/v1/account');
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${KEY}`);

    delete process.env.SQL_COCKPIT_API_KEY;
    delete process.env.SQL_COCKPIT_PORTAL_URL;
    assert.throws(() => new SqlCockpit({ fetch }), (e) => e.code === 'invalid_config' && /SQL_COCKPIT_API_KEY/.test(e.message));
    assert.equal(new SqlCockpit({ apiKey: KEY, fetch }).portalUrl, 'https://portal.sql-cockpit.com');
  } finally {
    for (const [name, value] of [['SQL_COCKPIT_API_KEY', saved.key], ['SQL_COCKPIT_PORTAL_URL', saved.url]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('timeoutMs must be a positive whole number', () => {
  assert.throws(() => client(fakeFetch(ok({})), { timeoutMs: 0 }), (e) => e.code === 'invalid_config');
  assert.throws(() => client(fakeFetch(ok({})), { timeoutMs: 1.5 }), (e) => e.code === 'invalid_config');
});

test('uses the global fetch when none is given', async () => {
  const original = globalThis.fetch;
  const fetch = fakeFetch(ok({ name: 'Ada' }));
  globalThis.fetch = fetch;
  try {
    const account = await new SqlCockpit({ apiKey: KEY }).account.get();
    assert.equal(account.name, 'Ada');
    assert.equal(fetch.calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
