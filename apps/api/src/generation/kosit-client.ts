import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { UntrustedBoundaryError } from '../config/log-redaction';
import { fetchBody } from '../http/guarded-fetch';
import { parseKositReport, type KositReportMessage } from './kosit-report';

export class RetryableKositError extends UntrustedBoundaryError {}

export interface KositValidationResult {
  valid: boolean;
  reportXml: string;
  messages: KositReportMessage[];
}

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const MAX_KOSIT_REPORT_BODY_BYTES = 2 * 1024 * 1024;

@Injectable()
export class KositClient {
  private readonly validatorUrl: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<Env, true>) {
    this.validatorUrl = configService.get('KOSIT_VALIDATOR_URL');
    this.timeoutMs = configService.get('KOSIT_REQUEST_TIMEOUT_MS');
  }

  async checkHealth(): Promise<string | null> {
    try {
      const response = await fetch(this.validatorUrl, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      await response.body?.cancel();
      const running =
        response.status === 200 ||
        (response.status >= 400 && response.status < 500);
      return running
        ? null
        : `KoSIT validator responded with HTTP ${response.status}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async validate(xml: string): Promise<KositValidationResult> {
    const { status, body: reportXml } = await fetchBody({
      input: `${this.validatorUrl}/?type=xml`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
      maxBytes: MAX_KOSIT_REPORT_BODY_BYTES,
      onTransportFailure: () =>
        new RetryableKositError('Could not reach the KoSIT validator'),
    });

    const report = parseKositReport(reportXml);
    if (!report) {
      throw new RetryableKositError(
        `KoSIT validator response (HTTP ${status}) was not a readable validation report`,
      );
    }

    return { ...report, reportXml };
  }
}
