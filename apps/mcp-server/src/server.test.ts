import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer, SERVER_INFO } from './server';

describe('MCP server', () => {
  it('completes the MCP handshake and identifies itself', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual(SERVER_INFO);
    expect(client.getInstructions()).toContain('Tools are not available yet');
    // No tools are advertised until they exist with authentication (Phase 3).
    expect(client.getServerCapabilities()?.tools).toBeUndefined();

    await client.close();
    await server.close();
  });
});
