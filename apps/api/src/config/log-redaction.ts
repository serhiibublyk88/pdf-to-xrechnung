import type { LoggerOptions } from 'pino';

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'res.headers["content-disposition"]',
];

export class UntrustedBoundaryError extends Error {
  readonly logExposure = 'type-and-status';
}

function unwrapPinoPreSerializedError(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'raw' in error &&
    error.raw instanceof Error
  ) {
    return error.raw;
  }
  return error;
}

function serializeError(
  errorOrPreSerialized: unknown,
): Record<string, unknown> {
  const error = unwrapPinoPreSerializedError(errorOrPreSerialized);
  if (!(error instanceof Error)) {
    return { type: typeof error };
  }

  const type = error.constructor.name;
  if (error instanceof UntrustedBoundaryError) {
    if ('status' in error && typeof error.status === 'number') {
      return { type, status: error.status };
    }
    return { type };
  }

  const serialized: Record<string, unknown> = {
    type,
    message: error.message,
    stack: error.stack,
  };
  if ('code' in error && typeof error.code === 'string') {
    serialized.code = error.code;
  }
  return serialized;
}

export const LOG_SERIALIZERS = { err: serializeError };

export const LOG_BASE_OPTIONS = {
  redact: LOG_REDACT_PATHS,
  serializers: LOG_SERIALIZERS,
} satisfies LoggerOptions;
