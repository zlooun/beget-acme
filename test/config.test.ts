import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, authorizeWrite } from '../src/core/config.js';

const env = {
  ACME_DOMAINS: 'mydomain.net,*.mydomain.net',
  BEGET_ZONES: 'mydomain.net',
  ACME_EMAIL: 'admin@mydomain.net',
};
test('general-purpose configuration accepts arbitrary Beget-hosted domains', async () => {
  const c = await loadConfig(env);
  assert.equal(c.challenges[0]!, '_acme-challenge.mydomain.net');
  assert.equal(c.timeoutMs, 900000);
  assert.equal(c.renewBeforeDays, undefined);
});

test('configuration rejects invalid domains, numbers, and test-zone escalation', async () => {
  await assert.rejects(loadConfig({ ...env, ACME_DOMAINS: 'localhost' }), /at least two labels/);
  await assert.rejects(loadConfig({ ...env, ACME_DNS_TIMEOUT_MS: 'NaN' }), /integer/);
  await assert.rejects(loadConfig({ ...env, ACME_RENEW_BEFORE_DAYS: '-1' }), /integer/);

  await assert.rejects(
    loadConfig({ ...env, BEGET_PASSWORD: 'abc', BEGET_PASSWORD_FILE: '/ignored' }),
    /either/,
  );
});

test('DNS writes require an exact name, explicit confirmation and opt-in', async () => {
  const c = await loadConfig(env);
  assert.throws(() => authorizeWrite(c, c.challenges[0]!), /disabled/);
  const writable = await loadConfig({ ...env, ACME_ACCEPT_DNS_REPLACEMENT: 'true' });
  assert.doesNotThrow(() => authorizeWrite(writable, writable.challenges[0]!));
  assert.throws(() => authorizeWrite(writable, 'mydomain.net'), /outside/);
  assert.throws(
    () => authorizeWrite({ ...writable, confirmedChallenges: [] }, writable.challenges[0]!),
    { code: 'DNS_CONFIRMATION_REQUIRED' },
  );
});

test('disabled inline consent does not grant DNS write permissions', async () => {
  for (const value of [undefined, 'false']) {
    const config = await loadConfig({ ...env, ACME_ACCEPT_DNS_REPLACEMENT: value });
    assert.equal(config.canWrite, false);
    assert.equal(config.canProduction, false);
    assert.deepEqual(config.confirmedChallenges, []);
    assert.throws(() => authorizeWrite(config, config.challenges[0]!), {
      code: 'DNS_WRITE_DISABLED',
    });
  }
});

test('DNS consent rejects values other than lowercase true and false', async () => {
  for (const value of ['', 'yes', 'no', 'TRUE', 'FALSE', '1', '0', ' true ']) {
    await assert.rejects(loadConfig({ ...env, ACME_ACCEPT_DNS_REPLACEMENT: value }), {
      code: 'CONFIG_DNS_CONSENT',
    });
  }
});

test('challenge prefix must fit within the DNS name length limit', async () => {
  const domain = [63, 63, 63, 50].map((length) => 'a'.repeat(length)).join('.');
  await assert.rejects(loadConfig({ ACME_DOMAINS: domain }), { code: 'CONFIG_CHALLENGE_NAME' });
});

test('file-based secrets trim only trailing newlines', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-secrets-'));

  try {
    const secretPath = path.join(dir, 'password.txt');
    await fs.writeFile(secretPath, '\uFEFF s3cr3t&= \r\n', { mode: 0o600 });
    const config = await loadConfig({ ...env, BEGET_PASSWORD_FILE: secretPath });
    assert.equal(config.password, ' s3cr3t&= ');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('explicit identities require explicit managed zones and exact confirmations', async () => {
  const config = await loadConfig({
    ACME_DOMAINS: 'api.example.com,*.apps.other.net',
    BEGET_ZONES: 'example.com,other.net',
    ACME_ACCEPT_DNS_REPLACEMENT: 'true',
  });
  assert.deepEqual(config.domains, ['api.example.com', '*.apps.other.net']);

  for (const name of config.challenges) {
    assert.doesNotThrow(() => authorizeWrite(config, name));
  }

  await assert.rejects(
    loadConfig({ ACME_DOMAINS: 'api.example.com', BEGET_ZONES: 'other.net' }),
    /No BEGET_ZONES/,
  );
  await assert.rejects(
    loadConfig({ ACME_DOMAINS: 'example.com,example.com', BEGET_ZONES: 'example.com' }),
    /distinct/,
  );

  await assert.rejects(
    loadConfig({
      ...env,
      ACME_DNS_TIMEOUT_MS: '60000',
      ACME_CLEANUP_SETTLE_MS: '600000',
    }),
    /ACME_CLEANUP_SETTLE_MS/,
  );
});

test('renewal threshold is optional and retry interval is configurable', async () => {
  const config = await loadConfig(env);
  assert.equal(config.renewBeforeDays, undefined);
  assert.equal(config.retryIntervalMs, 3600000);
  assert.equal(config.schedulerIntervalMs, 43200000);
  assert.equal((await loadConfig({ ...env, ACME_RENEW_BEFORE_DAYS: '10' })).renewBeforeDays, 10);

  for (const value of ['0', '-1', '1.5']) {
    await assert.rejects(loadConfig({ ...env, ACME_RENEW_BEFORE_DAYS: value }), /integer/);
  }

  await assert.rejects(loadConfig({ ...env, ACME_RETRY_INTERVAL_MS: '59999' }), /integer/);
});

test('TLS preference TTL defaults to seven days and validates overrides', async () => {
  assert.equal((await loadConfig(env)).tlsFallbackTtlMs, 604800000);
  assert.equal(
    (await loadConfig({ ...env, ACME_TLS_FALLBACK_TTL_MS: '2592000000' })).tlsFallbackTtlMs,
    2592000000,
  );

  for (const value of ['0', '-1', '1.5', '59999', '31536000001']) {
    await assert.rejects(loadConfig({ ...env, ACME_TLS_FALLBACK_TTL_MS: value }), /integer/);
  }
});
