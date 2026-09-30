import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, createTokenVerifier, type TokenVerifier } from './auth';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: string;
let verify: TokenVerifier;
const now = new Date('2026-09-30T12:00:00Z');
const iat = Math.floor(now.getTime() / 1000);

const claims = () => ({
  wsp: randomUUID(),
  run: randomUUID(),
  tsk: randomUUID(),
  agt: 'research',
  tools: ['web_search', 'fetch_page'],
  maxToolCalls: 30,
});

async function sign(
  overrides: {
    iss?: string;
    aud?: string;
    iat?: number;
    exp?: number;
    key?: CryptoKey;
    body?: Record<string, unknown>;
  } = {},
) {
  return new SignJWT({ ...claims(), ...overrides.body })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(overrides.iss ?? 'aoc-worker')
    .setAudience(overrides.aud ?? 'aoc-mcp')
    .setSubject(randomUUID())
    .setIssuedAt(overrides.iat ?? iat)
    .setExpirationTime(overrides.exp ?? iat + 900)
    .sign(overrides.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
  publicJwk = JSON.stringify(await exportJWK(pair.publicKey));
  verify = await createTokenVerifier(publicJwk, () => now);
});

describe('capability tokens', () => {
  it('turns a valid token into a tool scope', async () => {
    const scope = await verify(await sign());
    expect(scope).toMatchObject({ agent: 'research', tools: ['web_search', 'fetch_page'], maxToolCalls: 30 });
  });

  it.each([
    ['an expired token', { exp: iat - 1 }],
    ['the wrong issuer', { iss: 'someone-else' }],
    ['the wrong audience', { aud: 'another-service' }],
    ['a token signed by another key', { key: 'other' as const }],
    ['a token that lives longer than 30 minutes', { exp: iat + 3600 }],
    ['a tool outside the contract', { body: { tools: ['send_email'] } }],
  ])('refuses %s', async (_label, overrides) => {
    const { key, ...rest } = { key: undefined, ...overrides } as { key?: 'other' } & Record<string, unknown>;
    const token = await sign({ ...rest, key: key === 'other' ? otherKey : privateKey });
    await expect(verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses unsigned tokens and garbage', async () => {
    const [header, payload] = (await sign()).split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload ?? ''}.`;
    await expect(verify(unsigned)).rejects.toBeInstanceOf(AuthError);
    await expect(verify(`${header ?? ''}.${payload ?? ''}.AAAA`)).rejects.toBeInstanceOf(AuthError);
    await expect(verify('not-a-token')).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses to start with a private key or a non-Ed25519 key', async () => {
    const privateJwk = JSON.stringify(await exportJWK(privateKey));
    await expect(createTokenVerifier(privateJwk)).rejects.toThrow(/must not contain the private part/);
    await expect(createTokenVerifier(JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }))).rejects.toThrow(/Ed25519/);
  });
});
