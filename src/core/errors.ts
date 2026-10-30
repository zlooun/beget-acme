/** Error codes are part of the CLI contract: do not change without a migration. */
export class AppError extends Error {
  code: string;
  hint: string | undefined;
  retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    { hint, cause }: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
  }
}

/** Only expose sanitized provider/status information, never request bodies. */
export function messageFor(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // ACME libraries may include large HTTP responses in thrown errors.
  // Classify known cases without echoing untrusted response bodies or tokens.
  const raw = (error instanceof Error ? error.message : '').toLowerCase();

  if (raw.includes('nxdomain')) {
    return new AppError(
      'ACME_DNS_NXDOMAIN',
      'The CA could not resolve the DNS-01 TXT name (NXDOMAIN).',
      {
        hint: 'Verify DNS propagation, negative caching and the recovery journal before ordering again.',
        cause: error,
      },
    );
  }

  if (/rate.?limit|too many requests|too many failed authorizations|\b429\b/.test(raw)) {
    return new AppError('ACME_RATE_LIMIT', 'Certificate authority rate limit reached.', {
      hint: 'Do not retry repeatedly. Check CA rate-limit documentation and use staging for diagnostics.',
      cause: error,
    });
  }

  if (/unauthorized|incorrect txt|challenge.*invalid/.test(raw)) {
    return new AppError('ACME_VALIDATION_FAILED', 'The CA rejected the DNS challenge.', {
      hint: 'Use status and doctor to inspect records and ACME configuration.',
      cause: error,
    });
  }

  const code =
    error instanceof Error && 'code' in error && error.code === 'EACCES'
      ? 'FS_PERMISSION_DENIED'
      : 'UNEXPECTED_ERROR';
  const message =
    code === 'FS_PERMISSION_DENIED'
      ? 'Cannot access a state, output or secret file.'
      : 'Operation failed. Inspect logs and run `status` before retrying.';

  return new AppError(code, message, {
    hint:
      code === 'FS_PERMISSION_DENIED'
        ? 'Check ownership and permissions for the configured paths.'
        : 'Run `beget-acme status`; keep the recovery journal.',
    cause: error,
  });
}

export function fail(code: string, message: string, hint?: string): never {
  throw new AppError(code, message, { hint });
}
