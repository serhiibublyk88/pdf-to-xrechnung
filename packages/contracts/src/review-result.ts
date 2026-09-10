import {
  discriminatedUnion,
  literal,
  null as nullSchema,
  object,
  regex,
  string,
} from 'zod/mini';
import type { infer as ZodInfer } from 'zod/mini';
import {
  createReviewResultSchema,
  lifecycleTokenPattern,
} from './review-result-definition';

export { lifecycleTokenPattern };

export const ReviewResultSchema = createReviewResultSchema({
  discriminatedUnion,
  literal,
  null: nullSchema,
  object,
  regex,
  string,
});

export type ReviewResult = ZodInfer<typeof ReviewResultSchema>;
