import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

function isHttpErrorsShaped(
  error: unknown,
): error is { statusCode: number; message: string } {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('statusCode' in error) ||
    !('message' in error)
  ) {
    return false;
  }

  return (
    typeof error.statusCode === 'number' &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599 &&
    typeof error.message === 'string'
  );
}

function httpExceptionBody(exception: HttpException): object {
  const projectResponse = exception.getResponse();
  if (typeof projectResponse === 'object' && !('message' in projectResponse)) {
    return projectResponse;
  }
  return { statusCode: exception.getStatus(), message: exception.message };
}

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(HttpExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      this.logRequestFailure(exception.getStatus(), exception);
      response.status(exception.getStatus()).json(httpExceptionBody(exception));
      return;
    }

    if (isHttpErrorsShaped(exception)) {
      this.logRequestFailure(exception.statusCode, exception);
      response.status(exception.statusCode).json({
        statusCode: exception.statusCode,
        message: STATUS_CODES[exception.statusCode] ?? 'Error',
      });
      return;
    }

    this.logger.error({ err: exception }, 'Unhandled request exception');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }

  private logRequestFailure(statusCode: number, exception: unknown): void {
    if (statusCode >= 500) {
      this.logger.error({ err: exception }, 'Request failed');
      return;
    }
    this.logger.debug({ statusCode }, 'Request failed');
  }
}
