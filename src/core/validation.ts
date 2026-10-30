import { fail } from './errors.js';

/** External JSON stays unknown until its structure has been validated. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function object(value: unknown, code = 'RESPONSE_INVALID'): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(code, 'Expected a JSON object.');
  }

  return value;
}

export function string(value: unknown, code = 'RESPONSE_INVALID'): string {
  if (typeof value !== 'string') {
    fail(code, 'Expected a string field.');
  }

  return value;
}

export function strings(value: unknown, code = 'RESPONSE_INVALID'): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    fail(code, 'Expected an array of strings.');
  }

  return value;
}

/** Node and DNS errors expose codes; external exceptions may have any shape. */
export function errorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }

  return undefined;
}

export type HttpTransport = (url: string, options: RequestInit) => Promise<Response>;
