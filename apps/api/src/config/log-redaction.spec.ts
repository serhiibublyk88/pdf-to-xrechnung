import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { z } from 'zod';
import {
  LOG_REDACT_PATHS,
  LOG_SERIALIZERS,
  UntrustedBoundaryError,
} from './log-redaction';

class ProviderStatusError extends UntrustedBoundaryError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe('LOG_SERIALIZERS against real pino', () => {
  it('keeps the message, stack and code of a system error', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ serializers: LOG_SERIALIZERS }, sink);
    const error = Object.assign(new Error('disk unavailable'), { code: 'EIO' });

    logger.error({ err: error }, 'Storage operation failed');

    const entry = z
      .object({
        err: z.object({
          type: z.string(),
          code: z.string(),
          message: z.string(),
          stack: z.string(),
        }),
      })
      .parse(JSON.parse(chunks[0] ?? ''));
    expect(entry.err.type).toBe('Error');
    expect(entry.err.code).toBe('EIO');
    expect(entry.err.message).toBe('disk unavailable');
    expect(entry.err.stack).toContain('Error: disk unavailable');
  });

  it('keeps only the type and status of an untrusted-boundary error', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ serializers: LOG_SERIALIZERS }, sink);
    const error = new ProviderStatusError(
      'provider echoed customer invoice Project Phoenix.pdf',
      413,
    );

    logger.error({ err: error }, 'Provider request failed');

    const entry = z
      .object({ err: z.unknown() })
      .parse(JSON.parse(chunks[0] ?? ''));
    expect(entry.err).toEqual({ type: 'ProviderStatusError', status: 413 });
    expect(JSON.stringify(entry)).not.toContain('Project Phoenix.pdf');
  });

  it('does not stringify a non-Error rejection value', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ serializers: LOG_SERIALIZERS }, sink);

    logger.error(
      { err: 'provider echoed customer invoice Project Phoenix.pdf' },
      'Provider request failed',
    );

    const entry = z
      .object({ err: z.unknown() })
      .parse(JSON.parse(chunks[0] ?? ''));
    expect(entry.err).toEqual({ type: 'string' });
    expect(JSON.stringify(entry)).not.toContain('Project Phoenix.pdf');
  });
});

describe('LOG_SERIALIZERS against a real pino-http request-scoped logger', () => {
  async function logThroughRequestScope(
    logCall: (requestLogger: {
      error: (obj: unknown, msg: string) => void;
    }) => void,
  ): Promise<Record<string, unknown>[]> {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const httpLogger = pinoHttp({ serializers: LOG_SERIALIZERS }, sink);

    const server = createServer((request, response) => {
      httpLogger(request, response);
      logCall(request.log);
      response.end('ok');
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      await fetch(`http://127.0.0.1:${port}/`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    return chunks.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('keeps the message, stack and code of a system error logged through the request scope', async () => {
    const error = Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    const entries = await logThroughRequestScope((requestLogger) =>
      requestLogger.error({ err: error }, 'Storage operation failed'),
    );

    const entry = z
      .object({
        msg: z.literal('Storage operation failed'),
        err: z.object({
          type: z.string(),
          code: z.string(),
          message: z.string(),
          stack: z.string(),
        }),
      })
      .parse(entries.find((line) => line.msg === 'Storage operation failed'));
    expect(entry.err.type).toBe('Error');
    expect(entry.err.code).toBe('EIO');
    expect(entry.err.message).toBe('disk unavailable');
    expect(entry.err.stack).toContain('Error: disk unavailable');
  });

  it('keeps only the type and status of an untrusted-boundary error logged through the request scope', async () => {
    const error = new ProviderStatusError(
      'provider echoed customer invoice Project Phoenix.pdf',
      413,
    );
    const entries = await logThroughRequestScope((requestLogger) =>
      requestLogger.error({ err: error }, 'Provider request failed'),
    );

    const entry = z
      .object({ msg: z.literal('Provider request failed'), err: z.unknown() })
      .parse(entries.find((line) => line.msg === 'Provider request failed'));
    expect(entry.err).toEqual({ type: 'ProviderStatusError', status: 413 });
    expect(JSON.stringify(entries)).not.toContain('Project Phoenix.pdf');
  });
});

describe('LOG_REDACT_PATHS against a real pino-http request/response', () => {
  it('redacts the bearer token, request cookie, response Set-Cookie and response filename', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: LOG_REDACT_PATHS }, sink);
    const httpLogger = pinoHttp({ logger });

    const server = createServer((request, response) => {
      httpLogger(request, response);
      response.setHeader('Set-Cookie', 'session=owner-session-token; HttpOnly');
      response.setHeader(
        'Content-Disposition',
        "inline; filename*=UTF-8''invoice-with-customer-name.pdf",
      );
      response.end('ok');
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          authorization: 'Bearer super-secret-bearer-token',
          cookie: 'sid=owner-session-cookie-value',
        },
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const entries = chunks.map((line) => JSON.parse(line) as unknown);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('super-secret-bearer-token');
    expect(serialized).not.toContain('owner-session-cookie-value');
    expect(serialized).not.toContain('owner-session-token');
    expect(serialized).not.toContain('invoice-with-customer-name.pdf');

    const completedRequest = entries.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && 'res' in entry,
    );
    expect(completedRequest).toMatchObject({
      req: {
        headers: { authorization: '[Redacted]', cookie: '[Redacted]' },
      },
      res: {
        headers: {
          'set-cookie': '[Redacted]',
          'content-disposition': '[Redacted]',
        },
      },
    });
  });
});
