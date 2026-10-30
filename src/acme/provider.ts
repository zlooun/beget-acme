import { syncDirectory } from '../core/store.js';
import { randomUUID } from 'node:crypto';
import { errorCode } from '../core/validation.js';
import type { ClientOptions } from './client.js';
import type { AcmeDocument, AcmeOrder, AcmeProvider, OrderOptions } from './types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../core/errors.js';
import { AcmeClient, DIRECTORIES } from './client.js';
import { createAccountKey, createCertificateRequest, sha256 } from './crypto.js';

/** DNS orchestration depends only on createOrder/challenges/validate/finalize. */
export class AcmeClientProvider implements AcmeProvider {
  readonly clientOptions: Partial<Omit<ClientOptions, 'accountKey' | 'directoryUrl'>>;
  readonly csrFactory: typeof createCertificateRequest;

  constructor({
    clientOptions = {},
    csrFactory = createCertificateRequest,
  }: {
    clientOptions?: Partial<Omit<ClientOptions, 'accountKey' | 'directoryUrl'>>;
    csrFactory?: typeof createCertificateRequest;
  } = {}) {
    this.clientOptions = clientOptions;
    this.csrFactory = csrFactory;
  }

  async createOrder({ environment, domains, email, stateDir }: OrderOptions): Promise<AcmeOrder> {
    if (!Object.hasOwn(DIRECTORIES, environment)) {
      fail('ACME_ENVIRONMENT_INVALID', 'Use staging or production.');
    }

    const accountFile = path.join(stateDir, environment, 'account.key');
    await fs.mkdir(path.dirname(accountFile), { recursive: true, mode: 0o700 });
    let accountKey: string | Buffer;

    try {
      accountKey = await fs.readFile(accountFile);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }

      accountKey = createAccountKey();

      const temporaryKey = `${accountFile}.${randomUUID()}.tmp`;

      try {
        await fs.writeFile(temporaryKey, accountKey, { mode: 0o600, flag: 'wx', flush: true });
        // Publish a complete key without replacing an existing account identity.
        await fs.link(temporaryKey, accountFile);
        await syncDirectory(path.dirname(accountFile));
      } catch (cause) {
        if (errorCode(cause) !== 'EEXIST') {
          throw cause;
        }

        accountKey = await fs.readFile(accountFile);
      } finally {
        await fs.rm(temporaryKey, { force: true });
      }
    }

    const client = new AcmeClient({
      ...this.clientOptions,
      accountKey,
      directoryUrl: DIRECTORIES[environment],
    });
    await client.initialize();
    await client.createAccount(email);
    const identifiers = domains;

    if (!identifiers.length || new Set(identifiers).size !== identifiers.length) {
      fail('ACME_ORDER_INVALID', 'Invalid requested identities.');
    }

    const created = await client.post(client.url(client.directory.newOrder), {
      identifiers: identifiers.map((value) => ({ type: 'dns', value })),
    });
    const orderUrl = client.url(created.response.headers.get('location'));

    const assertOrder = (data: AcmeDocument) => {
      if (
        !Array.isArray(data?.identifiers) ||
        data.identifiers.length !== identifiers.length ||
        !identifiers.every((value) =>
          data.identifiers?.some((id) => id.type === 'dns' && id.value === value),
        )
      ) {
        fail('ACME_ORDER_INVALID', 'CA returned unexpected order identifiers.');
      }
    };

    assertOrder(created.data);

    if (!['pending', 'ready'].includes(created.data.status ?? '')) {
      fail('ACME_ORDER_INVALID', 'Unexpected initial order state.');
    }

    const finalizeUrl = client.url(created.data.finalize);

    if (
      !Array.isArray(created.data.authorizations) ||
      created.data.authorizations.length !== identifiers.length ||
      new Set(created.data.authorizations).size !== identifiers.length
    ) {
      fail('ACME_ORDER_INVALID', 'CA returned an unexpected authorization set.');
    }

    const pending: { name: string; value: string; url: string; authorizationUrl: string }[] = [];
    const seen = new Set();

    for (const url of created.data.authorizations) {
      const { data: authorization } = await client.post(url, undefined, {
        operation: 'authorization',
      });

      if (
        authorization?.identifier?.type !== 'dns' ||
        !identifiers.includes(
          authorization.wildcard
            ? `*.${authorization.identifier.value}`
            : authorization.identifier.value,
        ) ||
        (authorization.wildcard !== undefined && typeof authorization.wildcard !== 'boolean')
      ) {
        fail('ACME_CHALLENGE_NAME', 'CA returned an unexpected authorization identifier.');
      }

      const base = authorization.identifier.value;
      const identifier = authorization.wildcard ? `*.${base}` : base;

      if (seen.has(identifier)) {
        fail('ACME_ORDER_INVALID', 'CA returned a duplicate authorization.');
      }

      seen.add(identifier);

      if (authorization.status === 'valid') {
        continue;
      }

      if (authorization.status !== 'pending') {
        fail('ACME_AUTHORIZATION_INVALID', 'ACME authorization is not pending or valid.');
      }

      const challenge = authorization.challenges?.find((candidate) => candidate.type === 'dns-01');

      if (!challenge) {
        fail('ACME_DNS_CHALLENGE_MISSING', 'CA did not return a DNS-01 challenge.');
      }

      if (typeof challenge.token !== 'string' || !/^[A-Za-z0-9_-]{22,}$/.test(challenge.token)) {
        fail('ACME_RESPONSE_INVALID', 'CA returned an invalid DNS-01 token.');
      }

      pending.push({
        name: `_acme-challenge.${base}`,
        value: sha256(`${challenge.token}.${client.signer.thumbprint}`),
        url: client.url(challenge.url),
        authorizationUrl: url,
      });
    }

    const csrFactory = this.csrFactory;

    return {
      challenges: pending.map(({ name, value }) => ({ name, value })),
      async validate() {
        // The application has already published the complete TXT set.
        for (const challenge of pending) {
          await client.post(challenge.url, {}, { operation: 'challenge' });
        }

        for (const challenge of pending) {
          await client.poll(challenge.authorizationUrl, ['valid'], ['pending']);
        }
      },
      async finalize() {
        const ready = await client.poll(orderUrl, ['ready'], ['pending']);
        assertOrder(ready.data);
        const { key, csr } = await csrFactory(identifiers);
        const submitted = await client.post(finalizeUrl, { csr }, { operation: 'finalize' });
        const completed = await client.poll(
          orderUrl,
          ['valid'],
          ['processing', 'ready'],
          submitted,
        );
        assertOrder(completed.data);
        const certificate = await client.post(client.url(completed.data.certificate), undefined, {
          operation: 'certificate',
        });

        if (!certificate.text.startsWith('-----BEGIN CERTIFICATE-----')) {
          fail('ACME_RESPONSE_INVALID', 'CA did not return a PEM certificate chain.');
        }

        return { key, chain: certificate.text };
      },
    };
  }
}
