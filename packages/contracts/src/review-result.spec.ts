import { ReviewResultSchema } from './review-result';

describe('ReviewResultSchema', () => {
  it.each([
    { status: 'NEEDS_REVIEW', lifecycleToken: 'a'.repeat(64) },
    { status: 'GENERATING', lifecycleToken: null },
  ])('accepts the legal review response %#', (response) => {
    expect(ReviewResultSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    { status: 'NEEDS_REVIEW', lifecycleToken: null },
    { status: 'GENERATING', lifecycleToken: 'a'.repeat(64) },
  ])('rejects a token/status mismatch %#', (response) => {
    expect(ReviewResultSchema.safeParse(response).success).toBe(false);
  });
});
