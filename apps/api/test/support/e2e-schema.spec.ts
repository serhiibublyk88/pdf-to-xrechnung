import { E2E_SCHEMA_PATTERN } from './e2e-schema';

describe('E2E_SCHEMA_PATTERN', () => {
  it('accepts only the isolated e2e schema shape', () => {
    expect(E2E_SCHEMA_PATTERN.test('e2e_')).toBe(false);
    expect(E2E_SCHEMA_PATTERN.test('e2e_not-a-uuid')).toBe(false);
    expect(E2E_SCHEMA_PATTERN.test('public')).toBe(false);
    expect(E2E_SCHEMA_PATTERN.test(`e2e_${'a'.repeat(32)}`)).toBe(true);
  });
});
