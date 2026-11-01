import { errorCode, isRecord, object, strings } from './validation.js';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { AppError, fail } from './errors.js';

function permissionError(error: unknown): boolean {
  return (
    ['EACCES', 'EPERM'].includes(errorCode(error) ?? '') ||
    (error instanceof Error && error.cause !== undefined && permissionError(error.cause))
  );
}

function requireFileAccess(error: unknown): void {
  if (permissionError(error)) {
    throw new AppError(
      'FS_PERMISSION_DENIED',
      'Cannot access certificate files; automatic replacement is refused.',
      {
        cause: error,
        hint: 'Repair ownership, directory traversal permissions and ACLs before retrying.',
      },
    );
  }
}

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
      requireFileAccess(cause);

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
    requireFileAccess(error);

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
    requireFileAccess(error);

    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }

    throw new AppError(
      'CERT_PUBLICATION_INVALID',
      'Pending certificate publication marker is unreadable or invalid.',
      { cause: error },
    );
  }

  const version = pending.version;

  if (typeof version !== 'string' || !/^cert-[a-zA-Z0-9-]+$/.test(version)) {
    fail('CERT_PUBLICATION_INVALID', 'Invalid pending certificate version.');
  }

  const target = path.join(dir, version);
  const certificate = await readVersion(target, domain);
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

    await switchCertificateLink(tempLink, current);
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

/** Replace only a pointer, never recursively delete an unexpected real directory. */
export async function switchCertificateLink(
  temporary: string,
  current: string,
  windows = process.platform === 'win32',
  rename: typeof fs.rename = fs.rename,
) {
  const previous = `${current}.previous`;

  const linkExists = async (file: string) => {
    try {
      const stat = await fs.lstat(file);

      if (!stat.isSymbolicLink()) {
        fail(
          'CERT_POINTER_INVALID',
          'Certificate pointer must be a symbolic link or junction; unexpected files are preserved.',
        );
      }

      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }

      throw error;
    }
  };

  const exists = await linkExists(current);

  if (!windows) {
    await rename(temporary, current);

    return;
  }

  // A recorded pending publication survives crashes across both renames.
  const backupExists = await linkExists(previous);

  if (exists) {
    if (backupExists) {
      await fs.unlink(previous);
    }

    await rename(current, previous);
  }

  try {
    await rename(temporary, current);
  } catch (error) {
    if (exists || backupExists) {
      await rename(previous, current).catch(() => undefined);
    }

    throw error;
  }

  if (exists || backupExists) {
    await fs.unlink(previous);
  }
}

/** Inspect only regular files in a direct, non-symlinked version directory. */
async function readVersion(target: string, domains: string | string[]) {
  try {
    if (!(await fs.lstat(target)).isDirectory() || (await fs.lstat(target)).isSymbolicLink()) {
      fail('CERT_PUBLICATION_INVALID', 'Certificate version must be a regular directory.');
    }

    for (const name of ['privkey.pem', 'fullchain.pem']) {
      const stat = await fs.lstat(path.join(target, name));

      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) {
        fail('CERT_PUBLICATION_INVALID', 'Certificate version contains an invalid file.');
      }
    }

    const key = await fs.readFile(path.join(target, 'privkey.pem'));
    const chain = await fs.readFile(path.join(target, 'fullchain.pem'));

    return validateCertificate(key, chain, domains);
  } catch (error) {
    requireFileAccess(error);
    throw error;
  }
}

/** Repair a missing/broken pointer from validated local versions before ordering again. */
export async function recoverCertificateState(
  dir: string,
  domains: string[],
  warn: (message: string) => void,
) {
  let pendingError: unknown;

  try {
    const restored = await recoverCertificatePublication(dir, domains);

    if (restored) {
      return restored;
    }
  } catch (error) {
    requireFileAccess(error);

    if (
      ![
        'CERT_PUBLICATION_INVALID',
        'CERT_SAN_MISMATCH',
        'CERT_KEY_MISMATCH',
        'CERT_INVALID',
        'CERT_EXPIRED',
        'CERT_NOT_YET_VALID',
        'ENOENT',
      ].includes(errorCode(error) ?? '')
    ) {
      throw error;
    }

    pendingError = error;
  }

  const current = path.join(dir, 'current');
  let currentExists = false;
  let currentIsLink = false;

  try {
    const pointer = await fs.lstat(current);
    currentExists = true;
    currentIsLink = pointer.isSymbolicLink();

    if (!pointer.isSymbolicLink()) {
      // File-manager copies sometimes turn the pointer into an empty directory.
      if (!pointer.isDirectory() || (await fs.readdir(current)).length) {
        fail(
          'CERT_POINTER_INVALID',
          'Unexpected object at current; preserve it and inspect the output directory.',
        );
      }
    }

    if (pointer.isSymbolicLink()) {
      const target = await fs.realpath(current);

      if (
        path.dirname(target) !== (await fs.realpath(dir)) ||
        !/^cert-[a-zA-Z0-9-]+$/.test(path.basename(target))
      ) {
        fail(
          'CERT_POINTER_INVALID',
          'Current points outside a direct certificate version in this environment.',
        );
      }

      const status = await certificateStatus(path.join(current, 'fullchain.pem'));

      if (status.present && !pendingError) {
        return undefined;
      }
    }
  } catch (error) {
    requireFileAccess(error);

    if (
      !['ENOENT', 'CERT_KEY_UNREADABLE', 'CERT_KEY_MISMATCH', 'CERT_READ_FAILED'].includes(
        errorCode(error) ?? '',
      )
    ) {
      throw error;
    }
  }

  const candidates: { version: string; validFrom: number; validTo: number }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }

    requireFileAccess(error);
    throw error;
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^cert-[a-zA-Z0-9-]+$/.test(entry.name)) {
      continue;
    }

    try {
      const cert = await readVersion(path.join(dir, entry.name), domains);

      if (Date.parse(cert.validFrom) <= Date.now()) {
        candidates.push({
          version: entry.name,
          validFrom: Date.parse(cert.validFrom),
          validTo: Date.parse(cert.validTo),
        });
      }
    } catch (error) {
      requireFileAccess(error);

      if (
        ![
          'ENOENT',
          'CERT_PUBLICATION_INVALID',
          'CERT_SAN_MISMATCH',
          'CERT_KEY_MISMATCH',
          'CERT_INVALID',
          'CERT_EXPIRED',
          'CERT_NOT_YET_VALID',
        ].includes(errorCode(error) ?? '')
      ) {
        throw error;
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.validFrom - a.validFrom || b.validTo - a.validTo || b.version.localeCompare(a.version),
  );
  const selected = candidates[0];

  if (pendingError && !selected) {
    throw new AppError(
      'CERT_RECOVERY_REQUIRED',
      'Pending publication is invalid and no matching valid local certificate is available.',
      {
        cause: pendingError,
        hint: 'Preserve pending-publication.json and version directories. Inspect permissions and restore a trusted backup before authorizing a new publication.',
      },
    );
  }

  if (!selected && !currentExists) {
    return undefined;
  }

  const suffix = `${Date.now()}-${randomBytes(8).toString('hex')}`;

  if (pendingError) {
    await fs.rename(
      path.join(dir, 'pending-publication.json'),
      path.join(dir, `publication-quarantine-${suffix}.json`),
    );
    await syncDirectory(dir);
    warn(
      'Recovery: preserved invalid publication marker; restoring a validated local certificate.',
    );
  }

  if (selected) {
    await atomicWrite(
      path.join(dir, 'pending-publication.json'),
      JSON.stringify({ version: selected.version }),
    );
  }

  if (currentExists && (!selected || !currentIsLink)) {
    // Preserve the pointer/empty directory, never move or delete its target files.
    await fs.rename(current, path.join(dir, `current-quarantine-${suffix}`));
    await syncDirectory(dir);
  }

  if (!selected) {
    warn(
      'Recovery: preserved broken current pointer; no matching local pair exists. Initial issuance mode may request a new certificate.',
    );

    return undefined;
  }

  warn(`Recovery: restoring validated local version ${selected.version} without a new ACME order.`);

  return recoverCertificatePublication(dir, domains);
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
