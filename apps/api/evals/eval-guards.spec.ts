import { assertEvalQueuePrefix, assertEvalSchema } from './eval-guards';

describe('assertEvalSchema', () => {
  it('accepts only the isolated evaluation schema shape', () => {
    expect(() => assertEvalSchema(`eval_${'a'.repeat(32)}`)).not.toThrow();
    expect(() => assertEvalSchema('public')).toThrow(
      'Refusing to drop unexpected database schema',
    );
    expect(() => assertEvalSchema('eval_')).toThrow(
      'Refusing to drop unexpected database schema',
    );
  });
});

describe('assertEvalQueuePrefix', () => {
  it('accepts only the isolated evaluation queue prefix shape', () => {
    expect(() =>
      assertEvalQueuePrefix(`pdf-to-xrechnung:eval:${'a'.repeat(32)}`),
    ).not.toThrow();
    expect(() => assertEvalQueuePrefix('pdf-to-xrechnung')).toThrow(
      'Refusing to clear unexpected Redis prefix',
    );
    expect(() =>
      assertEvalQueuePrefix(`pdf-to-xrechnung:e2e:${'a'.repeat(32)}`),
    ).toThrow('Refusing to clear unexpected Redis prefix');
  });
});
