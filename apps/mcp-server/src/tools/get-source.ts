import { type GetSourceInput, type GetSourceOutput, type ToolCallId } from '@aoc/contracts';
import { withWorkspace, type DB } from '@aoc/db';
import type { Selectable } from 'kysely';
import type { z } from 'zod';
import { textWindow, ToolFailure, type ToolHandler } from './context';

type Input = z.infer<typeof GetSourceInput>;
type Output = z.infer<typeof GetSourceOutput>;

/** Re-reads a saved snapshot of this workspace, paged. Never re-fetches the live page. */
export const getSource: ToolHandler<Input, { input: Input; source: Selectable<DB['sources']> }> = {
  async prepare(input, scope, services) {
    const source = await withWorkspace(services.db, scope.workspaceId, (tx) =>
      tx.selectFrom('sources').selectAll().where('id', '=', input.sourceId).executeTakeFirst(),
    );
    if (!source) throw new ToolFailure('NOT_FOUND', 'No saved source with this id in this workspace.');
    return { data: { input, source }, provider: null, cacheHit: true, costUsdMicros: 0, upstreamLatencyMs: null };
  },

  persist(_tx, { input, source }, { toolCallId, now }) {
    const output: Output = {
      sourceId: source.id as Output['sourceId'],
      finalUrl: source.final_url,
      title: source.title,
      publishedAt: source.published_at?.toISOString() ?? null,
      retrievedAt: source.retrieved_at.toISOString(),
      contentSha256: source.content_sha256,
      tier: source.tier as Output['tier'],
      flags: source.flags as Output['flags'],
      ...textWindow(source.text, input.offset, input.maxChars),
      provenance: {
        toolCallId: toolCallId as ToolCallId,
        provider: null,
        retrievedAt: now.toISOString(),
        cached: true,
      },
    };
    return Promise.resolve({ output, createdSourceIds: [] });
  },

  render(output: Output) {
    return `Source ${output.sourceId}: ${output.title ?? output.finalUrl}\nCharacters ${String(output.offset)}-${String(output.offset + output.text.length)} of ${String(output.totalChars)}${output.hasMore ? ' (more available)' : ''}\n\n${output.text}`;
  },
};
