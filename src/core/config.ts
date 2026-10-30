import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { AppError, fail } from './errors.js';

export const DEFAULT_NAMESERVERS = Object.freeze([
  'ns1.beget.com',
  'ns2.beget.com',
  'ns1.beget.pro',
  'ns2.beget.pro',
]);

function domainName(value: string | undefined, field: string) {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

  if (
    name.length > 253 ||
    !name.includes('.') ||
    name
      .split('.')
      .some(
        (label) =>
          label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    fail(
      'CONFIG_INVALID_DOMAIN',
      `${field} must be an ASCII domain name with at least two labels.`,
      'Use a domain delegated to Beget nameservers. Convert IDN names to punycode first.',
    );
  }

  return name;
}

function integer(
  value: string | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
) {
  const raw = value === undefined || value === '' ? String(fallback) : String(value);

  if (!/^\d+$/.test(raw)) {
    fail('CONFIG_INVALID_NUMBER', `${field} must be an integer between ${min} and ${max}.`);
  }

  const n = Number(raw);

  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail('CONFIG_INVALID_NUMBER', `${field} must be an integer between ${min} and ${max}.`);
  }

  return n;
}

function csv(value: string | undefined, fallback: string, field: string) {
  const entries = (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!entries.length || new Set(entries).size !== entries.length) {
    fail('CONFIG_INVALID_LIST', `${field} must be a unique non-empty comma-separated list.`);
  }

  if (entries.some((v) => !/^[a-z0-9.:-]+$/i.test(v))) {
    fail('CONFIG_INVALID_LIST', `Invalid address in ${field}.`);
  }

  return entries;
}

function privateKeyMode(value: string | undefined) {
  const text = value ?? '0600';

  if (text === '0600') {
    return 0o600;
  }

  if (text === '0640') {
    return 0o640;
  }

  fail('CONFIG_PRIVATE_KEY_MODE', 'ACME_PRIVATE_KEY_MODE must be 0600 or 0640.');
}

async function secret(env: NodeJS.ProcessEnv, name: string) {
  const filename = env[`${name}_FILE`];
  const direct = env[name];

  if (filename && direct) {
    fail('CONFIG_SECRET_CONFLICT', `Set either ${name} or ${name}_FILE, not both.`);
  }

  if (!filename) {
    return direct ?? '';
  }

  try {
    return (await readFile(filename, 'utf8')).replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
  } catch (cause) {
    throw new AppError('CONFIG_SECRET_FILE', `Cannot read ${name}_FILE.`, {
      hint: 'Check file path and permissions.',
      cause,
    });
  }
}

/** Reads all configuration at startup; no hidden process.env access in business logic. */
export async function loadConfig(env = process.env) {
  if (!env.ACME_DOMAINS) {
    fail('CONFIG_DOMAIN_REQUIRED', 'Set ACME_DOMAINS to the requested DNS identities.');
  }

  const domains = env.ACME_DOMAINS.split(',').map((value) => {
    const name = value.trim().toLowerCase();

    return name.startsWith('*.')
      ? '*' + '.' + domainName(name.slice(2), 'ACME_DOMAINS')
      : domainName(name, 'ACME_DOMAINS');
  });

  if (domains.length > 100 || new Set(domains).size !== domains.length) {
    fail('CONFIG_INVALID_LIST', 'ACME_DOMAINS must contain 1–100 distinct DNS identities.');
  }

  const requestedZones = env.BEGET_ZONES;
  const zones = requestedZones
    ? requestedZones.split(',').map((value) => domainName(value, 'BEGET_ZONES'))
    : [];

  if (new Set(zones).size !== zones.length) {
    fail('CONFIG_INVALID_LIST', 'BEGET_ZONES must contain distinct managed zones.');
  }

  const challenges = [
    ...new Set(domains.map((name) => `_acme-challenge.${name.replace(/^\*\./, '')}`)),
  ];

  if (zones.length) {
    for (const name of challenges) {
      zoneForName({ zones }, name);
    }
  }

  const consent = env.ACME_ACCEPT_DNS_REPLACEMENT === 'yes';
  const confirmedChallenges = consent ? [...challenges] : [];
  const timeoutMs = integer(env.ACME_DNS_TIMEOUT_MS, 900000, 'ACME_DNS_TIMEOUT_MS', 60000, 3600000);
  const cleanupSettleMs = integer(
    env.ACME_CLEANUP_SETTLE_MS,
    45000,
    'ACME_CLEANUP_SETTLE_MS',
    0,
    600000,
  );

  if (timeoutMs <= cleanupSettleMs + 30000) {
    fail(
      'CONFIG_DNS_TIMEOUT',
      'ACME_DNS_TIMEOUT_MS must exceed ACME_CLEANUP_SETTLE_MS by at least 30 seconds.',
    );
  }

  const environment = env.ACME_ENVIRONMENT || 'production';

  if (environment !== 'staging' && environment !== 'production') {
    fail('ACME_ENVIRONMENT_INVALID', 'ACME_ENVIRONMENT must be staging or production.');
  }

  return Object.freeze({
    environment,
    domains,
    zones,
    challenges,
    confirmedChallenges,
    username: await secret(env, 'BEGET_USERNAME'),
    password: await secret(env, 'BEGET_PASSWORD'),
    email: (env.ACME_EMAIL ?? '').trim(),
    canWrite: consent,
    canProduction: consent,
    nameservers: csv(env.BEGET_NAMESERVERS, DEFAULT_NAMESERVERS.join(','), 'BEGET_NAMESERVERS'),
    resolvers: csv(env.ACME_PUBLIC_RESOLVERS, '1.1.1.1,9.9.9.9', 'ACME_PUBLIC_RESOLVERS'),
    timeoutMs,
    cleanupSettleMs,
    privateKeyMode: privateKeyMode(env.ACME_PRIVATE_KEY_MODE),
    renewBeforeDays:
      env.ACME_RENEW_BEFORE_DAYS === undefined || env.ACME_RENEW_BEFORE_DAYS === ''
        ? undefined
        : integer(env.ACME_RENEW_BEFORE_DAYS, 10, 'ACME_RENEW_BEFORE_DAYS', 1, 3650),
    retryIntervalMs: integer(
      env.ACME_RETRY_INTERVAL_MS,
      3600000,
      'ACME_RETRY_INTERVAL_MS',
      60000,
      86400000,
    ),
    schedulerIntervalMs: integer(
      env.ACME_SCHEDULE_INTERVAL_MS,
      43200000,
      'ACME_SCHEDULE_INTERVAL_MS',
      3600000,
      86400000,
    ),
    stateDir: path.resolve(env.ACME_STATE_DIR || './state'),
    outputDir: path.resolve(env.ACME_OUTPUT_DIR || './output'),
  });
}

export type Config = Awaited<ReturnType<typeof loadConfig>>;

export function requireCredentials(config: Config) {
  if (!config.username || !config.password) {
    fail(
      'BEGET_CREDENTIALS_MISSING',
      'Beget API credentials are missing.',
      'Set BEGET_USERNAME and BEGET_PASSWORD (or *_FILE).',
    );
  }
}

export function authorizeWrite(config: Config, name: string) {
  if (!config.challenges.includes(name)) {
    fail('DNS_NAME_NOT_ALLOWED', `Refusing DNS mutation outside the configured names.`);
  }

  if (!config.canWrite) {
    fail(
      'DNS_WRITE_DISABLED',
      'DNS mutation is disabled.',
      'Run setup or set ACME_ACCEPT_DNS_REPLACEMENT=yes after inspecting dedicated DNS names.',
    );
  }

  if (config.challenges.includes(name) && !config.confirmedChallenges.includes(name)) {
    fail(
      'DNS_CONFIRMATION_REQUIRED',
      `Inspect dedicated ${name} in Beget DNS panel, then run setup or explicitly authorize DNS replacement.`,
    );
  }
}

export { domainName };

/** Select the longest explicit managed zone; never guess registrable domains. */
export function zoneForName(config: { zones: string[] }, name: string): string {
  const zone = [...config.zones]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => name.endsWith(`.${candidate}`));

  if (!zone) {
    fail('CONFIG_ZONE_MISSING', `No BEGET_ZONES entry manages ${name}.`);
  }

  return zone;
}
