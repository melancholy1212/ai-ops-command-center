/**
 * Mints the capability token an agent execution presents to the MCP server (docs/mcp.md): EdDSA-signed,
 * bound to one execution, listing the role's tools and its tool-call cap, valid for at most 30 minutes.
 * Only the worker holds the private key.
 */
import type { AgentType, ExecutionId, RunId, TaskId, ToolName, WorkspaceId } from '@aoc/contracts';
import { importJWK, SignJWT, type JWK } from 'jose';

export interface TokenRequest {
  workspaceId: WorkspaceId;
  runId: RunId;
  taskId: TaskId;
  executionId: ExecutionId;
  agent: AgentType;
  tools: readonly ToolName[];
  maxToolCalls: number;
  ttlSeconds: number;
}

export type TokenMinter = (request: TokenRequest) => Promise<string>;

export async function createTokenMinter(privateJwk: string, now: () => Date = () => new Date()): Promise<TokenMinter> {
  const jwk = JSON.parse(privateJwk) as JWK;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new Error('CAPABILITY_PRIVATE_JWK must be an Ed25519 private key');
  }
  const key = await importJWK(jwk, 'EdDSA');
  return async (request) => {
    const iat = Math.floor(now().getTime() / 1000);
    return new SignJWT({
      wsp: request.workspaceId,
      run: request.runId,
      tsk: request.taskId,
      agt: request.agent,
      tools: [...request.tools],
      maxToolCalls: request.maxToolCalls,
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('aoc-worker')
      .setAudience('aoc-mcp')
      .setSubject(request.executionId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + Math.min(Math.max(request.ttlSeconds, 60), 30 * 60))
      .sign(key);
  };
}
