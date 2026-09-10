import { UntrustedBoundaryError } from '../config/log-redaction';
import { fetchBody } from './guarded-fetch';

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('fetchBody', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the status and complete body on success without calling the factory', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 418,
      text: () => Promise.resolve('complete'),
    });
    const onTransportFailure = jest.fn(
      () => new UntrustedBoundaryError('should not be called'),
    );

    const result = await fetchBody({
      input: 'http://example.test',
      init: {},
      maxBytes: 1_000_000,
      onTransportFailure,
    });

    expect(result).toEqual({ status: 418, body: 'complete' });
    expect(onTransportFailure).not.toHaveBeenCalled();
  });

  it('calls the factory exactly once, with no arguments, and throws its error on a fetch rejection', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('irrelevant'));
    const safeError = new UntrustedBoundaryError('safe transport failure');
    const onTransportFailure = jest.fn(() => safeError);

    await expect(
      fetchBody({
        input: 'http://example.test',
        init: {},
        maxBytes: 1_000_000,
        onTransportFailure,
      }),
    ).rejects.toBe(safeError);
    expect(onTransportFailure).toHaveBeenCalledTimes(1);
    expect(onTransportFailure.mock.calls[0]).toEqual([]);
  });

  it('calls the factory exactly once, with no arguments, and throws its error on a body-read rejection', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.reject(new Error('irrelevant')),
    });
    const safeError = new UntrustedBoundaryError('safe transport failure');
    const onTransportFailure = jest.fn(() => safeError);

    await expect(
      fetchBody({
        input: 'http://example.test',
        init: {},
        maxBytes: 1_000_000,
        onTransportFailure,
      }),
    ).rejects.toBe(safeError);
    expect(onTransportFailure).toHaveBeenCalledTimes(1);
    expect(onTransportFailure.mock.calls[0]).toEqual([]);
  });

  it('does not leak a synthetic secret marker from a rejected Error', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('SYNTHETIC_TRANSPORT_SECRET'));

    const error = await captureRejection(
      fetchBody({
        input: 'http://example.test',
        init: {},
        maxBytes: 1_000_000,
        onTransportFailure: () => new UntrustedBoundaryError('safe message'),
      }),
    );
    expect(error.message).not.toContain('SYNTHETIC_TRANSPORT_SECRET');
  });

  it('does not leak a synthetic secret marker from an arbitrary rejected string', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue('SYNTHETIC_TRANSPORT_SECRET rejected as a raw string');

    const error = await captureRejection(
      fetchBody({
        input: 'http://example.test',
        init: {},
        maxBytes: 1_000_000,
        onTransportFailure: () => new UntrustedBoundaryError('safe message'),
      }),
    );
    expect(error.message).not.toContain('SYNTHETIC_TRANSPORT_SECRET');
  });
});
