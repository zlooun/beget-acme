import { object, string } from '../src/core/validation.js';
import { AppError } from '../src/core/errors.js';
import { parseDocument } from '../src/acme/types.js';
import type { HttpTransport } from '../src/core/validation.js';
import type { ClientOptions } from '../src/acme/client.js';
import type { X509Certificate } from '@peculiar/x509';
import { errorCode } from '../src/core/validation.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createPublicKey, createHash, generateKeyPairSync, verify } from 'node:crypto';
import {
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from '@peculiar/x509';
const webcrypto = globalThis.crypto;
import { AcmeClientProvider } from '../src/acme/provider.js';
import { AcmeClient, retryDelay } from '../src/acme/client.js';
import { createAccountKey, createCertificateRequest, accountSigner } from '../src/acme/crypto.js';
import { validateCertificate } from '../src/core/store.js';

function dnsNames(request: Pkcs10CertificateRequest): string[] {
  const extension = request.getExtension('2.5.29.17');
  assert(extension instanceof SubjectAlternativeNameExtension);

  return extension.names.items.map((name) => name.value);
}

const origin = 'https://ca.example';
const decode = (encoded: unknown) =>
  object(JSON.parse(Buffer.from(string(encoded), 'base64url').toString()));
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: { 'replay-nonce': 'fresh-nonce', ...headers },
  });

function fakeCA({
  reused = false,
  badName = false,
  invalid = false,
  duplicate = false,
  domains = ['example.com', '*.example.com'],
} = {}) {
  const events: string[] = [];
  let jwk: Record<string, string> | undefined;
  let issued = false,
    nonce = 0;
  const completed = new Set();
  const usedNonces = new Set();
  const issuedNonces = new Set();
  const order = (status = 'pending') => ({
    status,
    identifiers: domains.map((value) => ({ type: 'dns', value })),
    authorizations: domains.map((_, index) => origin + '/auth/' + (duplicate ? 0 : index)),
    finalize: origin + '/finalize',
    certificate: origin + '/certificate',
  });

  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
    const value = `nonce-${++nonce}`;
    issuedNonces.add(value);

    return response(data, status, { ...headers, 'replay-nonce': value });
  };

  let certificate: X509Certificate | undefined;

  const fetchImpl: HttpTransport = async (url, options) => {
    const route = new URL(url).pathname;

    if (route === '/directory') {
      return reply({
        newNonce: origin + '/nonce',
        newAccount: origin + '/account',
        newOrder: origin + '/new-order',
      });
    }

    if (route === '/nonce') {
      return reply('');
    }

    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = object(JSON.parse(string(options.body)));
    const header = decode(body.protected);
    assert.equal(header.url, url);
    assert(issuedNonces.has(header.nonce));
    assert(!usedNonces.has(header.nonce));
    usedNonces.add(header.nonce);

    if (route === '/account') {
      const rawJwk = object(header.jwk);
      jwk = Object.fromEntries(Object.entries(rawJwk).map(([key, value]) => [key, string(value)]));
      assert(!header.kid);
    }

    if (route !== '/account') {
      assert.equal(header.kid, origin + '/account/1');
      assert(!header.jwk);
    }

    assert(jwk);
    assert(
      verify(
        'sha256',
        Buffer.from(`${string(body.protected)}.${string(body.payload)}`),
        {
          key: createPublicKey({ key: jwk, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(string(body.signature), 'base64url'),
      ),
    );
    events.push(route);

    if (route === '/account') {
      return reply({ status: 'valid' }, 201, { location: origin + '/account/1' });
    }

    if (route === '/new-order') {
      assert.deepEqual(decode(body.payload).identifiers, order().identifiers);

      return reply(order(reused ? 'ready' : 'pending'), 201, { location: origin + '/order/1' });
    }

    if (route.startsWith('/challenge/')) {
      assert.deepEqual(decode(body.payload), {});
      completed.add(route.at(-1));

      return reply({ status: 'pending' });
    }

    if (route === '/finalize') {
      const csr = new Pkcs10CertificateRequest(
        Buffer.from(string(decode(body.payload).csr), 'base64url'),
      );
      assert(await csr.verify(webcrypto));
      assert.deepEqual(dnsNames(csr), domains);
      const caKeys = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      certificate = await X509CertificateGenerator.create(
        {
          serialNumber: '01',
          subject: 'CN=example.com',
          issuer: 'CN=Test CA',
          notBefore: new Date(Date.now() - 1000),
          notAfter: new Date(Date.now() + 86400000 * 90),
          signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
          publicKey: csr.publicKey,
          signingKey: caKeys.privateKey,
          extensions: [
            new SubjectAlternativeNameExtension(
              domains.map((value) => ({ type: 'dns' as const, value })),
            ),
          ],
        },
        webcrypto,
      );
      issued = true;

      return reply(order('processing'), 200, { 'retry-after': '0' });
    }

    assert.equal(body.payload, '', 'POST-as-GET must have an empty payload');

    if (route.startsWith('/auth/')) {
      const identity = domains[Number(route.split('/').at(-1))]!;

      return reply({
        status: reused || completed.has(route.at(-1)) ? (invalid ? 'invalid' : 'valid') : 'pending',
        identifier: {
          type: 'dns',
          value: badName ? 'other.example' : identity.replace(/^\*\./, ''),
        },
        ...(identity.startsWith('*.') ? { wildcard: true } : {}),
        challenges: [
          {
            type: 'dns-01',
            token: route.endsWith('1') ? 'BBBBBBBBBBBBBBBBBBBBBB' : 'AAAAAAAAAAAAAAAAAAAAAA',
            url: origin + '/challenge/' + route.at(-1),
          },
        ],
      });
    }

    if (route === '/order/1') {
      return reply(order(issued ? 'valid' : 'ready'));
    }

    if (route === '/certificate') {
      return reply(certificate?.toString('pem'));
    }

    assert.fail(`Unexpected request ${route}`);
  };

  return { fetchImpl, events, getJwk: () => jwk };
}

for (const reused of [false, true]) {
  test(`full signed ACME issuance (reused authorizations: ${reused})`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-acme-'));

    try {
      const fake = fakeCA({ reused });
      const provider = new AcmeClientProvider({
        clientOptions: { fetchImpl: fake.fetchImpl, sleep: async () => {} },
      });
      const args = {
        environment: 'staging' as const,
        domains: ['example.com', '*.example.com'],
        email: 'me@example.com',
        stateDir: dir,
      };
      const order = await provider.createOrder(args);
      assert.equal(order.challenges.length, reused ? 0 : 2);

      if (!reused) {
        const thumb = createHash('sha256')
          .update(JSON.stringify(fake.getJwk()))
          .digest('base64url');
        assert.deepEqual(
          order.challenges,
          ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB'].map((token) => ({
            name: '_acme-challenge.example.com',
            value: createHash('sha256').update(`${token}.${thumb}`).digest('base64url'),
          })),
        );
      }

      await order.validate();
      const { key, chain } = await order.finalize();
      assert(validateCertificate(key, chain, 'example.com'));
      const before = await fs.readFile(path.join(dir, 'staging/account.key'), 'utf8');
      await provider.createOrder(args);
      assert.equal(await fs.readFile(path.join(dir, 'staging/account.key'), 'utf8'), before);

      if (!reused) {
        assert(fake.events.indexOf('/challenge/1') < fake.events.lastIndexOf('/finalize'));
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

for (const [options, code] of [
  [{ badName: true }, 'ACME_CHALLENGE_NAME'],
  [{ duplicate: true }, 'ACME_ORDER_INVALID'],
  [{ invalid: true }, 'ACME_VALIDATION_FAILED'],
] as const) {
  test(`provider rejects ${JSON.stringify(options)}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-acme-'));

    try {
      const fake = fakeCA(options);
      const provider = new AcmeClientProvider({ clientOptions: { fetchImpl: fake.fetchImpl } });
      await assert.rejects(
        async () => {
          const order = await provider.createOrder({
            environment: 'staging',
            domains: ['example.com', '*.example.com'],
            email: 'me@example.com',
            stateDir: dir,
          });
          await order.validate();
        },
        { code },
      );
      assert(!fake.events.includes('/finalize'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

function clientWith(fetchImpl: HttpTransport, extras: Partial<ClientOptions> = {}) {
  const client = new AcmeClient({
    accountKey: createAccountKey(),
    directoryUrl: origin + '/directory',
    fetchImpl,
    ...extras,
  });
  client.directory = { newNonce: origin + '/nonce' };
  client.kid = origin + '/account/1';
  client.nonce = 'initial-nonce';

  return client;
}

test('badNonce retries with new nonce and preserves payload, but stops after three attempts', async () => {
  for (const succeed of [true, false]) {
    const seen: unknown[] = [];
    const client = clientWith(async (url, options) => {
      const body = object(JSON.parse(string(options.body)));
      seen.push(decode(body.protected).nonce);
      assert.deepEqual(decode(body.payload), { test: 1 });

      return response(
        seen.length === 2 && succeed
          ? { status: 'valid' }
          : { type: 'urn:ietf:params:acme:error:badNonce' },
        seen.length === 2 && succeed ? 200 : 400,
        { 'replay-nonce': `retry-${seen.length}` },
      );
    });

    if (succeed) {
      await client.post(origin + '/resource', { test: 1 });
    }

    if (!succeed) {
      await assert.rejects(client.post(origin + '/resource', { test: 1 }), {
        code: 'ACME_HTTP_ERROR',
      });
    }

    assert.deepEqual(
      seen,
      succeed ? ['initial-nonce', 'retry-1'] : ['initial-nonce', 'retry-1', 'retry-2'],
    );
  }
});

test('missing nonce uses HEAD; rate limits and uncertain transport are not retried', async () => {
  let calls = 0;
  const client = clientWith(async (url, options) => {
    calls++;

    if (options.method === 'HEAD') {
      return response('');
    }

    return response({ type: 'urn:ietf:params:acme:error:rateLimited', detail: 'SECRET' }, 429, {
      'retry-after': '60',
    });
  });
  client.nonce = undefined;
  await assert.rejects(
    client.post(origin + '/resource', {}),
    (e) =>
      e instanceof AppError &&
      errorCode(e) === 'ACME_RATE_LIMIT' &&
      e.retryAfterMs === 60000 &&
      !e.message.includes('SECRET'),
  );
  assert.equal(calls, 2);
  calls = 0;
  const broken = clientWith(async () => {
    calls++;
    throw new Error('network down');
  });
  await assert.rejects(broken.post(origin + '/resource', {}), { code: 'ACME_TRANSPORT' });
  assert.equal(calls, 1);
});

test('polling respects Retry-After and deadlines; invalid states stop immediately', async () => {
  let clock = 0,
    calls = 0;
  const waits: number[] = [];
  const client = clientWith(
    async () => {
      calls++;

      return response({ status: calls > 1 ? 'valid' : 'pending' }, 200, { 'retry-after': '3' });
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      pollTimeoutMs: 5000,
    },
  );
  await client.poll(origin + '/auth', ['valid'], ['pending']);
  assert.deepEqual(waits, [3000]);
  const pending = response({ status: 'pending' }, 200, { 'retry-after': '3600' });
  await assert.rejects(
    client.poll(origin + '/auth', ['valid'], ['pending'], {
      text: '',
      response: pending,
      data: { status: 'pending' },
    }),
    { code: 'ACME_POLL_TIMEOUT' },
  );
  await assert.rejects(
    client.poll(origin + '/auth', ['valid'], ['pending'], {
      text: '',
      response: pending,
      data: { status: 'invalid' },
    }),
    { code: 'ACME_VALIDATION_FAILED' },
  );
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 2000), 8000);
  assert.equal(retryDelay('garbage'), 2000);
});

test('account signatures support existing EC SEC1 and RSA PKCS1 keys', () => {
  for (const [type, params, encoding, algorithm] of [
    ['ec', { namedCurve: 'prime256v1' }, 'sec1', 'sha256'],
    ['ec', { namedCurve: 'secp384r1' }, 'sec1', 'sha384'],
    ['ec', { namedCurve: 'secp521r1' }, 'sec1', 'sha512'],
    ['rsa', { modulusLength: 2048 }, 'pkcs1', 'sha256'],
  ] as const) {
    const { privateKey, publicKey } =
      type === 'ec' ? generateKeyPairSync('ec', params) : generateKeyPairSync('rsa', params);
    const signer = accountSigner(privateKey.export({ format: 'pem', type: encoding }));
    assert(
      verify(
        algorithm,
        Buffer.from('signed-data'),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signer.sign('signed-data'), 'base64url'),
      ),
    );
    assert(!Object.hasOwn(signer.jwk, 'd'));
  }
});

test('CSR has a valid signature, exact SANs and matching private key', async () => {
  const { key, csr } = await createCertificateRequest('example.com');
  const request = new Pkcs10CertificateRequest(Buffer.from(csr, 'base64url'));
  assert(await request.verify(webcrypto));
  assert.deepEqual(
    Buffer.from(request.publicKey.rawData),
    createPublicKey(key).export({ format: 'der', type: 'spki' }),
  );
  assert.deepEqual(dnsNames(request), ['example.com', '*.example.com']);
});

test('insecure or malformed CA URLs are rejected', () => {
  const client = clientWith(async () => assert.fail('must not fetch'));

  for (const url of [
    null,
    'http://ca.example',
    'https://user:pass@ca.example',
    'https://ca.example/#fragment',
  ]) {
    assert.throws(() => client.url(url), { code: 'ACME_RESPONSE_INVALID' });
  }
});

test('request timeout aborts fetch and is not retried', async () => {
  let calls = 0;
  const client = clientWith(
    async (url, { signal }) => {
      calls++;

      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('abort did not fire')), 1000);
        assert(signal);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
          },
          { once: true },
        );
      });
    },
    { requestTimeoutMs: 10 },
  );
  await assert.rejects(client.post(origin + '/resource', {}), { code: 'ACME_TRANSPORT' });
  assert.equal(calls, 1);
});

test('missing nonce and malformed directory fail closed', async () => {
  const missing = clientWith(async () => new Response('', { status: 200 }));
  missing.nonce = undefined;
  await assert.rejects(missing.post(origin + '/resource', {}), { code: 'ACME_NONCE_MISSING' });
  const malformed = clientWith(async () => response('<html>not JSON</html>'));
  await assert.rejects(malformed.initialize(), { code: 'ACME_RESPONSE_INVALID' });
});

test('numeric problem status preserves HTTP classification and Retry-After without leaking detail', async () => {
  for (const [status, type, code] of [
    [429, 'rateLimited', 'ACME_RATE_LIMIT'],
    [403, 'unauthorized', 'ACME_VALIDATION_FAILED'],
    [400, 'invalidContact', 'ACME_HTTP_ERROR'],
  ] as const) {
    let calls = 0;
    const client = clientWith(async () => {
      calls++;

      return response(
        { status, type: `urn:ietf:params:acme:error:${type}`, detail: 'SECRET response detail' },
        status,
        { 'retry-after': '120' },
      );
    });
    await assert.rejects(client.post(origin + '/new-order', {}), (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, code);
      assert.equal(error.retryAfterMs, 120000);
      assert(error.message.includes(type));
      assert(!error.message.includes('SECRET'));

      return true;
    });
    assert.equal(calls, 1);
  }
});

test('ACME errors identify the operation without exposing resource URLs', async () => {
  const client = clientWith(async () =>
    response({ status: 403, type: 'urn:ietf:params:acme:error:unauthorized' }, 403),
  );
  client.directory.newAccount = origin + '/account';
  client.directory.newOrder = origin + '/new-order';

  for (const operation of ['newAccount', 'newOrder'] as const) {
    await assert.rejects(client.post(client.directory[operation]!), (error: unknown) => {
      assert(error instanceof AppError);
      assert(error.message.includes(`rejected ${operation}`));
      assert(!error.message.includes(origin));

      return true;
    });
  }

  await assert.rejects(
    client.post(origin + '/private-resource', undefined, { operation: 'authorization' }),
    /rejected authorization/,
  );
});

test('account refusal is distinct from DNS validation and only fixed reasons are exposed', async () => {
  for (const [detail, code] of [
    [
      'An account with the provided public key exists but is deactivated',
      'ACME_ACCOUNT_DEACTIVATED',
    ],
    ['An account with the provided public key exists but is revoked', 'ACME_ACCOUNT_REVOKED'],
    ['SECRET unrecognized reason', 'ACME_ACCOUNT_UNAUTHORIZED'],
  ] as const) {
    const client = clientWith(async () =>
      response({ status: 403, type: 'urn:ietf:params:acme:error:unauthorized', detail }, 403),
    );
    client.directory.newAccount = origin + '/account';
    await assert.rejects(client.createAccount('test@example.com'), (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, code);
      assert(!error.message.includes('SECRET'));
      assert(!error.hint?.includes('Inspect DNS'));

      return true;
    });
  }
});

test('unused challenge types do not require DNS-01 fields', () => {
  const dns = { type: 'dns-01', token: 'test-token', url: origin + '/challenge' };
  const document = parseDocument({
    challenges: [{ type: 'future-challenge', extension: true }, dns],
  });
  assert.deepEqual(document.challenges, [dns]);
  assert.throws(
    () => parseDocument({ challenges: [{ type: 'dns-01', url: origin + '/challenge' }] }),
    /challenges\[0\]\.token: expected a string, received undefined/,
  );
  assert.throws(
    () => parseDocument({ challenges: [{ token: 'SECRET' }] }),
    /challenges\[0\]\.type/,
  );
});

test('malformed response diagnostics include the operation and field without values', async () => {
  const client = clientWith(async () => response({ identifier: { type: 'dns', value: 123 } }));
  await assert.rejects(
    client.post(origin + '/auth', undefined, { operation: 'authorization' }),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'ACME_RESPONSE_INVALID');
      assert(error.message.includes('authorization: Invalid ACME field identifier.value'));
      assert(error.message.includes('received number'));
      assert(!error.message.includes('123'));

      return true;
    },
  );
});

test('document parser preserves resource states and rejects malformed status fields', () => {
  assert.equal(parseDocument({ status: 'pending' }).status, 'pending');
  assert.equal(parseDocument({ status: 400 }).status, undefined);

  for (const status of [null, true, {}, [], 200, 600, 400.5]) {
    assert.throws(() => parseDocument({ status }), { code: 'ACME_RESPONSE_INVALID' });
  }
});

test('unrecognized problem types cannot leak arbitrary text into errors', async () => {
  const client = clientWith(async () =>
    response({ status: 400, type: 'SECRET arbitrary text' }, 400),
  );
  await assert.rejects(client.post(origin + '/new-order', {}), (error: unknown) => {
    assert(error instanceof AppError);
    assert.equal(error.code, 'ACME_HTTP_ERROR');
    assert(!error.message.includes('SECRET'));
    assert(error.message.includes('unknown'));

    return true;
  });
});

test('HTTP 500 is not retried and its body is not exposed', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;

    return response('SECRET server failure', 500);
  });
  await assert.rejects(
    client.post(origin + '/new-order', {}),
    (e) =>
      e instanceof Error && errorCode(e) === 'ACME_HTTP_ERROR' && !e.message.includes('SECRET'),
  );
  assert.equal(calls, 1);
});

for (const domains of [
  ['api.example.com'],
  ['*.apps.example.com'],
  ['example.com', '*.example.com', 'api.other.net'],
]) {
  test(`signed order and CSR preserve exact configured identities: ${domains.join(',')}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-identities-'));

    try {
      const ca = fakeCA({ domains });
      const provider = new AcmeClientProvider({
        clientOptions: { fetchImpl: ca.fetchImpl, sleep: async () => {} },
      });
      const order = await provider.createOrder({
        environment: 'staging',
        domains,
        email: 'test@example.com',
        stateDir: dir,
      });
      assert.deepEqual(
        order.challenges.map((entry) => entry.name),
        domains.map((name) => `_acme-challenge.${name.replace(/^\*\./, '')}`),
      );
      await order.validate();
      const result = await order.finalize();
      assert(validateCertificate(result.key, result.chain, domains));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('long DNS identity remains in SAN while CN is omitted', async () => {
  const name = `${'a'.repeat(63)}.example.com`;
  const { csr } = await createCertificateRequest([name]);
  const request = new Pkcs10CertificateRequest(Buffer.from(csr, 'base64url'));
  assert.deepEqual(dnsNames(request), [name]);
  assert.equal(request.subject, '');
  assert(await request.verify(webcrypto));
});
