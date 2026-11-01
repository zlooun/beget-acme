import { runService } from '../src/core/service.js';
import { setup as configureSetup } from '../src/core/setup.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import { Application } from '../src/core/application.js';
import { loadConfig } from '../src/core/config.js';
import { OperationStore, saveCertificate } from '../src/core/store.js';
import { AppError } from '../src/core/errors.js';
import type { BegetProvider } from '../src/providers/beget.js';
import type { DnsQuery } from '../src/dns/verify.js';
import { pause } from '../src/core/shutdown.js';

const logger = { info() {}, warn() {}, error() {} };
const domains = ['example.com', '*.example.com', 'api.other.net'];
const names = ['_acme-challenge.example.com', '_acme-challenge.api.other.net'];

/** Exercise the same service loop as the CLI with isolated application dependencies. */
async function schedule(
  app: Application,
  { once = false, initialIssue = false, environment = 'production' } = {},
) {
  await runService(app.config, app.store, {
    once,
    logger: app.logger,
    signal: app.signal,
    sleep: app.sleep,
    recover: () => app.recover(environment),
    work: () => app.renewalCheck({ initialIssue, environment }),
  });
}

async function fixture(work: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = await setup();

  try {
    await work(value);
  } finally {
    await fs.rm(value.dir, { recursive: true, force: true });
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-multi-'));
  const base = await loadConfig({
    ACME_DOMAINS: domains.join(','),
    BEGET_ZONES: 'example.com,other.net',
    ACME_EMAIL: 'admin@example.com',
    BEGET_USERNAME: 'user',
    BEGET_PASSWORD: 'secret',
    ACME_ACCEPT_DNS_REPLACEMENT: 'true',
    ACME_STATE_DIR: dir,
    ACME_OUTPUT_DIR: path.join(dir, 'output'),
  });
  const config = { ...base, timeoutMs: 1000, cleanupSettleMs: 0 };
  const records = new Map<string, string[]>();
  const writes: { name: string; values: string[] }[] = [];
  const zones: string[] = [];
  const beget: BegetProvider = {
    async assertRootZone(fqdn) {
      zones.push(fqdn);

      return { fqdn, is_beget_dns: true, is_under_control: true };
    },
    async describe(name) {
      return {
        readable: true,
        records: { TXT: (records.get(name) ?? []).map((value) => ({ value })) },
      };
    },
    async replaceTXT(name, values) {
      writes.push({ name, values });
      records.set(name, [...values]);
    },
  };
  const query: DnsQuery = async (name, servers, types) =>
    servers.map((server) => ({
      server,
      records: Object.fromEntries(
        types.map((type) => [type, type === 'TXT' ? (records.get(name) ?? []) : []]),
      ),
    }));
  const store = new OperationStore(dir);
  const controller = new AbortController();
  const app = new Application(config, store, {
    beget,
    dnsQuery: query,
    logger,
    signal: controller.signal,
  });
  app.provider = {
    async createOrder(options) {
      assert.deepEqual(options.domains, domains);

      return {
        challenges: [
          { name: names[0]!, value: 'token-first-1234' },
          { name: names[0]!, value: 'token-second-1234' },
          { name: names[1]!, value: 'token-third-1234' },
        ],
        async validate() {
          assert.equal(records.get(names[0]!)?.length, 2);
          assert.equal(records.get(names[1]!)?.length, 1);
        },
        async finalize() {
          return { key: 'fake', chain: 'fake' };
        },
      };
    },
  };

  app.saveCertificate = async (_key, _chain, _dir, requested) => {
    assert.deepEqual(requested, domains);

    return { current: 'current', certificate: { validTo: '2030-01-01' } };
  };

  return { dir, config, app, store, beget, writes, records, zones, controller };
}

async function certificate(dir: string, identities = domains, lifetime = 10) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const cert = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: '01',
      name: 'CN=example.com',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(Date.now() - 1000),
      notAfter: new Date(Date.now() + lifetime * 86400000),
      extensions: [
        new SubjectAlternativeNameExtension(
          identities.map((value) => ({ type: 'dns' as const, value })),
        ),
      ],
    },
    crypto,
  );
  const exported = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  await saveCertificate(
    '-----BEGIN PRIVATE KEY-----\n' + exported.toString('base64') + '\n-----END PRIVATE KEY-----\n',
    cert.toString('pem'),
    path.join(dir, 'output', 'production'),
    identities,
  );
}

test('multi-zone issue groups tokens and cleans every entry', async () => {
  await fixture(async ({ app, store, writes, zones }) => {
    await store.locked(() => app.issue('staging'));
    assert.deepEqual(
      writes.map((write) => [write.name, write.values.length]),
      [
        [names[0], 2],
        [names[1], 1],
        [names[0], 0],
        [names[1], 0],
      ],
    );
    assert(zones.includes('example.com') && zones.includes('other.net'));
    assert.equal(await store.journal(), null);
  });
});

test('second-name write failure keeps both entries and supports later recovery', async () => {
  await fixture(async ({ app, store, beget, writes, records }) => {
    const replace = beget.replaceTXT.bind(beget);

    beget.replaceTXT = async (name, values) => {
      await replace(name, values);

      if (name === names[1] && values.length) {
        throw new AppError('BEGET_NETWORK_ERROR', 'Lost response');
      }
    };

    await assert.rejects(
      store.locked(() => app.issue('staging')),
      /Lost response/,
    );
    const journal = await store.requireJournal();
    assert.equal(journal.phase, 'published');
    assert.equal(journal.entries?.[0]?.phase, 'prepared');
    assert.equal(writes.length, 2);
    assert.equal(records.size, 2);
    await store.locked(() => app.cleanup());
    assert.equal(await store.journal(), null);
    assert.equal(writes.length, 4);
  });
});

test('partial recovery preserves prepared empty entry and explains operator action', async () => {
  await fixture(async ({ app, store, records, writes }) => {
    await store.writeJournal({
      name: names[0]!,
      values: ['token-first-1234'],
      phase: 'published',
      version: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      entries: [{ name: names[1]!, values: ['token-second-1234'], phase: 'prepared' }],
    });
    records.set(names[0]!, ['token-first-1234']);
    await assert.rejects(
      store.locked(() => app.cleanup()),
      (error) => {
        assert(error instanceof AppError);
        assert.equal(error.code, 'DNS_MUTATION_UNCERTAIN');
        assert(error.message.includes(names[1]!));
        assert(error.hint?.includes('journal-clear'));

        return true;
      },
    );
    assert.equal(writes.length, 1);
    assert.equal((await store.requireJournal()).name, names[1]);
    assert.equal((await store.requireJournal()).phase, 'prepared');
  });
});

test('nonempty preflight prevents creating any ACME order; dry-run writes nothing', async () => {
  await fixture(async ({ app, records, writes, store }) => {
    app.provider = {
      async createOrder() {
        assert.fail('No ACME order should be created');
      },
    };
    await app.dryRun();
    assert.deepEqual(writes, []);
    assert.equal(await store.lockInfo(), null);
    assert.equal(await store.journal(), null);
    records.set(names[1]!, ['foreign-token-1234']);
    await assert.rejects(app.issue('staging'), /existing DNS records/);
    assert.deepEqual(writes, []);
  });
});

test('shutdown waits for in-flight write, releases lock and retains recovery entries', async () => {
  await fixture(async ({ app, store, controller, beget, writes }) => {
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const replace = beget.replaceTXT.bind(beget);

    beget.replaceTXT = async (name, values) => {
      started();
      await inFlight;
      await replace(name, values);
    };

    const operation = store.locked(() => app.issue('staging'));
    const rejected = assert.rejects(operation, { code: 'OPERATION_ABORTED' });
    await startedPromise;
    controller.abort();
    assert(await store.lockInfo());
    release();
    await rejected;
    assert.equal(await store.lockInfo(), null);
    assert.equal((await store.requireJournal()).phase, 'published');
    assert.equal((await store.requireJournal()).entries?.[0]?.phase, 'planned');
    assert.equal(writes.length, 1);
  });
});

test('journal-clear requires exact confirmation and empty DNS; archives inspection reason', async () => {
  await fixture(async ({ app, store, dir, records, writes }) => {
    await store.writeJournal({
      name: names[0]!,
      values: ['token-first-1234'],
      phase: 'prepared',
      entries: [{ name: names[1]!, values: ['token-second-1234'], phase: 'prepared' }],
    });
    await assert.rejects(app.clearJournalConfirmed(names[0]!, 'Checked provider panel'), {
      code: 'JOURNAL_CLEAR_NOT_CONFIRMED',
    });
    records.set(names[1]!, ['foreign-token-1234']);
    await assert.rejects(
      app.clearJournalConfirmed(names.join(','), 'Checked provider panel'),
      /existing DNS records/,
    );
    assert(await store.journal());
    records.clear();
    await store.locked(() =>
      app.clearJournalConfirmed(names.join(','), 'Provider panel empty after waiting'),
    );
    assert.equal(await store.journal(), null);
    const archives = await fs.readdir(path.join(dir, 'recovery-archive'));
    assert.equal(archives.length, 1);
    assert.match(
      await fs.readFile(path.join(dir, 'recovery-archive', archives[0]!), 'utf8'),
      /Provider panel empty after waiting/,
    );
    assert.deepEqual(writes, []);
  });
});

test('scheduler fails before entering loop without production certificate', async () => {
  await fixture(async ({ app }) => {
    await assert.rejects(schedule(app, { once: true }), { code: 'RENEW_CERT_MISSING' });
  });
});

test('fresh short-lived certificate is not renewed repeatedly, changed SANs are renewed', async () => {
  await fixture(async ({ app, dir, writes }) => {
    await certificate(dir);
    await schedule(app, { once: true });
    assert.deepEqual(writes, []);
    await certificate(dir, ['example.com']);
    await schedule(app, { once: true });
    assert.equal(writes.length, 4);
  });
});

test('rate limit delay persists across scheduler instances; failed validation is not retried', async () => {
  await fixture(async ({ app, dir, store }) => {
    await certificate(dir, ['example.com']);
    let calls = 0;
    app.provider = {
      async createOrder() {
        calls++;
        const error = new AppError('ACME_RATE_LIMIT', 'Rate limited');
        error.retryAfterMs = 7200000;
        throw error;
      },
    };
    await assert.rejects(schedule(app, { once: true }), { code: 'ACME_RATE_LIMIT' });
    assert((await new OperationStore(dir).retryState())!.notBefore > Date.now() + 7100000);
    await assert.rejects(schedule(app, { once: true }), { code: 'RENEW_RETRY_DEFERRED' });
    assert.equal(calls, 1);
    await store.setRetry(0, 'test');
    app.provider = {
      async createOrder() {
        calls++;
        throw new AppError('ACME_VALIDATION_FAILED', 'Invalid challenge');
      },
    };
    await assert.rejects(schedule(app, { once: true }), { code: 'ACME_VALIDATION_FAILED' });
    assert.equal(calls, 2);
  });
});

test('health check accepts active renewal lock but rejects missing certificate and orphan journal', async () => {
  await fixture(async ({ app, dir, store }) => {
    await assert.rejects(app.status(true), { code: 'STATUS_NOT_READY' });
    await certificate(dir);
    await store.locked(() => app.status(true));
    await store.writeJournal({ name: names[0]!, values: ['token-first-1234'], phase: 'prepared' });
    await assert.rejects(app.status(true), { code: 'STATUS_NOT_READY' });
  });
});

test('shutdown interrupts long scheduler sleep', async () => {
  const controller = new AbortController();
  const sleeping = pause(3600000, controller.signal);
  controller.abort();
  await assert.rejects(sleeping, { code: 'OPERATION_ABORTED' });
});

test(
  'CLI SIGTERM releases its lock after a renewal check',
  { skip: process.platform === 'win32' },
  async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    await fixture(async ({ dir, store, config, beget, app }) => {
      await certificate(dir);
      await configureSetup(
        { ...config, username: 'test', password: 'test' },
        {
          logger,
          provider: beget,
          dnsQuery: app.query,
          confirm: () => Promise.resolve(true),
        },
      );
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'schedule'],
        {
          env: {
            ...process.env,
            ACME_DOMAINS: domains.join(','),
            BEGET_ZONES: 'example.com,other.net',
            ACME_EMAIL: 'admin@example.com',
            BEGET_USERNAME: 'test',
            BEGET_PASSWORD: 'test',
            BEGET_USERNAME_FILE: '',
            BEGET_PASSWORD_FILE: '',
            ACME_ACCEPT_DNS_REPLACEMENT: 'true',
            ACME_STATE_DIR: dir,
            ACME_OUTPUT_DIR: path.join(dir, 'output'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', resolve);
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('Scheduler did not become ready')), 10000);
          child.stdout.on('data', (data: Buffer) => {
            if (data.toString().includes('no renewal needed')) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once('exit', () => {
            clearTimeout(timeout);
            reject(Error('Scheduler exited before readiness'));
          });
        });
        child.kill('SIGTERM');
        const code = await exited;
        assert.equal(code, 143);
        assert.equal(await store.lockInfo(), null);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    });
  },
);

test('run can issue the first certificate and skips issuance after restart with a fresh certificate', async () => {
  await fixture(async ({ app, dir, writes }) => {
    await schedule(app, { once: true, initialIssue: true, environment: 'production' });
    assert.equal(writes.length, 4);
    await certificate(dir);
    await schedule(app, { once: true, initialIssue: true, environment: 'production' });
    assert.equal(writes.length, 4);
  });
});

test('failed challenge cleans its TXT before a later order succeeds', async () => {
  await fixture(async ({ app, store, records, writes }) => {
    const provider = app.provider;
    app.provider = {
      async createOrder(options) {
        const order = await provider.createOrder(options);

        return {
          ...order,
          async validate() {
            throw new AppError('ACME_AUTHORIZATION_INVALID', 'Invalid TXT');
          },
        };
      },
    };
    await assert.rejects(schedule(app, { initialIssue: true, once: true }), {
      code: 'ACME_AUTHORIZATION_INVALID',
    });
    assert.equal(await store.journal(), null);
    assert.equal(writes.length, 4);

    for (const values of records.values()) {
      assert.deepEqual(values, []);
    }

    await store.setRetry(0, 'ACME_AUTHORIZATION_INVALID');
    app.provider = provider;
    await schedule(app, { initialIssue: true, once: true });
    assert.equal(writes.length, 8);
    assert.equal((await store.retryState())?.code, 'OK');
  });
});

test('safe Beget read failures persist a delay; mutation failures are not retried', async () => {
  await fixture(async ({ app, store, beget }) => {
    beget.assertRootZone = async () => {
      throw new AppError('BEGET_READ_RETRYABLE', 'Read timeout');
    };

    await assert.rejects(schedule(app, { initialIssue: true, once: true }), {
      code: 'BEGET_READ_RETRYABLE',
    });
    assert((await store.retryState())!.notBefore > Date.now());
    await assert.rejects(schedule(app, { initialIssue: true, once: true }), {
      code: 'RENEW_RETRY_DEFERRED',
    });
  });
});

test('explicit renewal days override the lifetime fraction', async () => {
  await fixture(async ({ app, config, dir, writes }) => {
    await certificate(dir);
    await app.issue('production');
    assert.equal(writes.length, 0);
    config.renewBeforeDays = 20;
    await app.issue('production');
    assert.equal(writes.length, 4);
  });
});

test('renewal check recovers an unsent journal before using a fresh certificate', async () => {
  await fixture(async ({ app, store, dir, writes }) => {
    await certificate(dir);
    await store.writeJournal({ name: names[0]!, values: ['token-first-1234'], phase: 'planned' });
    await app.renewalCheck({ initialIssue: true });
    assert.equal(await store.journal(), null);
    assert.equal(writes.length, 0);
  });
});
