import type { HttpTransport } from '../src/core/validation.js';
import { string } from '../src/core/validation.js';
import { errorCode } from '../src/core/validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BegetClient } from '../src/providers/beget.js';

function makeClient(transport: HttpTransport) {
  return new BegetClient({
    username: 'api-login',
    password: 'special&secret=1',
    allowedNames: ['_acme-challenge.example.com'],
    transport,
  });
}

test('Beget uses form POST, no credentials in URL, exact TXT payload', async () => {
  let request: { url: string; options: RequestInit } | undefined;
  const client = makeClient(async (url, options) => {
    request = { url, options };

    return Response.json({ status: 'success', answer: { status: 'success', result: true } });
  });
  await client.replaceTXT('_acme-challenge.example.com', ['token-abc123456', 'token-def123456']);
  assert(request);
  assert.equal(request.url, 'https://api.beget.com/api/dns/changeRecords');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert(!request.url.includes('secret'));
  assert(request.options.body instanceof URLSearchParams);
  const form = request.options.body;
  assert.equal(form.get('passwd'), 'special&secret=1');
  assert.deepEqual(JSON.parse(string(form.get('input_data'))) as unknown, {
    fqdn: '_acme-challenge.example.com',
    records: {
      TXT: [
        { priority: 10, value: 'token-abc123456' },
        { priority: 10, value: 'token-def123456' },
      ],
    },
  });
});

test('guard refuses apex and arbitrary DNS names before contacting Beget', async () => {
  const client = makeClient(async () => {
    throw Error('must not call');
  });
  await assert.rejects(client.replaceTXT('example.com', ['token-abc123456']), /not allowed/);
  await assert.rejects(client.replaceTXT('www.example.com', []), /not allowed/);
});

test('getData METHOD_FAILED is a known unreadable-zone outcome, not proof of emptiness', async () => {
  const client = makeClient(async () =>
    Response.json({
      status: 'success',
      answer: {
        status: 'error',
        errors: [{ error_code: 'METHOD_FAILED', error_text: 'Failed to get DNS records' }],
      },
    }),
  );
  assert.deepEqual(await client.describe('_acme-challenge.example.com'), {
    readable: false,
    records: null,
  });
});

test('does not put HTTP response bodies in error messages', async () => {
  const client = makeClient(async () => new Response('', { status: 403 }));
  await assert.rejects(client.replaceTXT('_acme-challenge.example.com', []), (error) => {
    assert.equal(errorCode(error), 'BEGET_HTTP_ERROR');
    assert(error instanceof Error);
    assert(!error.message.includes('secret'));

    return true;
  });
});

test('root flags accept documented numeric values and errors preserve sanitized provider code', async () => {
  for (const flag of [1, true]) {
    const client = makeClient(async () =>
      Response.json({
        status: 'success',
        answer: { status: 'success', result: { is_beget_dns: flag, is_under_control: flag } },
      }),
    );
    assert.equal((await client.assertRootZone('example.com')).is_beget_dns, true);
  }

  const denied = makeClient(async () =>
    Response.json({
      status: 'success',
      answer: { status: 'error', errors: [{ error_code: 'ACCESS_DENIED' }] },
    }),
  );
  await assert.rejects(denied.assertRootZone('example.com'), /ACCESS_DENIED/);
  const falseFlag = makeClient(async () =>
    Response.json({
      status: 'success',
      answer: { status: 'success', result: { is_beget_dns: '1', is_under_control: 0 } },
    }),
  );
  await assert.rejects(falseFlag.assertRootZone('example.com'), { code: 'BEGET_ROOT_NOT_MANAGED' });
});

test('missing record inventory remains unknown; explicit empty inventory is readable', async () => {
  for (const records of [undefined, null, [], {}]) {
    const client = makeClient(async () =>
      Response.json({ status: 'success', answer: { status: 'success', result: { records } } }),
    );
    const description = await client.describe('_acme-challenge.example.com');
    assert.equal(description.readable, records !== undefined && records !== null);
  }

  const invalid = makeClient(async () =>
    Response.json({ status: 'success', answer: { status: 'success', result: { records: [123] } } }),
  );
  await assert.rejects(invalid.describe('_acme-challenge.example.com'), {
    code: 'BEGET_BAD_RESPONSE',
  });
});

test('provider record dictionaries cannot be prototype-mutated by JSON keys', async () => {
  const client = makeClient(
    async () =>
      new Response(
        '{"status":"success","answer":{"status":"success","result":{"records":{"__proto__":[{"value":"unexpected"}]}}}}',
      ),
  );
  const description = await client.describe('_acme-challenge.example.com');
  assert(description.readable);
  assert.equal(Object.getPrototypeOf(description.records), null);
  assert.equal(Object.hasOwn(description.records, '__proto__'), true);
});
