import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { BegetProvider } from '../providers/beget.js';
import { domainName, requireCredentials } from './config.js';
import { AppError, fail } from './errors.js';
import { errorCode, object, strings } from './validation.js';
import { atomicWrite, OperationStore } from './store.js';
import { Application } from './application.js';
import type { Logger } from './logger.js';
import { checkRunning } from './shutdown.js';
import type { DnsQuery } from '../dns/verify.js';

interface Approval {
  fingerprint: string;
  zones: string[];
  environments: string[];
}

/** Bind approval to the actual DNS scope and account, never to the password. */
function fingerprint(config: Config): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domains: [...config.domains].sort(),
        zones: [...config.zones].sort(),
        username: config.username,
        nameservers: [...config.nameservers].sort(),
      }),
    )
    .digest('hex');
}

async function approval(config: Config): Promise<Approval | null> {
  try {
    const data = object(
      JSON.parse(await fs.readFile(path.join(config.stateDir, 'setup.json'), 'utf8')),
      'SETUP_INVALID',
    );
    const zones = strings(data.zones, 'SETUP_INVALID');
    const environments = strings(data.environments, 'SETUP_INVALID');

    if (
      data.version !== 1 ||
      typeof data.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
      !zones.length ||
      !environments.length ||
      environments.some((value) => !['staging', 'production'].includes(value))
    ) {
      fail('SETUP_INVALID', 'Saved setup is invalid. Inspect state and run setup again.');
    }

    for (const zone of zones) {
      domainName(zone, 'saved zone');
    }

    return { fingerprint: data.fingerprint, zones, environments };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/** Resolve approved configuration offline; runtime preflight still verifies provider control. */
export async function approvedConfig(config: Config, required = false): Promise<Config> {
  const saved = await approval(config);

  if (!saved) {
    if (required) {
      fail(
        'SETUP_REQUIRED',
        'Run setup or start run with --accept-dns-replacement after inspecting the dedicated DNS names.',
      );
    }

    return config;
  }

  if (saved.fingerprint !== fingerprint(config)) {
    fail(
      'SETUP_CHANGED',
      'Domains, zones, nameservers or Beget login changed. Complete recovery with the previous configuration, then run setup again.',
    );
  }

  const permitted = saved.environments.includes(config.environment);

  if (required && !permitted) {
    fail('SETUP_ENVIRONMENT', `Run setup for ${config.environment} before using this environment.`);
  }

  return {
    ...config,
    zones: saved.zones,
    canWrite: permitted,
    confirmedChallenges: permitted ? [...config.challenges] : [],
    canProduction: saved.environments.includes('production'),
  };
}

/** Try explicit DNS ancestors, accepting a zone only after the provider confirms control. */
export async function discoverZones(config: Config, provider: BegetProvider): Promise<string[]> {
  requireCredentials(config);

  if (config.zones.length) {
    for (const zone of config.zones) {
      await provider.assertRootZone(zone);
    }

    return config.zones;
  }

  const zones = new Set<string>();
  const checked = new Map<string, boolean>();

  for (const identity of config.domains) {
    const labels = identity.replace(/^\*\./, '').split('.');
    let selected: string | undefined;

    for (let index = 0; index < labels.length - 1; index++) {
      const candidate = labels.slice(index).join('.');
      let managed = checked.get(candidate);

      if (managed === undefined) {
        try {
          await provider.assertRootZone(candidate);
          managed = true;
        } catch (error) {
          // Authentication, transport and malformed responses must never be treated as missing zones.
          if (
            !(error instanceof AppError) ||
            error.code !== 'BEGET_ROOT_NOT_MANAGED' ||
            (error.cause !== 'zone-unavailable' && error.cause !== 'zone-not-controlled')
          ) {
            throw error;
          }

          managed = false;
        }

        checked.set(candidate, managed);
      }

      if (managed) {
        selected = candidate;
        break;
      }
    }

    if (!selected) {
      fail(
        'CONFIG_ZONE_MISSING',
        `Cannot establish a managed zone for ${identity}. Check Beget access or set BEGET_ZONES explicitly.`,
      );
    }

    zones.add(selected);
  }

  return [...zones].sort();
}

/** Probe real file creation/rename so read-only mounts and host ownership fail early. */
export async function checkDirectories(config: Config): Promise<void> {
  for (const [directory, mode] of [
    [config.stateDir, 0o700],
    [config.outputDir, 0o750],
  ] as const) {
    const probe = path.join(directory, `.permission-check-${randomUUID()}`);
    const renamed = `${probe}.renamed`;

    try {
      await fs.mkdir(directory, { recursive: true, mode });
      await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      await fs.rename(probe, renamed);
    } catch (cause) {
      throw new AppError(
        'FS_PERMISSION_DENIED',
        `Cannot create and rename files in ${directory}.`,
        {
          cause,
          hint: `Give the configured container user write access (UID ${process.getuid?.() ?? 'host ACL'}, GID ${process.getgid?.() ?? 'host ACL'}). Prepare bind-mount directories before starting the container.`,
        },
      );
    } finally {
      await fs.rm(probe, { force: true }).catch(() => undefined);
      await fs.rm(renamed, { force: true }).catch(() => undefined);
    }
  }
}

export async function setup(
  config: Config,
  {
    logger,
    signal,
    confirm,
    provider,
    dnsQuery,
  }: {
    logger: Logger;
    signal?: AbortSignal;
    confirm: (description: string) => Promise<boolean>;
    provider?: BegetProvider;
    dnsQuery?: DnsQuery;
  },
): Promise<void> {
  requireCredentials(config);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) {
    fail('ACME_EMAIL_INVALID', 'Set a valid ACME_EMAIL.');
  }

  await checkDirectories(config);
  const store = new OperationStore(config.stateDir, config.environment);
  await store.locked(async () => {
    if (await store.journal()) {
      fail('DNS_RECOVERY_PENDING', 'Complete DNS recovery before changing setup.');
    }

    const initial = new Application(config, store, { logger, signal, beget: provider, dnsQuery });
    const zones = await discoverZones(config, initial.requireBeget());
    const resolved = { ...config, zones };
    const app = new Application(resolved, store, {
      logger,
      signal,
      beget: initial.requireBeget(),
      dnsQuery,
    });
    const names = config.challenges;
    logger.info(`Setup: ${config.environment}; domains: ${config.domains.join(', ')}.`);
    logger.info(`Managed zones: ${zones.join(', ')}.`);
    logger.info(
      `Certificate directory: ${path.join(config.outputDir, config.environment, 'current')}.`,
    );

    for (const name of names) {
      await app.assertTargetEmpty(name);
    }

    const description = `Beget replaces ALL records at these names: ${names.join(', ')}. Confirm that you inspected them in the Beget panel and they are dedicated and empty. This authorizes ${config.environment} issuance and future renewals for the displayed domains.`;
    logger.warn(description);

    if (!(await confirm(description))) {
      fail(
        'SETUP_NOT_CONFIRMED',
        'Setup was not approved; no DNS mutation or ACME order was made.',
      );
    }

    checkRunning(signal);
    const previous = await approval(config);
    const environments = previous?.fingerprint === fingerprint(config) ? previous.environments : [];
    await atomicWrite(
      path.join(config.stateDir, 'setup.json'),
      JSON.stringify(
        {
          version: 1,
          fingerprint: fingerprint(config),
          zones,
          environments: [...new Set([...environments, config.environment])],
          confirmedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
    logger.info(
      'Setup saved. Start run; DNS and certificate issuance have not been changed by setup.',
    );
  });
}

/** Inline setup is explicitly authorized and retains all recovery and DNS checks. */
export async function prepareServiceConfig(
  config: Config,
  acceptReplacement: boolean,
  options: Omit<Parameters<typeof setup>[1], 'confirm'>,
): Promise<Config> {
  try {
    return await approvedConfig(config, true);
  } catch (error) {
    if (
      !acceptReplacement ||
      !(error instanceof AppError) ||
      !['SETUP_REQUIRED', 'SETUP_CHANGED', 'SETUP_ENVIRONMENT'].includes(error.code)
    ) {
      throw error;
    }
  }

  await setup(config, { ...options, confirm: () => Promise.resolve(true) });

  return approvedConfig(config, true);
}
