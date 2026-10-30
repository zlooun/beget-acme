import type { DnsRecords } from '../src/dns/verify.js';
import { errorCode } from '../src/core/validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryServers, assertEmpty, assertExactTXT, waitForTXT } from '../src/dns/verify.js';

const row = (server: string, records: DnsRecords) => ({ server, records });
const silent = { info() {}, warn() {}, error() {} };
test('DNS preflight stops when any record is visible', () => {
  assert.doesNotThrow(() => assertEmpty([row('ns1', { A: [], TXT: [] })]));
  assert.throws(() => assertEmpty([row('ns1', { A: ['127.0.0.1'] })]), /reports 1 A/);
});
test('foreign TXT and other records block cleanup; stale own tokens are allowed only during propagation', () => {
  assert.doesNotThrow(() =>
    assertExactTXT([row('ns1', { TXT: ['abc-def1234'], A: [] })], ['abc-def1234']),
  );
  assert.throws(
    () => assertExactTXT([row('ns1', { TXT: ['other-123456'] })], []),
    (e) => errorCode(e) === 'DNS_FOREIGN_TXT',
  );
  assert.throws(
    () => assertExactTXT([row('ns1', { TXT: [], MX: ['mail'] })], []),
    (e) => errorCode(e) === 'DNS_FOREIGN_RECORD',
  );
  assert.throws(
    () => assertExactTXT([row('ns1', { TXT: [] })], ['abc-def1234']),
    (e) => errorCode(e) === 'DNS_NOT_PROPAGATED',
  );
});
test('TXT-only queries do not enumerate unrelated RR types', async () => {
  const seen: string[][] = [];
  const rows = await queryServers(
    '_acme-challenge.example.com',
    ['ns1', 'ns2'],
    ['TXT'],
    async (server) => ({
      resolve: async (_, rr) => {
        seen.push([server, rr]);

        return [['abc', '-def1234']];
      },
      cancel() {},
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.server),
    ['ns1', 'ns2'],
  );
  assert.deepEqual(rows[0]?.records.TXT, ['abc-def1234']);
  assert.deepEqual(
    seen.map((pair) => pair[1]),
    ['TXT', 'TXT'],
  );
});
test('propagation eventually succeeds and waits for successive checks', async () => {
  let called = 0;
  let now = 0;
  await waitForTXT({
    name: 'test.example.com',
    authoritative: ['ns1'],
    recursive: ['1.1.1.1'],
    expected: ['token-abc123456'],
    timeoutMs: 200,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    stableMs: 0,
    intervalMs: 1,
    query: async (_, servers) => {
      called++;

      return [row(servers[0] ?? 'missing', { TXT: called === 1 ? [] : ['token-abc123456'] })];
    },
    logger: silent,
  });
  assert(called >= 3);
});

test('nameserver addresses expire and failed lookups have a specific error code', async () => {
  const { createServerResolver } = await import('../src/dns/verify.js');
  let now = 0;
  let calls = 0;
  const resolve = createServerResolver(
    async () => ({ address: `192.0.2.${++calls}` }),
    () => now,
    1000,
  );
  assert.equal(await resolve('ns.example.com'), '192.0.2.1');
  assert.equal(await resolve('ns.example.com'), '192.0.2.1');
  now = 1000;
  assert.equal(await resolve('ns.example.com'), '192.0.2.2');
  assert.equal(await resolve('192.0.2.99'), '192.0.2.99');
  assert.equal(calls, 2);
  const broken = createServerResolver(async () => {
    throw Error('lookup failed');
  });
  await assert.rejects(broken('ns.example.com'), { code: 'DNS_NS_LOOKUP_FAILED' });
});
