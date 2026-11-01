import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError, fail } from '../core/errors.js';
import { errorCode } from '../core/validation.js';
import { accountSigner } from './crypto.js';

/** Never follow an account-key symlink or replace a damaged account identity. */
export async function readAccountKey(file: string): Promise<Buffer> {
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('ACME_ACCOUNT_KEY_FILE', 'Account key must be a regular file, not a symbolic link.');
  }

  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fail('ACME_ACCOUNT_KEY_FILE', 'Account key changed while being opened.');
    }

    if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
      fail(
        'ACME_ACCOUNT_KEY_PERMISSIONS',
        'Account key must be private to its owner.',
        'Set account.key permissions to 0600; never replace the account key to fix permissions.',
      );
    }

    // A bounded read also handles a file growing after the initial stat.
    const buffer = Buffer.alloc(65537);
    let bytesRead = 0;

    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);

      if (chunk.bytesRead === 0) {
        break;
      }

      bytesRead += chunk.bytesRead;
    }

    if (!bytesRead || bytesRead > 65536) {
      fail('ACME_ACCOUNT_KEY_FILE', 'Account key is empty or exceeds 64 KiB.');
    }

    const key = buffer.subarray(0, bytesRead);
    accountSigner(key);

    return key;
  } catch (cause) {
    if (cause instanceof AppError || ['EACCES', 'EPERM'].includes(errorCode(cause) ?? '')) {
      throw cause;
    }

    throw new AppError(
      'ACME_ACCOUNT_KEY',
      'Stored account key is invalid. Preserve it for inspection; do not automatically replace the account.',
      { cause },
    );
  } finally {
    await handle.close();
  }
}
