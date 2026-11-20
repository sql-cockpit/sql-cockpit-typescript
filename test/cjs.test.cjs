const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/cjs/index.js');

test('the CommonJS build loads and exports the client and errors', async () => {
  assert.equal(typeof sdk.SqlCockpit, 'function');
  assert.equal(sdk.VERSION, require('../package.json').version);
  for (const name of [
    'SqlCockpitError', 'AuthenticationError', 'PermissionDeniedError', 'NotFoundError', 'ValidationError',
    'RateLimitError', 'ServerError', 'ConnectionError', 'TimeoutError',
  ]) {
    assert.equal(typeof sdk[name], 'function', name);
  }
  const fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Nope.' } }), { status: 404 });
  const client = new sdk.SqlCockpit({ apiKey: 'scp_test_0123456789abcdefghijklmnop', fetch });
  const error = await client.account.get().catch((e) => e);
  assert.ok(error instanceof sdk.NotFoundError);
  assert.ok(error instanceof sdk.SqlCockpitError);
});

test('package exports resolve for require and import', async () => {
  const required = require('@sql-cockpit/sdk');
  const imported = await import('@sql-cockpit/sdk');
  assert.equal(typeof required.SqlCockpit, 'function');
  assert.equal(typeof imported.SqlCockpit, 'function');
});
