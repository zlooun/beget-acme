import { object } from '../core/validation.js';
import { fail } from '../core/errors.js';

export interface Identifier {
  type: string;
  value: string;
}
export interface Challenge {
  type: string;
  token: string;
  url: string;
}
export interface AcmeDocument {
  accountProblem?: 'deactivated' | 'revoked';
  status?: string;
  type?: string;
  newNonce?: string;
  newAccount?: string;
  newOrder?: string;
  finalize?: string;
  certificate?: string;
  identifiers?: Identifier[];
  identifier?: Identifier;
  authorizations?: string[];
  wildcard?: boolean;
  challenges?: Challenge[];
}

/** Validate consumed fields while allowing unrelated protocol extensions. */
export function parseDocument(value: unknown): AcmeDocument {
  const code = 'ACME_RESPONSE_INVALID';
  const data = object(value, code);
  const result: AcmeDocument = {};

  // Field paths are local labels, never values supplied by the CA.
  const fieldString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
      const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      fail(code, `Invalid ACME field ${field}: expected a string, received ${kind}.`);
    }

    return value;
  };

  // Recognize fixed account-state messages without retaining arbitrary CA detail.
  for (const state of ['deactivated', 'revoked'] as const) {
    if (data.detail === `An account with the provided public key exists but is ${state}`) {
      result.accountProblem = state;
    }
  }

  // Resource states are strings; problem documents may carry an HTTP status number.
  if (typeof data.status === 'string') {
    result.status = data.status;
  }

  if (
    data.status !== undefined &&
    typeof data.status !== 'string' &&
    !(
      typeof data.status === 'number' &&
      Number.isInteger(data.status) &&
      data.status >= 400 &&
      data.status <= 599
    )
  ) {
    fail(code, 'Invalid ACME status field.');
  }

  for (const key of [
    'type',
    'newNonce',
    'newAccount',
    'newOrder',
    'finalize',
    'certificate',
  ] as const) {
    if (data[key] !== undefined) {
      result[key] = fieldString(data[key], key);
    }
  }

  const identifier = (value: unknown, field: string): Identifier => {
    const entry = object(value, code);

    return {
      type: fieldString(entry.type, `${field}.type`),
      value: fieldString(entry.value, `${field}.value`),
    };
  };

  if (data.identifier !== undefined) {
    result.identifier = identifier(data.identifier, 'identifier');
  }

  if (data.identifiers !== undefined) {
    if (!Array.isArray(data.identifiers)) {
      fail(code, 'Invalid order identifiers.');
    }

    result.identifiers = data.identifiers.map((value: unknown, index: number) =>
      identifier(value, `identifiers[${index}]`),
    );
  }

  if (data.authorizations !== undefined) {
    if (!Array.isArray(data.authorizations)) {
      fail(code, 'Invalid ACME field authorizations: expected an array.');
    }

    result.authorizations = data.authorizations.map((value: unknown, index: number) =>
      fieldString(value, `authorizations[${index}]`),
    );
  }

  if (data.wildcard !== undefined) {
    if (typeof data.wildcard !== 'boolean') {
      fail(code, 'Invalid wildcard flag.');
    }

    result.wildcard = data.wildcard;
  }

  if (data.challenges !== undefined) {
    if (!Array.isArray(data.challenges)) {
      fail(code, 'Invalid challenge list.');
    }

    result.challenges = data.challenges.flatMap((value: unknown, index: number): Challenge[] => {
      const entry = object(value, code);
      const field = `challenges[${index}]`;
      const type = fieldString(entry.type, `${field}.type`);

      // Unused challenge types may have different schemas, including no token field.
      if (type !== 'dns-01') {
        return [];
      }

      return [
        {
          type,
          token: fieldString(entry.token, `${field}.token`),
          url: fieldString(entry.url, `${field}.url`),
        },
      ];
    });
  }

  return result;
}

export interface OrderOptions {
  environment: 'staging' | 'production';
  domains: string[];
  email: string;
  stateDir: string;
}
export interface CertificateMaterial {
  key: string;
  chain: string;
}
export interface AcmeOrder {
  challenges: { name: string; value: string }[];
  validate(): Promise<void>;
  finalize(): Promise<CertificateMaterial>;
}
export interface AcmeProvider {
  createOrder(options: OrderOptions): Promise<AcmeOrder>;
}
