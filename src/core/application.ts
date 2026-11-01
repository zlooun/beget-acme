import { createAcmeTransport } from '../acme/transport.js';
import { checkRunning, pause, cancellableTransport } from './shutdown.js';
import type { Config } from './config.js';
import type { Journal, OperationStore } from './store.js';
import type { AcmeProvider } from '../acme/types.js';
import type { BegetProvider } from '../providers/beget.js';
import type { DnsQuery } from '../dns/verify.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import { errorCode } from './validation.js';
import path from 'node:path';
import { authorizeWrite, requireCredentials, zoneForName } from './config.js';
import { AppError, fail, messageFor } from './errors.js';
import {
  certificateStatus,
  saveCertificate,
  recoverCertificateState,
  certificateNamesMatch,
} from './store.js';
import {
  queryServers,
  PREFLIGHT_TYPES,
  assertEmpty,
  assertExactTXT,
  waitForTXT,
} from '../dns/verify.js';
import { BegetClient } from '../providers/beget.js';
import { AcmeClientProvider } from '../acme/provider.js';

/** Dependency injection keeps the entire issuance/recovery flow unit-testable. */
type CertificateSaver = (
  key: string,
  chain: string,
  dir: string,
  domain: string | string[],
  mode: number,
) => Promise<{ current: string; certificate: { validTo: string } }>;
interface Dependencies {
  provider?: AcmeProvider;
  beget?: BegetProvider;
  dnsQuery?: DnsQuery;
  certificateSaver?: CertificateSaver;
  logger?: Logger;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}
export class Application {
  readonly signal?: AbortSignal;
  readonly sleep: (ms: number) => Promise<void>;
  readonly config: Config;
  readonly store: OperationStore;
  provider: AcmeProvider;
  beget: BegetProvider | null;
  query: DnsQuery;
  saveCertificate: CertificateSaver;
  readonly logger: Logger;

  constructor(
    config: Config,
    store: OperationStore,
    {
      provider,
      beget,
      signal,
      sleep = (ms) => pause(ms, signal),
      dnsQuery = queryServers,
      certificateSaver = saveCertificate,
      logger = createLogger(),
    }: Dependencies = {},
  ) {
    this.signal = signal;
    this.sleep = sleep;
    this.config = config;
    this.store = store;
    this.provider =
      provider ??
      new AcmeClientProvider({
        clientOptions: {
          fetchImpl: cancellableTransport(
            signal,
            createAcmeTransport((message) => logger.warn(message), undefined, config.stateDir, {
              ttlMs: config.tlsFallbackTtlMs,
            }),
          ),
          sleep,
        },
      });
    // Lazily create the live Beget client: status must work offline without credentials.
    this.beget = beget ?? null;

    this.query = async (...args) => {
      checkRunning(signal);
      const result = await dnsQuery(...args);
      checkRunning(signal);

      return result;
    };

    this.saveCertificate = certificateSaver;
    this.logger = logger;
  }

  requireBeget(): BegetProvider {
    if (this.beget) {
      return this.beget;
    }

    requireCredentials(this.config);
    this.beget = new BegetClient({
      transport: cancellableTransport(this.signal),
      username: this.config.username,
      password: this.config.password,
      allowedNames: this.config.challenges,
    });

    return this.beget;
  }

  async assertTargetEmpty(name: string) {
    const c = this.config;

    if (!c.challenges.includes(name)) {
      fail('DNS_NAME_NOT_ALLOWED', 'Target is not on the DNS allowlist.');
    }

    this.requireBeget();
    await this.requireBeget().assertRootZone(zoneForName(c, name));
    const description = await this.requireBeget().describe(name);

    if (
      description.readable &&
      Object.values(description.records).some((v) => Array.isArray(v) && v.length > 0)
    ) {
      fail('DNS_ZONE_NOT_EMPTY', 'Beget API reports existing DNS records.');
    }

    const records = await this.query(name, c.nameservers, PREFLIGHT_TYPES);
    assertEmpty(records);

    if (!description.readable) {
      this.logger.warn(
        `Beget getData does not provide a readable inventory for ${name}. Verify this dedicated zone is empty in the Beget panel.`,
      );
    }

    this.logger.info(
      `Preflight: ${name} is empty on ${c.nameservers.length} authoritative DNS servers.`,
    );
  }

  async doctor() {
    const c = this.config;
    this.requireBeget();

    for (const zone of c.zones) {
      const root = await this.requireBeget().assertRootZone(zone);
      this.logger.info(`Root ${root.fqdn}: managed by Beget and delegated to Beget DNS.`);
    }

    for (const name of c.challenges) {
      const description = await this.requireBeget().describe(name);
      this.logger.info(
        `${name}: Beget getData ${description.readable ? 'OK' : 'inventory unavailable'}`,
      );
      const records = await this.query(name, c.nameservers, PREFLIGHT_TYPES);

      for (const { server, records: rr } of records) {
        const counts =
          Object.entries(rr)
            .filter(([, values]) => values?.length)
            .map(([type, values]) => `${type}:${values?.length ?? 0}`)
            .join(', ') || 'empty';
        this.logger.info(`  ${server}: ${counts}`);
      }
    }

    this.logger.info('Read-only diagnostic complete. No DNS changes.');
  }

  async status(check = false) {
    let healthy = true;

    for (const environment of ['staging', 'production']) {
      const status = await certificateStatus(
        path.join(this.config.outputDir, environment, 'current', 'fullchain.pem'),
      );

      if (
        environment === this.config.environment &&
        (!status.present ||
          Date.parse(status.certificate.validTo) <= Date.now() ||
          Date.parse(status.certificate.validFrom) > Date.now() ||
          !certificateNamesMatch(status.certificate, this.config.domains))
      ) {
        healthy = false;
      }

      this.logger.info(
        `${environment}: ${status.present ? `${status.daysLeft} day(s) left; expires ${status.expires}` : 'no certificate'}`,
      );
    }

    const journal = await this.store.journal();
    this.logger.info(
      journal
        ? `RECOVERY REQUIRED: ${[journal.name, ...(journal.entries ?? []).map((entry) => entry.name)].join(', ')}; ${journal.values.length} TXT token(s), phase ${journal.phase ?? 'unknown'}. Run cleanup after inspecting DNS.`
        : 'No pending DNS journal.',
    );
    const lock = await this.store.lockInfo();
    const active = lock?.status === 'active';
    healthy &&= (!journal && !lock) || active;
    const lastCheck = await this.store.retryState();
    healthy &&= !lastCheck || lastCheck.code === 'OK';
    this.logger.info(
      lock ? `Operation lock exists: ${JSON.stringify(lock)}` : 'No operation lock.',
    );

    if (check && !healthy) {
      fail(
        'STATUS_NOT_READY',
        `${this.config.environment} certificate or recovery state requires attention.`,
      );
    }

    return healthy;
  }

  /**
   * Write ahead of mutation; if API times out, journal stays to prevent blind
   * retries. A cleanup failure must never obscure the original ACME error.
   */
  async managedMany(
    targets: { name: string; values: string[] }[],
    work: () => Promise<void> | void,
  ) {
    const c = this.config;

    for (const target of targets) {
      authorizeWrite(c, target.name);
    }

    if (await this.store.journal()) {
      fail(
        'DNS_RECOVERY_PENDING',
        'A DNS recovery journal already exists.',
        'Run status, doctor and cleanup before starting a new operation.',
      );
    }

    const entries: Journal[] = targets.map((target) => ({ ...target, phase: 'planned' }));

    const createdAt = new Date().toISOString();

    const persist = async () => {
      const [first, ...rest] = entries;

      if (!first) {
        fail('JOURNAL_INVALID', 'Empty operation.');
      }

      await this.store.writeJournal({
        ...first,
        entries: rest,
        version: 2,
        createdAt,
      });
    };

    await persist();

    for (const entry of entries) {
      checkRunning(this.signal);
      // Recheck each name immediately before its mutation, after order creation.
      await this.assertTargetEmpty(entry.name);
      // Persist intent before sending: even a failed response can hide a completed write.
      entry.phase = 'prepared';
      await persist();
      this.logger.info(
        `DNS publication: sending ${entry.values.length} TXT record(s) to Beget for ${entry.name}.`,
      );

      try {
        await this.requireBeget().replaceTXT(entry.name, entry.values);
      } catch (error) {
        this.logger.warn('Beget mutation outcome may be unknown. All recovery entries retained.');
        throw error;
      }

      entry.phase = 'published';
      await persist();
      this.logger.info(
        'DNS publication: Beget accepted the write; DNS visibility is checked next.',
      );
    }

    let workError: Error | undefined;

    try {
      for (const entry of entries) {
        await waitForTXT({
          name: entry.name,
          authoritative: c.nameservers,
          recursive: c.challenges.includes(entry.name) ? c.resolvers : [],
          expected: entry.values,
          timeoutMs: c.timeoutMs,
          stableMs: 0,
          query: this.query,
          logger: this.logger,
          signal: this.signal,
        });
        entry.phase = 'verified';
        await persist();
      }

      await work();
    } catch (error) {
      workError =
        error instanceof Error
          ? error
          : new AppError('UNEXPECTED_ERROR', 'DNS operation failed.', { cause: error });
    }

    checkRunning(this.signal);

    try {
      this.logger.info('DNS cleanup: verifying and removing the temporary journal-owned records.');
      await this.cleanup();
    } catch (cleanupError) {
      this.logger.error(
        `Cleanup not completed (${messageFor(cleanupError).code}); journal retained.`,
      );

      if (workError) {
        throw workError;
      }

      throw cleanupError;
    }

    if (workError) {
      throw workError;
    }
  }

  /**
   * An empty snapshot on one read is NOT proof that Beget applied deletion.
   * If servers disagree between old tokens and empty, wait for convergence.
   * Foreign records always block cleanup. No destructive writes on ambiguity.
   */
  async cleanup() {
    while (await this.store.journal()) {
      await this.cleanupEntry();
    }
  }

  private async cleanupEntry() {
    checkRunning(this.signal);
    const c = this.config;
    const journal = await this.store.journal();

    if (!journal) {
      return this.logger.info('No recovery journal.');
    }

    if (journal.phase === 'planned') {
      await this.store.finishJournalEntry();

      return;
    }

    const name = journal.name;
    authorizeWrite(c, journal.name);
    this.requireBeget();
    await this.requireBeget().assertRootZone(zoneForName(c, name));
    const expire = Date.now() + c.timeoutMs;
    let action: 'delete' | 'verify-empty' | null = null;

    while (Date.now() < expire) {
      const rows = await this.query(journal.name, c.nameservers, PREFLIGHT_TYPES);
      let allEmpty = true;
      let allExact = true;

      for (const row of rows) {
        // Unexpected records are never tolerated; prior tokens or empty are OK.
        for (const [type, entries] of Object.entries(row.records)) {
          if (type !== 'TXT' && entries?.length) {
            fail('DNS_FOREIGN_RECORD', `Unexpected ${type} on ${row.server}.`);
          }
        }

        const visible = row.records.TXT ?? [];

        if (
          visible.some((value) => !(typeof value === 'string' && journal.values.includes(value)))
        ) {
          fail(
            'DNS_FOREIGN_TXT',
            `Unexpected TXT on ${row.server}.`,
            'Do not overwrite foreign records.',
          );
        }

        if (visible.length) {
          allEmpty = false;
        }

        try {
          assertExactTXT([row], journal.values);
        } catch (error) {
          if (errorCode(error) !== 'DNS_NOT_PROPAGATED') {
            throw error;
          }

          allExact = false;
        }
      }

      if (allExact) {
        action = 'delete';
        break;
      }

      if (allEmpty) {
        action = 'verify-empty';
        break;
      }

      this.logger.info('Cleanup: DNS replicas disagree; waiting for consistency.');
      await this.sleep(Math.min(7000, Math.max(20, expire - Date.now())));
    }

    if (!action) {
      fail(
        'DNS_CLEANUP_TIMEOUT',
        'Authoritative DNS did not converge to a safe state.',
        'Leave the journal in place and retry cleanup after inspecting Beget DNS.',
      );
    }

    if (action === 'delete') {
      // getData is often unreadable for DNS-only subzones, but when it works,
      // a visible record set in the Beget panel must not be ignored.
      const panel = await this.requireBeget().describe(journal.name);

      if (panel.readable) {
        for (const [type, entries] of Object.entries(panel.records)) {
          if (!Array.isArray(entries) || !entries?.length) {
            continue;
          }

          if (type !== 'TXT') {
            fail('DNS_FOREIGN_RECORD', `Beget panel contains ${type} records; cleanup refused.`);
          }

          const values = entries.map((entry) => entry?.value ?? entry?.txtdata);

          if (
            values.some((value) => !(typeof value === 'string' && journal.values.includes(value)))
          ) {
            fail('DNS_FOREIGN_TXT', 'Beget panel contains an unknown TXT value; cleanup refused.');
          }
        }
      }

      this.logger.info(`Removing only the journal-owned TXT set at ${journal.name}.`);
      // The API can replace ALL record types. Never run without an exact match.
      checkRunning(this.signal);
      // Persist deletion intent after observing the complete owned TXT set.
      await this.store.writeJournal({ ...journal, phase: 'cleanup-started' });
      await this.requireBeget().replaceTXT(journal.name, []);
      await this.store.writeJournal({ ...journal, phase: 'cleanup-requested' });
    }

    if (action === 'verify-empty') {
      // Important: changeRecords can report success well before DNS converges.
      // Empty public DNS is *not* proof that an unacknowledged mutation didn't
      // happen or will not be published later. A recorded deletion intent
      // following an exact owned-set observation can finish here.
      if (journal.phase !== 'cleanup-requested' && journal.phase !== 'cleanup-started') {
        fail(
          'DNS_MUTATION_UNCERTAIN',
          `Operator inspection required: ${name}; phase ${journal.phase ?? 'unknown'}; operation created ${journal.createdAt ?? 'at an unknown time'}. TXT is absent but publication outcome is uncertain.`,
          `Keep the journal and original configuration. Inspect every journal name in Beget, run doctor and cleanup${c.environment === 'staging' ? ' --staging' : ''}. Only after panel inspection and DNS convergence, use journal-clear${c.environment === 'staging' ? ' --staging' : ''} with ACME_CONFIRM_JOURNAL_CLEAR listing ALL journal names and ACME_JOURNAL_CLEAR_REASON describing the inspection. Do not delete state files.`,
        );
      }

      this.logger.info(
        'Resuming deletion recovery; confirming sustained TXT absence on authoritative DNS.',
      );
    }

    await waitForTXT({
      name: journal.name,
      authoritative: c.nameservers,
      recursive: [],
      expected: [],
      permittedStale: journal.values,
      types: PREFLIGHT_TYPES,
      timeoutMs: c.timeoutMs,
      stableMs: c.cleanupSettleMs,
      query: this.query,
      logger: this.logger,
      signal: this.signal,
    });
    await this.store.finishJournalEntry();
    this.logger.info(`DNS cleanup complete for ${journal.name}.`);
  }

  async issue(environment: string, renewOnly = false) {
    const c = this.config;

    if (environment !== 'staging' && environment !== 'production') {
      fail('ACME_ENVIRONMENT_INVALID', 'Use `staging` or `production`.');
    }

    await recoverCertificateState(path.join(c.outputDir, environment), c.domains, (message) =>
      this.logger.warn(message),
    );

    if (environment === 'production' && !c.canProduction) {
      fail(
        'PRODUCTION_DISABLED',
        'Production issuance is disabled.',
        'After staging success, run setup for production or explicitly authorize DNS replacement.',
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
      fail('ACME_EMAIL_INVALID', 'Set a valid ACME_EMAIL.');
    }

    if (await this.store.journal()) {
      fail('DNS_RECOVERY_PENDING', 'A recovery journal exists. Run cleanup first.');
    }

    const certificateFile = path.join(c.outputDir, environment, 'current', 'fullchain.pem');
    const status = await certificateStatus(certificateFile);

    if (renewOnly && !status.present) {
      fail(
        'RENEW_CERT_MISSING',
        `No ${environment} certificate exists.`,
        'Run a one-time `issue` before starting the scheduler.',
      );
    }

    const namesMatch = status.present && certificateNamesMatch(status.certificate, c.domains);
    const renewalDays =
      c.renewBeforeDays ??
      (status.present
        ? (Date.parse(status.certificate.validTo) - Date.parse(status.certificate.validFrom)) /
          86400000 /
          3
        : 0);

    if (
      status.present &&
      namesMatch &&
      Date.parse(status.certificate.validFrom) <= Date.now() &&
      (Date.parse(status.certificate.validTo) - Date.now()) / 86400000 >= renewalDays
    ) {
      this.logger.info(
        `${environment}: valid certificate has ${status.daysLeft} days left; no renewal needed.`,
      );

      if (environment === this.store.environment) {
        await this.store.setRetry(0, 'OK');
      }

      return;
    }

    for (const name of c.challenges) {
      authorizeWrite(c, name);
      await this.assertTargetEmpty(name);
    }

    this.logger.info(
      `ACME order: registering or locating the ${environment} account, then ordering for ${c.domains.join(', ')}.`,
    );
    const order = await this.provider.createOrder({
      environment,
      domains: c.domains,
      email: c.email,
      stateDir: c.stateDir,
    });
    const groups = new Map<string, string[]>();

    for (const challenge of order.challenges) {
      if (!c.challenges.includes(challenge.name)) {
        fail('ACME_CHALLENGE_NAME', 'ACME provider returned unexpected DNS name.');
      }

      const values = groups.get(challenge.name) ?? [];

      if (!values.includes(challenge.value)) {
        values.push(challenge.value);
      }

      groups.set(challenge.name, values);
    }

    const finish = async () => {
      checkRunning(this.signal);
      this.logger.info('ACME validation: asking the CA to verify the domain authorizations.');
      await order.validate();
      this.logger.info('Certificate issuance: generating the CSR and requesting the certificate.');
      const { key, chain } = await order.finalize();
      checkRunning(this.signal);
      this.logger.info(
        'Certificate publication: validating the certificate and saving its key pair.',
      );
      const saved = await this.saveCertificate(
        key,
        chain,
        path.join(c.outputDir, environment),
        c.domains,
        c.privateKeyMode,
      );
      this.logger.info(
        `Certificate saved to ${saved.current}; expires ${saved.certificate.validTo}.`,
      );
      this.logger.info(
        'Reload your TLS server separately after successful certificate publication.',
      );
    };

    if (groups.size) {
      await this.managedMany(
        [...groups].map(([name, values]) => ({ name, values })),
        finish,
      );

      if (environment === this.store.environment) {
        await this.store.setRetry(0, 'OK');
      }

      this.logger.info(`${environment}: issuance and DNS cleanup completed successfully.`);

      return;
    }

    this.logger.info('All ACME authorizations are already valid.');
    await finish();

    if (environment === this.store.environment) {
      await this.store.setRetry(0, 'OK');
    }

    this.logger.info(`${environment}: issuance completed; no DNS publication was needed.`);
  }

  async dryRun(environment = 'staging') {
    if (!['staging', 'production'].includes(environment)) {
      fail('ACME_ENVIRONMENT_INVALID', 'Use staging or production.');
    }

    if (environment === 'production' && !this.config.canProduction) {
      fail('PRODUCTION_DISABLED', 'Production issuance is disabled.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.config.email)) {
      fail('ACME_EMAIL_INVALID', 'Set a valid ACME_EMAIL.');
    }

    if (await this.store.journal()) {
      fail('DNS_RECOVERY_PENDING', 'Recover the pending DNS operation first.');
    }

    for (const name of this.config.challenges) {
      authorizeWrite(this.config, name);
      await this.assertTargetEmpty(name);
    }

    this.logger.info('Dry run complete: no account, order, lock or DNS record was created.');
  }

  async clearJournalConfirmed(confirmation: string, reason: string) {
    const journal = await this.store.journal();

    if (!journal) {
      this.logger.info('No recovery journal.');

      return;
    }

    const entries = [journal, ...(journal.entries ?? [])];
    const names = entries.map((entry) => entry.name).sort();
    const confirmed = confirmation
      .split(',')
      .map((name) => name.trim())
      .sort();

    if (JSON.stringify(confirmed) !== JSON.stringify(names) || reason.trim().length < 10) {
      fail(
        'JOURNAL_CLEAR_NOT_CONFIRMED',
        'Set ACME_CONFIRM_JOURNAL_CLEAR to all journal names and ACME_JOURNAL_CLEAR_REASON to a meaningful inspection note.',
      );
    }

    for (const { name } of entries) {
      authorizeWrite(this.config, name);
      await this.assertTargetEmpty(name);
      await waitForTXT({
        name,
        authoritative: this.config.nameservers,
        recursive: [],
        expected: [],
        timeoutMs: this.config.timeoutMs,
        stableMs: this.config.cleanupSettleMs,
        types: PREFLIGHT_TYPES,
        query: this.query,
        logger: this.logger,
        signal: this.signal,
      });
      await this.assertTargetEmpty(name);
    }

    checkRunning(this.signal);
    await this.store.archiveJournal(reason.trim());
    this.logger.warn('Recovery journal archived by explicit operator confirmation.');
  }

  /** Recover under the operation lock before honoring issuance deadlines. */
  async recover(environment: string = this.config.environment) {
    await this.store.locked(() => this.recoverLocked(environment));
  }

  private async recoverLocked(environment: string) {
    if (!['staging', 'production'].includes(environment)) {
      fail('ACME_ENVIRONMENT_INVALID', 'Use staging or production.');
    }

    const restored = await recoverCertificateState(
      path.join(this.config.outputDir, environment),
      this.config.domains,
      (message) => this.logger.warn(message),
    );

    if (restored) {
      this.logger.info(
        'Recovery: completed pending certificate publication without a new ACME order.',
      );
    }

    if (await this.store.journal()) {
      this.logger.warn('Recovery: cleaning journal-owned DNS records before certificate checks.');
      await this.cleanup();
    }
  }

  async renewalCheck({ initialIssue = false, environment = 'production' } = {}) {
    requireCredentials(this.config);

    for (const name of this.config.challenges) {
      authorizeWrite(this.config, name);
    }

    await this.store.locked(async () => {
      await this.recoverLocked(environment);

      await this.issue(environment, !initialIssue);
    });
  }
}
