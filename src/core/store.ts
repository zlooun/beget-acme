import { errorCode, isRecord, object, strings } from './validation.js';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { AppError, fail } from './errors.js';

/** Persist directory entries on POSIX; Windows does not expose directory fsync here. */
export async function syncDirectory(directory: string) {
  if (process.platform === 'win32') {
    return;
  }

  const handle = await fs.open(directory, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(file: string, data: string | Buffer, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode, flush: true });
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export interface Journal {
  entries?: Journal[];
  name: string;
  values: string[];
  phase?: string;
  version?: number;
  createdAt?: string;
}

export class OperationStore {
  readonly dir: string;
  readonly journalFile: string;
  readonly lockDir: string;

  constructor(
    dir: string,
    readonly environment: 'staging' | 'production' = 'production',
  ) {
    this.dir = dir;
    this.journalFile = path.join(dir, 'dns-operation.json');
    this.lockDir = path.join(dir, 'operation.lock');
  }

  async journal(): Promise<Journal | null> {
    let journal: Record<string, unknown>;

    try {
      journal = object(JSON.parse(await fs.readFile(this.journalFile, 'utf8')), 'JOURNAL_INVALID');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }

      fail(
        'JOURNAL_INVALID',
        'DNS recovery journal is unreadable or corrupted. Do not manually remove it.',
      );
    }

    if (
      typeof journal?.name !== 'string' ||
      !Array.isArray(journal?.values) ||
      journal.values.length < 1 ||
      journal.values.length > 10 ||
      journal.values.some(
        (v: unknown) => typeof v !== 'string' || !/^[-_a-zA-Z0-9]{10,256}$/.test(v),
      )
    ) {
      fail('JOURNAL_INVALID', 'DNS recovery journal has invalid fields.');
    }

    const phases = [
      'planned',
      'prepared',
      'published',
      'verified',
      'cleanup-started',
      'cleanup-requested',
    ];

    if (
      (journal.version !== undefined && journal.version !== 1 && journal.version !== 2) ||
      (journal.phase !== undefined &&
        (typeof journal.phase !== 'string' || !phases.includes(journal.phase))) ||
      new Set(journal.values).size !== journal.values.length
    ) {
      fail('JOURNAL_INVALID', 'Unknown journal version, phase or duplicate token.');
    }

    const entries: Journal[] = [];

    if (journal.entries !== undefined) {
      if (!Array.isArray(journal.entries) || journal.entries.length > 100) {
        fail('JOURNAL_INVALID', 'Invalid additional recovery entries.');
      }

      for (const value of journal.entries as unknown[]) {
        const entry = object(value, 'JOURNAL_INVALID');
        const values = strings(entry.values, 'JOURNAL_INVALID');

        if (
          typeof entry.name !== 'string' ||
          values.length < 1 ||
          values.length > 10 ||
          values.some((token) => !/^[-_a-zA-Z0-9]{10,256}$/.test(token)) ||
          entry.entries !== undefined ||
          new Set(values).size !== values.length ||
          typeof entry.phase !== 'string' ||
          !phases.includes(entry.phase)
        ) {
          fail('JOURNAL_INVALID', 'Invalid recovery entry.');
        }

        entries.push({ name: entry.name, values, phase: entry.phase });
      }
    }

    if (
      new Set([journal.name, ...entries.map((entry) => entry.name)]).size !==
      entries.length + 1
    ) {
      fail('JOURNAL_INVALID', 'Duplicate recovery names.');
    }

    return {
      ...(entries.length ? { entries } : {}),
      name: journal.name,
      values: strings(journal.values, 'JOURNAL_INVALID'),
      ...(typeof journal.phase === 'string' ? { phase: journal.phase } : {}),
      ...(typeof journal.version === 'number' ? { version: journal.version } : {}),
      ...(typeof journal.createdAt === 'string' ? { createdAt: journal.createdAt } : {}),
    };
  }

  async requireJournal(): Promise<Journal> {
    const journal = await this.journal();

    if (!journal) {
      fail('JOURNAL_MISSING', 'Recovery journal disappeared during an operation.');
    }

    return journal;
  }

  async writeJournal(journal: Journal) {
    await atomicWrite(this.journalFile, JSON.stringify(journal, null, 2) + '\n');
  }

  async finishJournalEntry() {
    const journal = await this.requireJournal();
    const [next, ...entries] = journal.entries ?? [];

    if (next) {
      await this.writeJournal({ ...next, entries, version: 2, createdAt: journal.createdAt });

      return;
    }

    await this.clearJournal();
  }

  async retryState(): Promise<{
    notBefore: number;
    code: string;
  } | null> {
    try {
      const state = object(
        JSON.parse(
          await fs.readFile(
            path.join(
              this.dir,
              this.environment === 'production'
                ? 'renewal-retry.json'
                : 'staging/renewal-retry.json',
            ),
            'utf8',
          ),
        ),
        'RETRY_STATE_INVALID',
      );

      if (
        typeof state.notBefore !== 'number' ||
        !Number.isSafeInteger(state.notBefore) ||
        typeof state.code !== 'string'
      ) {
        fail('RETRY_STATE_INVALID', 'Invalid persisted renewal delay.');
      }

      return {
        notBefore: state.notBefore,
        code: state.code,
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async setRetry(notBefore: number, code: string) {
    await atomicWrite(
      path.join(
        this.dir,
        this.environment === 'staging' ? 'staging/renewal-retry.json' : 'renewal-retry.json',
      ),
      JSON.stringify({ notBefore, code }),
    );
  }

  async lockIsActive(): Promise<boolean> {
    return (await this.lockInfo())?.status === 'active';
  }

  async archiveJournal(reason: string) {
    const journal = await this.requireJournal();
    await atomicWrite(
      path.join(
        this.dir,
        'recovery-archive',
        `${Date.now()}-${randomBytes(8).toString('hex')}.json`,
      ),
      JSON.stringify({ journal, reason, clearedAt: new Date().toISOString() }, null, 2),
    );
    await this.clearJournal();
  }

  async clearJournal() {
    await fs.rm(this.journalFile, { force: true });
    await syncDirectory(this.dir);
  }

  private async legacyLockExists(): Promise<boolean> {
    try {
      await fs.lstat(this.lockDir);

      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  private openMutex(): DatabaseSync {
    let db: DatabaseSync | undefined;

    try {
      db = new DatabaseSync(path.join(this.dir, 'operation.sqlite'), { timeout: 0 });
      // A persistent file must never be unlinked: all processes lock the same inode.
      db.exec('CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');

      return db;
    } catch (error) {
      db?.close();

      if (
        isRecord(error) &&
        typeof error.errcode === 'number' &&
        [5, 6].includes(error.errcode & 255)
      ) {
        fail('OPERATION_LOCKED', 'Another operation holds the system file lock. Retry later.');
      }

      throw new AppError('LOCK_STORAGE_INVALID', 'Cannot acquire the operation database lock.', {
        cause: error,
      });
    }
  }

  async lockInfo(): Promise<Record<string, unknown> | null> {
    if (await this.legacyLockExists()) {
      return { status: 'legacy lock requires inspection' };
    }

    try {
      await fs.stat(path.join(this.dir, 'operation.sqlite'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }

      throw error;
    }

    try {
      const probe = this.openMutex();
      probe.close();

      return null;
    } catch (error) {
      if (errorCode(error) !== 'OPERATION_LOCKED') {
        throw error;
      }

      try {
        const owner = object(
          JSON.parse(await fs.readFile(path.join(this.dir, 'operation-owner.json'), 'utf8')),
        );

        return { ...owner, status: 'active' };
      } catch {
        // Metadata is diagnostic only; the OS lock remains authoritative.
        return { status: 'active' };
      }
    }
  }

  /** SQLite holds an OS lock across the entire operation, including awaited requests. */
  async locked<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });

    if (await this.legacyLockExists()) {
      fail(
        'OPERATION_LOCKED',
        'An old operation.lock directory exists.',
        'Stop all older application versions, verify no operation is active, then remove the old operation.lock directory once.',
      );
    }

    // Exclusive creation sets private permissions without opening an existing locked inode.
    try {
      const initial = openSync(path.join(this.dir, 'operation.sqlite'), 'wx', 0o600);
      closeSync(initial);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }

    const db = this.openMutex();

    try {
      await atomicWrite(
        path.join(this.dir, 'operation-owner.json'),
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          started: new Date().toISOString(),
        }),
      );

      return await work();
    } finally {
      // Closing rolls back the empty transaction and releases even after work throws.
      // A killed process is released by the OS; leftover metadata cannot block recovery.
      db.close();
    }
  }
}

export async function certificateStatus(file: string) {
  try {
    const pem = await fs.readFile(file, 'utf8');
    const cert = new X509Certificate(pem);

    try {
      const key = await fs.readFile(path.join(path.dirname(file), 'privkey.pem'));
      const actual = createPublicKey(key).export({ type: 'spki', format: 'der' });

      if (!actual.equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) {
        fail('CERT_KEY_MISMATCH', 'Stored certificate and private key do not match.');
      }
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }

      throw new AppError(
        'CERT_KEY_UNREADABLE',
        'Stored certificate key is missing, unreadable or invalid.',
        { cause },
      );
    }

    return {
      present: true as const,
      subject: cert.subject,
      expires: cert.validTo,
      daysLeft: Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86400000),
      certificate: cert,
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { present: false as const };
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('CERT_READ_FAILED', `Certificate at ${file} could not be parsed.`, {
      cause: error,
    });
  }
}

export function validateCertificate(
  key: string | Buffer,
  chain: string | Buffer,
  domain: string | string[],
) {
  try {
    const cert = new X509Certificate(chain);
    const san = cert.subjectAltName ?? '';
    const names = san
      .split(/,\s*/)
      .filter((name) => name.startsWith('DNS:'))
      .map((name) => name.slice(4));

    const expected = typeof domain === 'string' ? [domain, `*.${domain}`] : domain;

    if (names.length !== expected.length || !expected.every((name) => names.includes(name))) {
      fail(
        'CERT_SAN_MISMATCH',
        'Issued certificate does not contain the exact requested DNS identities.',
      );
    }

    const keyPublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const certPublic = cert.publicKey.export({ type: 'spki', format: 'der' });

    if (!keyPublic.equals(certPublic)) {
      fail('CERT_KEY_MISMATCH', 'Certificate and private key do not match.');
    }

    if (new Date(cert.validTo).getTime() <= Date.now()) {
      fail('CERT_EXPIRED', 'Issued certificate is already expired.');
    }

    if (new Date(cert.validFrom).getTime() > Date.now() + 300000) {
      fail('CERT_NOT_YET_VALID', 'Certificate validity starts too far in the future.');
    }

    return cert;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('CERT_INVALID', 'Issued certificate could not be validated.', {
      cause: error,
    });
  }
}

/** Versioned immutable pairs plus a current pointer; never modify an active key in place. */
export async function saveCertificate(
  key: string | Buffer,
  chain: string | Buffer,
  dir: string,
  domain: string | string[],
  privateKeyMode = 0o600,
) {
  validateCertificate(key, chain, domain);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const version = `cert-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(8).toString('hex')}`;
  const target = path.join(dir, version);
  await fs.mkdir(target, { mode: 0o750 });
  await fs.writeFile(path.join(target, 'privkey.pem'), key, {
    mode: privateKeyMode,
    flag: 'wx',
    flush: true,
  });
  await fs.writeFile(path.join(target, 'fullchain.pem'), chain, {
    mode: 0o644,
    flag: 'wx',
    flush: true,
  });
  await syncDirectory(target);
  await syncDirectory(dir);
  await atomicWrite(path.join(dir, 'pending-publication.json'), JSON.stringify({ version }));

  const published = await recoverCertificatePublication(dir, domain);

  if (!published) {
    fail('CERT_PUBLICATION_INVALID', 'Pending publication disappeared.');
  }

  return published;
}

/** Resume only a recorded, fully written and validated certificate publication. */
export async function recoverCertificatePublication(dir: string, domain: string | string[]) {
  const marker = path.join(dir, 'pending-publication.json');
  let pending: Record<string, unknown>;

  try {
    pending = object(JSON.parse(await fs.readFile(marker, 'utf8')), 'CERT_PUBLICATION_INVALID');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  const version = pending.version;

  if (typeof version !== 'string' || !/^cert-[a-zA-Z0-9-]+$/.test(version)) {
    fail('CERT_PUBLICATION_INVALID', 'Invalid pending certificate version.');
  }

  const target = path.join(dir, version);
  const key = await fs.readFile(path.join(target, 'privkey.pem'));
  const chain = await fs.readFile(path.join(target, 'fullchain.pem'));
  const certificate = validateCertificate(key, chain, domain);
  const current = path.join(dir, 'current');

  try {
    if ((await fs.realpath(current)) === (await fs.realpath(target))) {
      // A crash after switching current only requires committing marker removal.
      await fs.rm(marker);
      await syncDirectory(dir);

      return { path: target, current, certificate };
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const tempLink = path.join(dir, `.current-${process.pid}-${randomBytes(8).toString('hex')}`);

  try {
    await fs.symlink(
      process.platform === 'win32' ? path.resolve(target) : version,
      tempLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    if (process.platform === 'win32') {
      // Windows junction replacement isn't atomic. Keep previous cert until the new one is valid.
      await fs.rm(current, { force: true, recursive: true });
    }

    await fs.rename(tempLink, current);
    await syncDirectory(dir);
  } catch (error) {
    await fs.rm(tempLink, { force: true, recursive: true });
    throw new AppError(
      'CERT_PUBLISH_FAILED',
      'New certificate was validated but the current link could not be switched.',
      {
        hint: `The new version remains at ${target}. Check filesystem and permissions.`,
        cause: error,
      },
    );
  }

  await fs.rm(marker);
  await syncDirectory(dir);

  return { path: target, current, certificate };
}

export function certificateNamesMatch(
  certificate: X509Certificate,
  expected: readonly string[],
): boolean {
  const names = (certificate.subjectAltName ?? '')
    .split(/,\s*/)
    .filter((name) => name.startsWith('DNS:'))
    .map((name) => name.slice(4));

  return names.length === expected.length && expected.every((name) => names.includes(name));
}
