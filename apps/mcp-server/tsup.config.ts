import { defineConfig } from 'tsup';

// Two entry points: the HTTP service (index) and the stdio transport for local MCP clients.
export default defineConfig({
  entry: ['src/index.ts', 'src/stdio.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aoc\//],
  sourcemap: true,
  clean: true,
});
