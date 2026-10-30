import 'reflect-metadata';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { Pkcs10CertificateRequestGenerator, SubjectAlternativeNameExtension } from '@peculiar/x509';
const webcrypto = globalThis.crypto;
import { fail } from '../core/errors.js';

export const base64url = (value: string | ArrayBuffer | Uint8Array) =>
  (typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value)
  ).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

export function accountSigner(pem: string | Buffer) {
  const key = createPrivateKey(pem);
  const exported = createPublicKey(key).export({ format: 'jwk' });

  const parameters = () => {
    if (exported.kty === 'EC') {
      const algorithms: Record<string, [string, string]> = {
        'P-256': ['ES256', 'sha256'],
        'P-384': ['ES384', 'sha384'],
        'P-521': ['ES512', 'sha512'],
      };
      const selected = exported.crv ? algorithms[exported.crv] : undefined;

      if (!selected || !exported.crv || !exported.x || !exported.y) {
        fail('ACME_ACCOUNT_KEY', 'Unsupported account key curve.');
      }

      const [alg, hash] = selected;

      return { alg, hash, jwk: { crv: exported.crv, kty: 'EC', x: exported.x, y: exported.y } };
    }

    if (exported.kty === 'RSA') {
      if (!exported.e || !exported.n) {
        fail('ACME_ACCOUNT_KEY', 'Invalid RSA account key.');
      }

      return { alg: 'RS256', hash: 'sha256', jwk: { e: exported.e, kty: 'RSA', n: exported.n } };
    }

    fail('ACME_ACCOUNT_KEY', 'Unsupported account key type.');
  };

  const { jwk, alg, hash } = parameters();

  return {
    jwk,
    alg,
    thumbprint: sha256(JSON.stringify(jwk)),
    sign: (value: string) =>
      sign(hash, Buffer.from(value), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
}

export function createAccountKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

export async function createCertificateRequest(input: string | string[]) {
  const domains = typeof input === 'string' ? [input, `*.${input}`] : input;
  const domain = domains[0];

  if (!domain) {
    fail('ACME_IDENTIFIERS_EMPTY', 'At least one DNS identity is required.');
  }

  const keys = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const request = await Pkcs10CertificateRequestGenerator.create(
    {
      name: domain.length <= 64 ? `CN=${domain}` : '',
      keys,
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5' },
      extensions: [
        new SubjectAlternativeNameExtension(
          domains.map((value) => ({ type: 'dns' as const, value })),
        ),
      ],
    },
    webcrypto,
  );
  const key = createPrivateKey({
    key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
    format: 'der',
    type: 'pkcs8',
  })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();

  return { key, csr: base64url(request.rawData) };
}
