import {
  ArgumentsHost,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let logger: { error: jest.Mock; debug: jest.Mock; setContext: jest.Mock };
  let response: { status: jest.Mock; json: jest.Mock };
  let host: ArgumentsHost;

  beforeEach(async () => {
    logger = { error: jest.fn(), debug: jest.fn(), setContext: jest.fn() };
    response = { status: jest.fn(), json: jest.fn() };
    response.status.mockReturnValue(response);
    host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpExceptionFilter,
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();

    filter = module.get(HttpExceptionFilter);
  });

  it('logs a client error at debug level with its status alone', () => {
    filter.catch(new NotFoundException(), host);

    expect(logger.debug).toHaveBeenCalledWith(
      { statusCode: 404 },
      'Request failed',
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Not Found',
    });
  });

  it('logs a server error at error level with the exception itself', () => {
    const exception = new ServiceUnavailableException({
      status: 'unavailable',
      database: 'down',
    });

    filter.catch(exception, host);

    expect(logger.error).toHaveBeenCalledWith(
      { err: exception },
      'Request failed',
    );
    expect(logger.debug).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      status: 'unavailable',
      database: 'down',
    });
  });

  it('logs a framework client error at debug level and replaces its message', () => {
    filter.catch(
      { statusCode: 413, message: 'request entity too large' },
      host,
    );

    expect(logger.debug).toHaveBeenCalledWith(
      { statusCode: 413 },
      'Request failed',
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 413,
      message: 'Payload Too Large',
    });
  });

  it.each([200, 399, 600, Number.NaN, 400.5])(
    'treats a status-shaped error with invalid status %p as unhandled',
    (statusCode) => {
      filter.catch({ statusCode, message: 'synthetic failure' }, host);

      expect(logger.error).toHaveBeenCalledWith(
        { err: { statusCode, message: 'synthetic failure' } },
        'Unhandled request exception',
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith({
        statusCode: 500,
        message: 'Internal server error',
      });
    },
  );

  it.each([{ statusCode: 400 }, { statusCode: 400, message: 123 }])(
    'treats a malformed status-shaped error as unhandled',
    (exception) => {
      filter.catch(exception, host);

      expect(logger.error).toHaveBeenCalledWith(
        { err: exception },
        'Unhandled request exception',
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith({
        statusCode: 500,
        message: 'Internal server error',
      });
    },
  );

  it.each([400, 599])(
    'keeps a status-shaped error with valid status %i reachable',
    (statusCode) => {
      filter.catch({ statusCode, message: 'synthetic failure' }, host);

      expect(response.status).toHaveBeenCalledWith(statusCode);
      expect(response.json).toHaveBeenCalledWith({
        statusCode,
        message: statusCode === 400 ? 'Bad Request' : 'Error',
      });
    },
  );

  it('logs an unknown exception at error level and answers a generic 500', () => {
    const exception = new Error('internal detail');

    filter.catch(exception, host);

    expect(logger.error).toHaveBeenCalledWith(
      { err: exception },
      'Unhandled request exception',
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });
});
