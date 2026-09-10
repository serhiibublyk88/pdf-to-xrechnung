import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { UntrustedBoundaryError } from '../../src/config/log-redaction';
import { fetchBody } from '../../src/http/guarded-fetch';

class SafeTestError extends UntrustedBoundaryError {}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('expected an Error rejection');
  }
  throw new Error('expected the promise to reject');
}

function listenerPort(server: HttpServer | NetServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected an IP listener address');
  }
  return address.port;
}

function listenHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: HttpServer; url: string }> {
  const server = createHttpServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = listenerPort(server);
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function listenRaw(
  onConnection: (socket: Socket) => void,
): Promise<{ server: NetServer; url: string; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = listenerPort(server);
      resolve({ server, url: `http://127.0.0.1:${port}/`, sockets });
    });
  });
}

function closeRaw(server: NetServer, sockets: Socket[]): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

const PARTIAL_RESPONSE =
  'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial';

const GENEROUS_MAX_BYTES = 1_000_000;

describe('fetchBody real Node stream lifecycle', () => {
  it('returns the exact status and complete body for a non-2xx response', async () => {
    const { server, url } = await listenHttp((_req, res) => {
      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('complete body');
    });
    try {
      const result = await fetchBody({
        input: url,
        init: {},
        maxBytes: GENEROUS_MAX_BYTES,
        onTransportFailure: () => new SafeTestError('should not be called'),
      });
      expect(result).toEqual({ status: 418, body: 'complete body' });
    } finally {
      await closeHttp(server);
    }
  });

  it('wraps a socket cut after partial headers+body as the consumer-owned error, not a partial body or native TypeError', async () => {
    const { server, url, sockets } = await listenRaw((socket) => {
      socket.write(PARTIAL_RESPONSE, () => socket.destroy());
    });
    try {
      const failure = fetchBody({
        input: url,
        init: {},
        maxBytes: GENEROUS_MAX_BYTES,
        onTransportFailure: () => new SafeTestError('safe cut'),
      });
      await expect(failure).rejects.toBeInstanceOf(SafeTestError);
      await expect(failure).rejects.toThrow('safe cut');
    } finally {
      await closeRaw(server, sockets);
    }
  });

  it('wraps a controlled AbortController.abort() during a stalled body as the consumer-owned error', async () => {
    const controller = new AbortController();
    const { server, url, sockets } = await listenRaw((socket) => {
      socket.write(PARTIAL_RESPONSE);
    });
    try {
      const failure = fetchBody({
        input: url,
        init: { signal: controller.signal },
        maxBytes: GENEROUS_MAX_BYTES,
        onTransportFailure: () => new SafeTestError('safe abort'),
      });

      for (let tick = 0; tick < 200; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      controller.abort();
      await expect(failure).rejects.toBeInstanceOf(SafeTestError);
      await expect(failure).rejects.toThrow('safe abort');
    } finally {
      await closeRaw(server, sockets);
    }
  });

  it('does not leak URL credentials from a real Node fetch rejection', async () => {
    const failure = fetchBody({
      input: 'http://synthetic-user:SYNTHETIC_URL_SECRET@127.0.0.1:1/',
      init: {},
      maxBytes: GENEROUS_MAX_BYTES,
      onTransportFailure: () => new SafeTestError('safe credential failure'),
    });
    await expect(failure).rejects.toBeInstanceOf(SafeTestError);
    const error = await captureRejection(failure);
    expect(error.message).not.toContain('SYNTHETIC_URL_SECRET');
  });

  it('rejects a body exceeding the configured byte cap with the consumer-owned error instead of buffering it complete', async () => {
    const oversizedBody = 'x'.repeat(1_000);
    const { server, url } = await listenHttp((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(oversizedBody);
    });
    try {
      const failure = fetchBody({
        input: url,
        init: {},
        maxBytes: 20,
        onTransportFailure: () => new SafeTestError('safe body too large'),
      });
      await expect(failure).rejects.toBeInstanceOf(SafeTestError);
      await expect(failure).rejects.toThrow('safe body too large');
    } finally {
      await closeHttp(server);
    }
  });

  it('reads a body under the cap complete and decodes multi-byte UTF-8 characters correctly', async () => {
    const germanText = 'Rechnungsprüfung: Größe, Anzahl äöüß — Betrag € 123,45';
    const byteLength = Buffer.byteLength(germanText, 'utf8');
    const { server, url } = await listenHttp((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(germanText);
    });
    try {
      const result = await fetchBody({
        input: url,
        init: {},
        maxBytes: byteLength,
        onTransportFailure: () => new SafeTestError('should not be called'),
      });
      expect(result).toEqual({ status: 200, body: germanText });
    } finally {
      await closeHttp(server);
    }
  });
});
