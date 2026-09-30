import { z } from 'zod';
import type { JsonSchema } from './types';

/**
 * JSON Schema for a Zod contract, as the model sees it: the input side (defaults are optional), draft-07,
 * no $schema key. Refinements are not representable and are enforced by Zod when the answer is validated.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}
