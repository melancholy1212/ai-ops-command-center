/**
 * Capability tokens (docs/mcp.md#transports-and-authentication): EdDSA-signed JWTs minted by the worker per
 * agent execution. This server holds only the public key, so it can verify tokens but never mint them.
 */
import { CapabilityTokenClaims } from '@aoc/contracts';
import { importJWK, jwtVerify, type JWK } from 'jose';
import type { ToolScope } from './tools/context';

export const MAX_TOKEN_LIFETIME_SECONDS = 30 * 60;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export type TokenVerifier = (token: string) => Promise<ToolScope>;

export async function createTokenVerifier(
  publicJwk: string,
  now: () => Date = () => new Date(),
): Promise<TokenVerifier> {
  const jwk = JSON.parse(publicJwk) as JWK;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || 'd' in jwk) {
    throw new Error('CAPABILITY_PUBLIC_JWK must be an Ed25519 public key (and must not contain the private part)');
  }
  const key = await importJWK(jwk, 'EdDSA');
  return async (token) => {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, key, {
        issuer: 'aoc-worker',
        audience: 'aoc-mcp',
        algorithms: ['EdDSA'],
        currentDate: now(),
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch {
      throw new AuthError('invalid or expired capability token');
    }
    const parsed = CapabilityTokenClaims.safeParse(payload);
    if (!parsed.success) throw new AuthError('malformed capability token');
    const claims = parsed.data;
    if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) throw new AuthError('capability token lives too long');
    return {
      workspaceId: claims.wsp,
      runId: claims.run,
      taskId: claims.tsk,
      executionId: claims.sub,
      agent: claims.agt,
      tools: claims.tools,
      maxToolCalls: claims.maxToolCalls,
    };
  };
}
