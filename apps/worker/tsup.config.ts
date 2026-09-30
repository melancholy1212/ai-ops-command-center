import { defineConfig } from 'tsup';

// Workspace packages are TypeScript source, so they are bundled in; npm dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aoc\//],
  sourcemap: true,
  clean: true,
});
