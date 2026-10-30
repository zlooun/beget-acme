import test from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, AppError } from '../src/core/errors.js';

test('ACME NXDOMAIN is human-readable and does not copy the server body', () => {
  const error = new Error(
    'DNS problem: NXDOMAIN looking up TXT for secret.example.com: credentials=private',
  );
  const mapped = messageFor(error);
  assert.equal(mapped.code, 'ACME_DNS_NXDOMAIN');
  assert(!mapped.message.includes('credentials'));
  assert(mapped.hint?.includes('journal'));
});

test('rate-limit errors are classified and raw responses are not logged', () => {
  const error = new Error('429 too many requests: api password hidden');
  const mapped = messageFor(error);
  assert.equal(mapped.code, 'ACME_RATE_LIMIT');
  assert(!mapped.message.includes('password'));
});

test('typed application errors are not wrapped and modified', () => {
  const e = new AppError('DNS_WRITE_DISABLED', 'DNS is disabled');
  assert.equal(messageFor(e), e);
});
