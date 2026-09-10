import type { z as MiniZod } from 'zod/mini';

export type ReviewResultZod = Pick<
  typeof MiniZod,
  'discriminatedUnion' | 'literal' | 'null' | 'object' | 'regex' | 'string'
>;

export const lifecycleTokenPattern = /^[0-9a-f]{64}$/;

export function createReviewResultSchema(schema: ReviewResultZod) {
  const lifecycleToken = schema
    .string()
    .check(schema.regex(lifecycleTokenPattern));

  return schema.discriminatedUnion('status', [
    schema.object({
      status: schema.literal('NEEDS_REVIEW'),
      lifecycleToken,
    }),
    schema.object({
      status: schema.literal('GENERATING'),
      lifecycleToken: schema.null(),
    }),
  ]);
}
