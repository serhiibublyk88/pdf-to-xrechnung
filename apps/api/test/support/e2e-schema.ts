export const E2E_SCHEMA_PATTERN = /^e2e_[a-f0-9]{32}$/;

export function e2eSchema(): string {
  const schema = process.env.E2E_DATABASE_SCHEMA;
  if (!schema || !E2E_SCHEMA_PATTERN.test(schema)) {
    throw new Error('E2E_DATABASE_SCHEMA is missing or malformed');
  }
  return schema;
}
