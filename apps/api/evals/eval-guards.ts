const EVAL_SCHEMA_PATTERN = /^eval_[a-f0-9]{32}$/;
const EVAL_QUEUE_PREFIX_PATTERN = /^pdf-to-xrechnung:eval:[a-f0-9]{32}$/;

export function assertEvalSchema(schema: string): void {
  if (!EVAL_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Refusing to drop unexpected database schema: ${schema}`);
  }
}

export function assertEvalQueuePrefix(prefix: string): void {
  if (!EVAL_QUEUE_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Refusing to clear unexpected Redis prefix: ${prefix}`);
  }
}
