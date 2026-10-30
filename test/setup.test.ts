import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, authorizeWrite } from '../src/core/config.js';
import {
  approvedConfig,
  checkDirectories,
  discoverZones,
  setup,
  prepareServiceConfig,
} from '../src/core/setup.js';
import { OperationStore } from '../src/core/store.js';
import { AppError } from '../src/core/errors.js';
import type { BegetProvider } from '../src/providers/beget.js';
import type { DnsQuery } from '../src/dns/verify.js';

const logger = { info() {}, warn() {}, error() {} };
const empty: DnsQuery = async (_name, servers) =>
  servers.map((server) => ({ server, records: {} }));

async function fixture(work: (value: Awaited<ReturnType<typeof context>>) => Promise<void>) {
  const value = await context();

  try {
    await work(value);
  } finally {
    await fs.rm(value.dir, { recursive: true, force: true });
  }
}

async function context() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-setup-'));
  const config = await loadConfig({
    ACME_DOMAINS: 'api.example.co.uk,*.apps.other.net',
    ACME_EMAIL: 'admin@example.com',
    BEGET_USERNAME: 'test',
    BEGET_PASSWORD: 'test',
    ACME_STATE_DIR: path.join(dir, 'state'),
    ACME_OUTPUT_DIR: path.join(dir, 'output'),
  });
  const visited: string[] = [];
  const provider: BegetProvider = {
    async assertRootZone(fqdn) {
      visited.push(fqdn);

      if (!['example.co.uk', 'other.net'].includes(fqdn)) {
        throw new AppError('BEGET_ROOT_NOT_MANAGED', 'Missing zone', { cause: 'zone-unavailable' });
      }

      return { fqdn, is_beget_dns: true, is_under_control: true };
    },
    async describe() {
      return { readable: false, records: null };
    },
    async replaceTXT() {
      assert.fail('Setup must never write DNS');
    },
  };

  return { dir, config, visited, provider };
}

test('zone discovery checks ancestors through Beget instead of assuming two labels', async () => {
  await fixture(async ({ config, provider, visited }) => {
    assert.deepEqual(config.zones, []);
    assert.deepEqual(await discoverZones(config, provider), ['example.co.uk', 'other.net']);
    assert(visited.includes('api.example.co.uk'));
    assert(!visited.includes('co.uk'));
  });
});

test('zone discovery does not swallow authentication or transport failures', async () => {
  await fixture(async ({ config, provider }) => {
    for (const code of ['BEGET_NETWORK_ERROR', 'BEGET_ROOT_NOT_MANAGED', 'BEGET_BAD_RESPONSE']) {
      provider.assertRootZone = async () => {
        throw new AppError(code, 'Denied', { cause: 'provider-error' });
      };

      await assert.rejects(discoverZones(config, provider), { code });
    }
  });
});

test('setup requires confirmation, persists scope and never writes DNS or account keys', async () => {
  await fixture(async ({ config, provider }) => {
    await assert.rejects(approvedConfig(config, true), { code: 'SETUP_REQUIRED' });
    const options = { logger, provider, dnsQuery: empty, confirm: async () => false };
    await assert.rejects(setup(config, options), { code: 'SETUP_NOT_CONFIRMED' });
    await assert.rejects(fs.stat(path.join(config.stateDir, 'setup.json')), { code: 'ENOENT' });
    await setup(config, {
      ...options,
      confirm: async (description) => description.includes('_acme-challenge.api.example.co.uk'),
    });
    const approved = await approvedConfig(config, true);
    assert.equal(approved.canProduction, true);

    for (const name of approved.challenges) {
      assert.doesNotThrow(() => authorizeWrite(approved, name));
    }

    // Setup keeps mutex files, but must not create account keys or a DNS journal.
    assert.deepEqual((await fs.readdir(config.stateDir)).sort(), [
      'operation-owner.json',
      'operation.sqlite',
      'setup.json',
    ]);
    assert.equal(await new OperationStore(config.stateDir).lockInfo(), null);
    await assert.rejects(approvedConfig({ ...config, domains: ['other.net'] }, true), {
      code: 'SETUP_CHANGED',
    });
    await assert.rejects(approvedConfig({ ...config, username: 'another-user' }, true), {
      code: 'SETUP_CHANGED',
    });
    await assert.rejects(approvedConfig({ ...config, zones: ['other.net'] }, true), {
      code: 'SETUP_CHANGED',
    });
  });
});

test('staging approval cannot authorize production; explicit setup can add production', async () => {
  await fixture(async ({ config, provider }) => {
    const staging = { ...config, environment: 'staging' as const };
    const options = { logger, provider, dnsQuery: empty, confirm: async () => true };
    await setup(staging, options);
    assert.equal((await approvedConfig(staging, true)).canProduction, false);
    await assert.rejects(approvedConfig(config, true), { code: 'SETUP_ENVIRONMENT' });
    await setup(config, options);
    assert.equal((await approvedConfig(config, true)).canProduction, true);
    assert.equal((await approvedConfig(staging, true)).canWrite, true);
  });
});

test('setup rejects pending recovery and occupied DNS before confirmation', async () => {
  await fixture(async ({ config, provider }) => {
    const store = new OperationStore(config.stateDir);
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-1234567890'],
      phase: 'prepared',
    });
    const options = {
      logger,
      provider,
      dnsQuery: empty,
      confirm: async () => {
        assert.fail('Must not confirm');
      },
    };
    await assert.rejects(setup(config, options), { code: 'DNS_RECOVERY_PENDING' });
    await store.clearJournal();
    const occupied: DnsQuery = async (_name, servers) =>
      servers.map((server) => ({ server, records: { TXT: ['foreign'] } }));
    await assert.rejects(setup(config, { ...options, dnsQuery: occupied }), {
      code: 'DNS_ZONE_NOT_EMPTY',
    });
  });
});

test('directory probe reports invalid output paths and leaves no probe files', async () => {
  await fixture(async ({ config }) => {
    await checkDirectories(config);
    assert.deepEqual(await fs.readdir(config.outputDir), []);
    const file = path.join(config.outputDir, 'file');
    await fs.writeFile(file, 'not a directory');
    await assert.rejects(checkDirectories({ ...config, outputDir: file }), {
      code: 'FS_PERMISSION_DENIED',
    });
  });
});

test('staging retry state is isolated from production', async () => {
  await fixture(async ({ config }) => {
    const production = new OperationStore(config.stateDir);
    const staging = new OperationStore(config.stateDir, 'staging');
    await staging.setRetry(0, 'ACME_VALIDATION_FAILED');
    assert.equal(await production.retryState(), null);
    assert.equal((await staging.retryState())?.code, 'ACME_VALIDATION_FAILED');
  });
});

test('one-command service setup requires consent and reuses matching approval offline', async () => {
  await fixture(async ({ config, provider }) => {
    const options = { logger, provider, dnsQuery: empty };
    await assert.rejects(prepareServiceConfig(config, false, options), { code: 'SETUP_REQUIRED' });
    const approved = await prepareServiceConfig(config, true, options);
    assert.equal(approved.canWrite, true);

    provider.assertRootZone = async () => {
      assert.fail('Matching setup must not repeat discovery');
    };

    assert.equal((await prepareServiceConfig(config, false, options)).canProduction, true);
  });
});

test('inline setup preserves recovery and environment guards', async () => {
  await fixture(async ({ config, provider }) => {
    const options = { logger, provider, dnsQuery: empty };
    const staging = { ...config, environment: 'staging' as const };
    await prepareServiceConfig(staging, true, options);
    await assert.rejects(prepareServiceConfig(config, false, options), {
      code: 'SETUP_ENVIRONMENT',
    });
    const store = new OperationStore(config.stateDir);
    await store.writeJournal({
      name: config.challenges[0]!,
      values: ['token-1234567890'],
      phase: 'prepared',
    });
    await assert.rejects(prepareServiceConfig(config, true, options), {
      code: 'DNS_RECOVERY_PENDING',
    });
    await store.clearJournal();
    assert.equal((await prepareServiceConfig(config, true, options)).canProduction, true);
  });
});
