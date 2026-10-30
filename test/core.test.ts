import test from 'node:test';
import assert from 'node:assert/strict';
import { BegetClient } from '../src/providers/beget.js';
import { assertEmpty, assertExactTXT } from '../src/dns/verify.js';

// Regression tests exercise the same provider adapter as the CLI.
const client = (transport: (url: string, options: RequestInit) => Promise<Response>) =>
  new BegetClient({
    username: 'test',
    password: 'secret',
    allowedNames: ['_acme-challenge.example.com'],
    transport,
  });

test('Beget sends credentials only in the POST body', async () => {
  const b = client(async (url, options) => {
    assert(!url.includes('secret'));
    assert.equal(options.method, 'POST');
    assert(options.body instanceof URLSearchParams);
    assert.equal(options.body.get('passwd'), 'secret');

    return Response.json({ status: 'success', answer: { status: 'success', result: true } });
  });
  await b.replaceTXT('_acme-challenge.example.com', ['test-foobar12345']);
});

test('root and unrelated names never reach the transport', async () => {
  const b = client(async () => {
    throw Error('must not call');
  });
  await assert.rejects(b.replaceTXT('example.com', ['test-foo12345']), {
    code: 'DNS_NAME_NOT_ALLOWED',
  });
  await assert.rejects(b.replaceTXT('www.example.com', ['test-foo12345']), {
    code: 'DNS_NAME_NOT_ALLOWED',
  });
});

test('METHOD_FAILED is readable as a state, not an empty zone', async () => {
  const b = client(async () =>
    Response.json({
      status: 'success',
      answer: { status: 'error', errors: [{ error_code: 'METHOD_FAILED' }] },
    }),
  );
  assert.deepEqual(await b.describe('_acme-challenge.example.com'), {
    readable: false,
    records: null,
  });
});

test('TXT checks ignore ordering but reject incomplete sets and other records', () => {
  const row = { server: 'ns1', records: { TXT: ['abc', 'def'], A: [], MX: [] } };
  assertExactTXT([row], ['def', 'abc']);
  assert.throws(() => assertExactTXT([row], ['abc']), { code: 'DNS_FOREIGN_TXT' });
  assert.throws(() => assertEmpty([row]), { code: 'DNS_ZONE_NOT_EMPTY' });
  assert.throws(
    () => assertExactTXT([{ server: 'ns2', records: { TXT: ['abc'], A: ['1.2.3.4'] } }], ['abc']),
    { code: 'DNS_FOREIGN_RECORD' },
  );
});
