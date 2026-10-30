import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AcmeConnectionError, createAcmeTransport } from '../src/acme/transport.js';

const url = 'https://ca.example/directory';

test('ACME retries a pre-handshake timeout once with TLS 1.2 and the same deadline', async () => {
  const versions: string[] = [];
  const warnings: string[] = [];
  const options = { method: 'POST', body: 'signed-request', signal: new AbortController().signal };
  const transport = createAcmeTransport(
    (message) => warnings.push(message),
    async (_url, actual, version) => {
      versions.push(version);
      assert.equal(actual, options);

      if (version === 'TLSv1.3') {
        throw new AcmeConnectionError('ACME_CONNECT_TIMEOUT', {});
      }

      return new Response('{}');
    },
  );
  assert.equal((await transport(url, options)).status, 200);
  assert.deepEqual(versions, ['TLSv1.3', 'TLSv1.2']);
  assert.equal(warnings.length, 2);
  assert(!warnings[0]!.includes('signed-request'));
});

test('ACME does not downgrade for certificate errors, DNS errors or failures after sending', async () => {
  for (const failure of [
    new AcmeConnectionError('CERT_HAS_EXPIRED', {}),
    new AcmeConnectionError('ERR_TLS_CERT_ALTNAME_INVALID', {}),
    new AcmeConnectionError('ENOTFOUND', {}),
    Object.assign(new Error('Connection reset after handshake'), { code: 'ECONNRESET' }),
  ]) {
    let calls = 0;
    const transport = createAcmeTransport(undefined, async () => {
      calls++;
      throw failure;
    });
    await assert.rejects(transport(url, {}), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test('HTTP errors never cause a TLS retry; a second handshake failure is final', async () => {
  let calls = 0;
  const rejected = createAcmeTransport(undefined, async () => {
    calls++;

    return new Response('{}', { status: 403 });
  });
  assert.equal((await rejected(url, {})).status, 403);
  assert.equal(calls, 1);
  calls = 0;
  const unavailable = createAcmeTransport(undefined, async () => {
    calls++;
    throw new AcmeConnectionError('ECONNRESET', {});
  });
  await assert.rejects(unavailable(url, {}), { code: 'ECONNRESET' });
  assert.equal(calls, 2);
});

test('cancellation prevents the TLS fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = createAcmeTransport(undefined, async () => {
    calls++;
    controller.abort();
    throw new AcmeConnectionError('ACME_CONNECT_TIMEOUT', {});
  });
  await assert.rejects(transport(url, { signal: controller.signal }));
  assert.equal(calls, 1);
});

test('TLS preference persists across instances and is scoped to the CA host', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-tls-'));

  try {
    const versions: string[] = [];

    const attempt = async (_url: string, _options: RequestInit, version: 'TLSv1.3' | 'TLSv1.2') => {
      versions.push(version);

      if (version === 'TLSv1.3') {
        throw new AcmeConnectionError('ACME_CONNECT_TIMEOUT', {});
      }

      return new Response('{}');
    };

    const first = createAcmeTransport(undefined, attempt, dir);
    await first(url, {});
    await first('https://ca.example/acme/order', {});
    const restarted = createAcmeTransport(undefined, attempt, dir);
    await restarted(url, {});
    assert.deepEqual(versions, ['TLSv1.3', 'TLSv1.2', 'TLSv1.2', 'TLSv1.2']);
    await restarted('https://other-ca.example/directory', {});
    assert.deepEqual(versions.slice(-2), ['TLSv1.3', 'TLSv1.2']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('failed TLS 1.2 fallback does not pin the host', async () => {
  const versions: string[] = [];
  const transport = createAcmeTransport(undefined, async (_url, _options, version) => {
    versions.push(version);
    throw new AcmeConnectionError('ACME_CONNECT_TIMEOUT', {});
  });
  await assert.rejects(transport(url, {}));
  await assert.rejects(transport(url, {}));
  assert.deepEqual(versions, ['TLSv1.3', 'TLSv1.2', 'TLSv1.3', 'TLSv1.2']);
});
