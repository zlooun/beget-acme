import type { Config } from '../src/core/config.js';
import type { BegetProvider } from '../src/providers/beget.js';
import type { DnsQuery } from '../src/dns/verify.js';
import { errorCode } from '../src/core/validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/core/application.js';
import { OperationStore } from '../src/core/store.js';
import { loadConfig } from '../src/core/config.js';

const logger = { info() {}, warn() {}, error() {} };
interface Fixture {
  config: Config;
  store: OperationStore;
  beget: BegetProvider;
  app: Application;
  operations: { name: string; values: string[] }[];
  setRecords: (value: string[]) => void;
}

async function fixture(work: (fixture: Fixture) => Promise<void>, overrides: Partial<Config> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-app-'));

  try {
    const c = await loadConfig({
      ACME_DOMAINS: 'example.com,*.example.com',
      BEGET_ZONES: 'example.com',
      ACME_EMAIL: 'me@example.com',
      BEGET_USERNAME: 'login',
      BEGET_PASSWORD: 'secret',
      ACME_ACCEPT_DNS_REPLACEMENT: 'yes',
      ACME_STATE_DIR: dir,
      ACME_OUTPUT_DIR: path.join(dir, 'output'),
    });
    const config = { ...c, timeoutMs: 300, cleanupSettleMs: 0, ...overrides };
    const store = new OperationStore(config.stateDir);
    let records: string[] = [];
    const operations: Fixture['operations'] = [];
    const beget: BegetProvider = {
      async assertRootZone() {
        return { fqdn: config.zones[0]!, is_beget_dns: true, is_under_control: true };
      },
      async describe() {
        return { readable: false, records: null };
      },
      async replaceTXT(name, values) {
        operations.push({ name, values });
        records = [...values];
      },
    };
    const dnsQuery: DnsQuery = async (_, servers, types) =>
      servers.map((server) => ({
        server,
        records: Object.fromEntries(
          types.map((type) => [type, type === 'TXT' ? [...records] : []]),
        ),
      }));
    const app = new Application(config, store, { beget, dnsQuery, logger });
    await work({
      config,
      store,
      beget,
      app,
      operations,
      setRecords: (value) => {
        records = value;
      },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('DNS operation creates, verifies and cleans its own TXT; journal removed', async () => {
  await fixture(async ({ app, operations, store, config }) => {
    await app.managedMany(
      [{ name: app.config.challenges[0]!, values: ['token-test-123456'] }],
      () => undefined,
    );
    assert.equal(operations.length, 2);
    assert.equal(operations[0]?.name, config.challenges[0]);
    assert.equal(operations[0]?.values.length, 1);
    assert.deepEqual(operations[1]?.values, []);
    assert.equal(await store.journal(), null);
  });
});

test('successful ACME flow publishes two tokens in one call before validating', async () => {
  await fixture(async ({ app, operations, store, config }) => {
    const events: string[] = [];
    app.provider = {
      async createOrder() {
        events.push('order');

        return {
          challenges: [
            { name: config.challenges[0]!, value: 'token-abc123456' },
            { name: config.challenges[0]!, value: 'token-def123456' },
          ],
          async validate() {
            assert.deepEqual(operations[0]?.values, ['token-abc123456', 'token-def123456']);
            events.push('validate');
          },
          async finalize() {
            events.push('finalize');

            return { key: 'mockkey', chain: 'mockchain' };
          },
        };
      },
    };
    app.saveCertificate = async () => ({
      current: '/output/current',
      certificate: { validTo: '2030-01-01' },
    });
    await app.issue('staging');
    assert.deepEqual(events, ['order', 'validate', 'finalize']);
    assert.deepEqual(
      operations.map((x) => x.values.length),
      [2, 0],
    );
    assert.equal(await store.journal(), null);
  });
});

test('failed ACME authorization still removes known TXT and preserves original error', async () => {
  await fixture(async ({ app, operations, store, config }) => {
    app.provider = {
      async createOrder() {
        return {
          challenges: [{ name: config.challenges[0]!, value: 'token-abc123456' }],
          async validate() {
            throw Error('ACME validation failed');
          },
          async finalize() {
            throw Error('must not finalize');
          },
        };
      },
    };
    await assert.rejects(app.issue('staging'), /ACME validation failed/);
    assert.deepEqual(
      operations.map((x) => x.values.length),
      [1, 0],
    );
    assert.equal(await store.journal(), null);
  });
});

test('unknown Beget mutation outcome retains journal and does not issue another mutation', async () => {
  await fixture(async ({ app, beget, operations, store }) => {
    beget.replaceTXT = async () => {
      throw Error('Network timeout');
    };

    await assert.rejects(
      app.managedMany(
        [{ name: app.config.challenges[0]!, values: ['token-test-123456'] }],
        () => undefined,
      ),
      /Network timeout/,
    );
    assert.equal(operations.length, 0);
    assert.equal((await store.journal())?.phase, 'prepared');
  });
});

test('manual cleanup after crash handles known TXT; blocks foreign TXT', async () => {
  await fixture(async ({ app, setRecords, store, operations, config }) => {
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-abc123456'],
      phase: 'published',
    });
    setRecords(['token-abc123456', 'foreign-xyz123456']);
    await assert.rejects(app.cleanup(), (error) => errorCode(error) === 'DNS_FOREIGN_TXT');
    assert.equal(operations.length, 0);
    assert(await store.journal());
    setRecords(['token-abc123456']);
    await app.cleanup();
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0]?.values, []);
    assert.equal(await store.journal(), null);
  });
});

test('recovery does not delete TXT when DNS replicas disagree', async () => {
  await fixture(
    async ({ app, store, operations, config }) => {
      await store.writeJournal({
        name: config.challenges[0]!,
        values: ['token-abc123456'],
        phase: 'published',
      });
      app.query = async (_name, servers, types) =>
        servers.map((server, index) => ({
          server,
          records: Object.fromEntries(
            types.map((type) => [
              type,
              type === 'TXT' && index % 2 === 0 ? ['token-abc123456'] : [],
            ]),
          ),
        }));
      // Small test timeout; our production default is much longer.
      await assert.rejects(app.cleanup(), (error) => errorCode(error) === 'DNS_CLEANUP_TIMEOUT');
      assert.equal(operations.length, 0);
      assert(await store.journal());
    },
    { timeoutMs: 30 },
  );
});

test('status works offline without Beget credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-offline-'));

  try {
    const config = await loadConfig({
      ACME_DOMAINS: 'example.com,*.example.com',
      BEGET_ZONES: 'example.com',
      ACME_STATE_DIR: dir,
      ACME_OUTPUT_DIR: path.join(dir, 'output'),
    });
    const app = new Application(config, new OperationStore(config.stateDir), { logger });
    await assert.doesNotReject(app.status());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('empty DNS without acknowledged deletion MUST NOT erase an uncertain mutation journal', async () => {
  await fixture(async ({ app, store, operations, config }) => {
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-abc123456'],
      phase: 'published',
    });
    await assert.rejects(app.cleanup(), (error) => errorCode(error) === 'DNS_MUTATION_UNCERTAIN');
    assert.deepEqual(operations, []);
    assert(await store.journal());
  });
});

test('known acknowledged cleanup can finish when DNS is stably empty', async () => {
  await fixture(async ({ app, store, operations, config }) => {
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-abc123456'],
      phase: 'cleanup-requested',
    });
    await app.cleanup();
    assert.deepEqual(operations, []);
    assert.equal(await store.journal(), null);
  });
});

test('Beget readable panel containing an unknown record blocks destructive cleanup', async () => {
  await fixture(async ({ app, store, operations, config, setRecords, beget }) => {
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-abc123456'],
      phase: 'verified',
    });
    setRecords(['token-abc123456']);
    beget.describe = async () => ({
      readable: true,
      records: {
        A: [{ value: '192.0.2.1' }],
        TXT: [{ txtdata: 'token-abc123456' }],
      },
    });
    await assert.rejects(app.cleanup(), (error) => errorCode(error) === 'DNS_FOREIGN_RECORD');
    assert.equal(operations.length, 0);
    assert(await store.journal());
  });
});

test('cleanup resumes after deletion succeeded but its acknowledgement was not saved', async () => {
  await fixture(async ({ app, store, config, beget, setRecords }) => {
    const token = 'token-abc123456';
    await store.writeJournal({ name: config.challenges[0]!, values: [token], phase: 'verified' });
    setRecords([token]);

    beget.replaceTXT = async () => {
      assert.equal((await store.requireJournal()).phase, 'cleanup-started');
      setRecords([]);
      throw new Error('Connection lost after server applied deletion');
    };

    await assert.rejects(app.cleanup());
    assert.equal((await store.requireJournal()).phase, 'cleanup-started');

    app.query = async (_name, servers) => {
      assert.deepEqual(servers, config.nameservers);

      return servers.map((server) => ({ server, records: { TXT: [] } }));
    };

    await app.cleanup();
    assert.equal(await store.journal(), null);
  });
});

for (const phase of ['prepared', 'published', 'verified', 'cleanup-started', 'cleanup-requested']) {
  test(`service recovery cleans owned TXT left in ${phase}`, async () => {
    await fixture(async ({ app, store, config, setRecords, operations }) => {
      await store.writeJournal({ name: config.challenges[0]!, values: ['token-abc123456'], phase });
      setRecords(['token-abc123456']);
      await app.recover();
      assert.deepEqual(operations, [{ name: config.challenges[0]!, values: [] }]);
      assert.equal(await store.journal(), null);
      assert.equal(await store.lockInfo(), null);
    });
  });
}

test('startup recovery preserves foreign records and releases the OS lock', async () => {
  await fixture(async ({ app, store, config, setRecords, operations }) => {
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-abc123456'],
      phase: 'verified',
    });
    setRecords(['foreign-token-123456']);
    await assert.rejects(app.recover(), { code: 'DNS_FOREIGN_TXT' });
    assert.deepEqual(operations, []);
    assert(await store.journal());
    assert.equal(await store.lockInfo(), null);
  });
});
