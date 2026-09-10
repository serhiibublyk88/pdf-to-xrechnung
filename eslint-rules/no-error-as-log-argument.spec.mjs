import assert from 'node:assert/strict';
import test from 'node:test';
import { Linter } from 'eslint';
import projectLogging from './no-error-as-log-argument.mjs';

const RULE = 'project/no-error-as-log-argument';

function lint(code) {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { project: projectLogging },
    rules: { [RULE]: 'error' },
  });
}

test('single-message and object-first log calls pass', () => {
  const messages = lint(
    [
      "logger.error('Storage operation failed');",
      "logger.error({ err, invoiceId }, 'Storage operation failed');",
      "logger.warn({ err }, `Queue ${stage} operation failed`);",
    ].join('\n'),
  );
  assert.deepEqual(messages, []);
});

test('an Error object in the second argument is rejected', () => {
  const messages = lint("logger.error('Storage operation failed', error);");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('an error message in the second argument is rejected because Nest drops it', () => {
  const messages = lint(
    "logger.error('Redis connection failed', error.message);",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('an object-first call still requires a literal message second', () => {
  const messages = lint("logger.error({ err }, error);");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('unrelated methods are ignored', () => {
  const messages = lint("metrics.error('operation', error);");
  assert.deepEqual(messages, []);
});

test('a single-argument template literal interpolating an error is rejected', () => {
  const messages = lint(
    'logger.error(`KoSIT readiness check failed: ${kositError}`);',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('a single-argument template literal interpolating a member-expression error is rejected', () => {
  const messages = lint('logger.warn(`Retry failed: ${job.err}`);');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('a single-argument template literal interpolating a non-error value stays legal', () => {
  const messages = lint(
    'logger.warn(`Ignoring invalid stored failure data for invoice ${invoiceId}`);',
  );
  assert.deepEqual(messages, []);
});

test('a single-argument template literal with no interpolation stays legal', () => {
  const messages = lint('logger.error(`Storage operation failed`);');
  assert.deepEqual(messages, []);
});

test('a single-argument non-template-literal call is not inspected by this heuristic', () => {
  const messages = lint('logger.error(error);');
  assert.deepEqual(messages, []);
});

test('a template literal interpolating a property of an error is rejected', () => {
  const messages = lint('logger.error(`Extraction failed: ${error.message}`);');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('a template literal interpolating a stringified error is rejected', () => {
  const messages = lint('logger.error(`Extraction failed: ${String(error)}`);');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('a template literal message beside structured fields is rejected when it interpolates an error', () => {
  const messages = lint(
    'logger.error({ invoiceId }, `Extraction failed: ${error}`);',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('fatal calls are inspected like error and warn', () => {
  const messages = lint('logger.fatal(`Bootstrap failed: ${error}`);');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE);
});

test('a structured fatal call stays legal', () => {
  const messages = lint("logger.fatal({ err }, 'Failed to start application');");
  assert.deepEqual(messages, []);
});

test('a template literal interpolating a non-error property stays legal', () => {
  const messages = lint('logger.warn(`Skipped ${batch.length} invoices`);');
  assert.deepEqual(messages, []);
});
