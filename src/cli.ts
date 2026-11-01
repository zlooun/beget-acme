#!/usr/bin/env node
import { runService } from './core/service.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  approvedConfig,
  diagnosticConfig,
  checkDirectories,
  discoverZones,
  setup,
  prepareServiceConfig,
} from './core/setup.js';
import { loadConfig, requireCredentials } from './core/config.js';
import { OperationStore } from './core/store.js';
import { Application } from './core/application.js';
import { createLogger } from './core/logger.js';
import { fail, messageFor } from './core/errors.js';
import { errorCode, object } from './core/validation.js';

const raw = process.argv.slice(2);
const flags = new Set(raw.filter((arg) => arg.startsWith('-')));
const args = raw.filter((arg) => !arg.startsWith('-'));
const command = args[0] ?? 'run';
const logger = createLogger({ json: flags.has('--json') });
const controller = new AbortController();
let shutdownCode: number | undefined;

function stop(signal: NodeJS.Signals): void {
  shutdownCode = signal === 'SIGINT' ? 130 : 143;
  controller.abort();
}

function help(): void {
  process.stdout.write(`Beget ACME

Usage: beget-acme <command> [options]

Commands:
  run                     Issue if missing or renew if needed, then keep running (default)
  run --once              Issue or renew if needed, finish DNS cleanup, then exit
  schedule                Renew an existing production certificate automatically
  schedule --once         Renew an existing production certificate if needed, then exit
  issue [staging|production]
                          Issue or renew if needed, then exit; defaults to staging
  renew [staging|production]
                          Renew an existing certificate if needed; defaults to production
  status                  Read-only certificate, recovery and lock status
  doctor | probe          Read-only DNS and Beget diagnostics; probe is an alias
  setup                   Inspect DNS and save approval; no DNS writes or ACME orders
  cleanup                 Clean up journal-owned DNS records using the original config
  journal-clear           Archive a journal after empty-DNS checks and manual confirmation
  init                    Create .env without overwriting an existing file
  help                    Show this help

Options (flags may precede or follow the command):
  --once                  run/schedule: one full cycle, not a read-only check
  --staging               setup/run/status/doctor/probe/cleanup/journal-clear: use staging
  --accept-dns-replacement setup/run/schedule: confirm inspected, dedicated DNS names
  --dry-run               issue: DNS preflight without an account, order or DNS writes
  --check                 status: exit nonzero if the selected environment is not ready
  --json                  Format log events as JSON; errors use stderr
  --version, -V           Print package version
  --help, -h              Show this help

--once waits for DNS propagation, CA processing and cleanup within the current cycle.
It does not start another cycle after success or failure. Failures exit nonzero.
A persisted error retry deadline is respected: exit nonzero rather than wait or retry early.
A valid matching certificate outside its renewal window is kept, including with issue.
schedule/renew require an existing certificate; run/issue can perform initial issuance.
schedule always uses production; issue/renew take a positional environment, not --staging.
Other environment-aware commands use ACME_ENVIRONMENT (production by default) or --staging.

run/schedule accept --accept-dns-replacement or ACME_ACCEPT_DNS_REPLACEMENT=yes
to perform initial setup inline. Inspect dedicated DNS names before enabling it.
setup uses interactive confirmation or --accept-dns-replacement in a noninteractive terminal.
issue/renew/cleanup require approved configuration; --dry-run also requires approval.
journal-clear additionally requires ACME_CONFIRM_JOURNAL_CLEAR and ACME_JOURNAL_CLEAR_REASON.
Help and version output remain plain text even with --json.
Load configuration using node --env-file=.env dist/cli.js <command>.
`);
}

async function main(): Promise<void> {
  for (const flag of flags) {
    if (
      ![
        '--json',
        '--once',
        '--dry-run',
        '--check',
        '--version',
        '-V',
        '--help',
        '-h',
        '--staging',
        '--accept-dns-replacement',
      ].includes(flag)
    ) {
      fail('CLI_UNKNOWN_OPTION', `Unknown option: ${flag}.`);
    }
  }

  if (flags.has('--version') || flags.has('-V')) {
    const pkg = object(
      JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
      'PACKAGE_INVALID',
    );
    process.stdout.write(`${String(pkg.version)}\n`);

    return;
  }

  if (flags.has('--help') || flags.has('-h') || command === 'help') {
    help();

    return;
  }

  if (
    (flags.has('--once') && !['schedule', 'run'].includes(command)) ||
    (flags.has('--accept-dns-replacement') && !['setup', 'run', 'schedule'].includes(command)) ||
    (flags.has('--staging') &&
      !['setup', 'run', 'status', 'doctor', 'probe', 'cleanup', 'journal-clear'].includes(
        command,
      )) ||
    (flags.has('--check') && command !== 'status') ||
    (flags.has('--dry-run') && command !== 'issue')
  ) {
    fail('CLI_INVALID_OPTION', 'This option does not apply to the selected command.');
  }

  const positionalLimit = ['issue', 'renew'].includes(command) ? 2 : 1;

  if (args.length > positionalLimit) {
    fail('CLI_INVALID_ARGUMENT', 'Unexpected positional argument.');
  }

  if (command === 'init') {
    const contents = await fs.readFile(new URL('../.env.example', import.meta.url));

    try {
      await fs.writeFile(path.resolve('.env'), contents, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        fail('CONFIG_FILE_EXISTS', '.env already exists; it was not overwritten.');
      }

      throw error;
    }

    logger.info('Created .env. Set domains, email and Beget credentials, then run setup.');

    return;
  }

  if (
    ![
      'setup',
      'run',
      'doctor',
      'probe',
      'status',
      'cleanup',
      'journal-clear',
      'issue',
      'renew',
      'schedule',
    ].includes(command)
  ) {
    fail('CLI_UNKNOWN_COMMAND', `Unknown command: ${command}.`);
  }

  if (
    ['issue', 'renew'].includes(command) &&
    args[1] &&
    !['staging', 'production'].includes(args[1])
  ) {
    fail('ACME_ENVIRONMENT_INVALID', 'Use staging or production.');
  }

  const environment = flags.has('--staging')
    ? 'staging'
    : ['issue', 'renew'].includes(command)
      ? (args[1] ?? (command === 'issue' ? 'staging' : 'production'))
      : command === 'schedule'
        ? 'production'
        : process.env.ACME_ENVIRONMENT || 'production';
  const rawConfig = await loadConfig({ ...process.env, ACME_ENVIRONMENT: environment });

  if (command === 'setup') {
    await setup(rawConfig, {
      logger,
      signal: controller.signal,
      confirm: async () => {
        if (flags.has('--accept-dns-replacement')) {
          return true;
        }

        if (!process.stdin.isTTY || flags.has('--json')) {
          fail(
            'SETUP_CONFIRMATION_REQUIRED',
            'Inspect the listed DNS names in Beget, then run setup --accept-dns-replacement (add --staging for staging).',
          );
        }

        const terminal = createInterface({ input: process.stdin, output: process.stderr });

        try {
          return (
            (
              await terminal.question(
                'Type CONFIRM to authorize the displayed DNS names and environment: ',
                { signal: controller.signal },
              )
            ).trim() === 'CONFIRM'
          );
        } finally {
          terminal.close();
        }
      },
    });

    return;
  }

  const acceptReplacement =
    flags.has('--accept-dns-replacement') || process.env.ACME_ACCEPT_DNS_REPLACEMENT === 'yes';

  if (command === 'run' || command === 'schedule') {
    // Validate purely local inputs before entering a persistent operational retry loop.
    requireCredentials(rawConfig);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawConfig.email)) {
      fail('ACME_EMAIL_INVALID', 'Set a valid ACME_EMAIL.');
    }

    const serviceStore = new OperationStore(rawConfig.stateDir, rawConfig.environment);
    let service: Application | undefined;
    await runService(rawConfig, serviceStore, {
      once: flags.has('--once'),
      logger,
      signal: controller.signal,
      recover: async () => {
        const prepared = await prepareServiceConfig(rawConfig, acceptReplacement, {
          logger,
          signal: controller.signal,
        });
        await checkDirectories(prepared);
        service = new Application(prepared, serviceStore, {
          logger,
          signal: controller.signal,
        });
        await service.recover(prepared.environment);
      },
      work: async () => {
        if (!service) {
          fail('SERVICE_NOT_PREPARED', 'Service configuration has not been prepared.');
        }

        await service.renewalCheck({
          initialIssue: command === 'run',
          environment: rawConfig.environment,
        });
      },
    });

    return;
  }

  const diagnostic = ['status', 'doctor', 'probe'].includes(command)
    ? await diagnosticConfig(rawConfig, logger)
    : undefined;
  let config = diagnostic?.config ?? (await approvedConfig(rawConfig));
  const store = new OperationStore(config.stateDir, config.environment);

  if (
    ['doctor', 'probe', 'issue', 'renew', 'schedule', 'cleanup', 'journal-clear'].includes(
      command,
    ) &&
    !config.zones.length
  ) {
    const diagnostic = new Application(config, store, { logger, signal: controller.signal });
    config = { ...config, zones: await discoverZones(config, diagnostic.requireBeget()) };
  }

  const app = new Application(config, store, { logger, signal: controller.signal });

  if (flags.has('--dry-run') && command === 'issue') {
    await app.dryRun(args[1] ?? 'staging');

    return;
  }

  switch (command) {
    case 'doctor':
    case 'probe':
      await app.doctor();
      break;
    case 'status':
      await app.status(flags.has('--check'));

      if (flags.has('--check') && diagnostic && !diagnostic.approvalReady) {
        fail('STATUS_NOT_READY', 'Saved approval does not match the selected configuration.');
      }

      break;
    case 'cleanup':
      await store.locked(() => app.cleanup());
      break;
    case 'journal-clear':
      await store.locked(() =>
        app.clearJournalConfirmed(
          process.env.ACME_CONFIRM_JOURNAL_CLEAR ?? '',
          process.env.ACME_JOURNAL_CLEAR_REASON ?? '',
        ),
      );
      break;
    case 'issue':
      await store.locked(() => app.issue(args[1] ?? 'staging'));
      break;
    case 'renew':
      await store.locked(() => app.issue(args[1] ?? 'production', true));
      break;
  }
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  await main();
} catch (error) {
  const safe = messageFor(error);
  logger.error(`[${safe.code}] ${safe.message}`, { code: safe.code, hint: safe.hint });

  if (safe.hint) {
    logger.error(`Next step: ${safe.hint}`);
  }

  process.exitCode = 1;
} finally {
  // Release happens in OperationStore.locked after outstanding work has unwound.
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);

  if (shutdownCode !== undefined) {
    process.exitCode = shutdownCode;
  }
}
