import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { KositClient, RetryableKositError } from './kosit-client';

const VALID_REPORT =
  '<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" varlVersion="1.0.0" valid="true"><rep:engine/></rep:report>';
const INVALID_REPORT =
  '<?xml version="1.0" encoding="UTF-8"?><rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1" varlVersion="1.0.0" valid="false"><rep:engine/></rep:report>';

describe('KositClient', () => {
  let client: KositClient;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KositClient,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'KOSIT_VALIDATOR_URL' ? 'http://localhost:8081' : 30_000,
          },
        },
      ],
    }).compile();

    client = module.get(KositClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats the 405 a bare GET gets from the running validator as reachable', async () => {
    fetchMock.mockResolvedValue({ status: 405, body: null });

    await expect(client.checkHealth()).resolves.toBeNull();
  });

  it('reports a validator answering 5xx as unreachable, matching the container probe', async () => {
    fetchMock.mockResolvedValue({ status: 503, body: null });

    await expect(client.checkHealth()).resolves.toBe(
      'KoSIT validator responded with HTTP 503',
    );
  });

  it('reports a KoSIT-clean document as valid', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(VALID_REPORT),
    });

    const validation = await client.validate('<Invoice/>');

    expect(validation).toEqual({
      valid: true,
      reportXml: VALID_REPORT,
      messages: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8081/?type=xml',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<Invoice/>',
      }),
    );
  });

  it('reports a KoSIT rejection as not valid, without throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(INVALID_REPORT),
    });

    const validation = await client.validate('<Invoice/>');

    expect(validation).toEqual({
      valid: false,
      reportXml: INVALID_REPORT,
      messages: [],
    });
  });

  it('reports a KoSIT rejection delivered as a non-2xx status as not valid, without throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 406,
      text: () => Promise.resolve(INVALID_REPORT),
    });

    const validation = await client.validate('<Invoice/>');

    expect(validation).toEqual({
      valid: false,
      reportXml: INVALID_REPORT,
      messages: [],
    });
  });

  it('treats a transport failure as retryable with a safe stable message', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const failure = client.validate('<Invoice/>');
    await expect(failure).rejects.toBeInstanceOf(RetryableKositError);
    await expect(failure).rejects.toThrow(
      'Could not reach the KoSIT validator',
    );
  });

  it('treats a body-read failure as retryable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('terminated')),
    });

    await expect(client.validate('<Invoice/>')).rejects.toBeInstanceOf(
      RetryableKositError,
    );
  });

  it('treats a non-2xx response with no recognizable report as retryable', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(''),
    });

    await expect(client.validate('<Invoice/>')).rejects.toBeInstanceOf(
      RetryableKositError,
    );
  });

  it('treats a report truncated mid-stream as retryable rather than as a rejection', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 406,
      text: () => Promise.resolve(INVALID_REPORT.slice(0, 140)),
    });

    await expect(client.validate('<Invoice/>')).rejects.toBeInstanceOf(
      RetryableKositError,
    );
  });

  it('treats an unparseable response body as retryable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<html>not a report</html>'),
    });

    await expect(client.validate('<Invoice/>')).rejects.toBeInstanceOf(
      RetryableKositError,
    );
  });

  describe('checkHealth', () => {
    it('reports reachable (null) for any response at all, including a 4xx', async () => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      fetchMock.mockResolvedValue({ status: 405, body: { cancel } });

      await expect(client.checkHealth()).resolves.toBeNull();
      expect(cancel).toHaveBeenCalled();
    });

    it('reports the failure reason when the validator is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(client.checkHealth()).resolves.toBe('connect ECONNREFUSED');
    });

    it('never throws, even when fetch rejects with a non-Error value', async () => {
      fetchMock.mockRejectedValue('timeout');

      await expect(client.checkHealth()).resolves.toBe('timeout');
    });
  });
});
