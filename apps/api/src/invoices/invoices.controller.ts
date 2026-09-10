import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  InvoiceStatusResult,
  InvoicesService,
  UploadAcceptedResult,
} from './invoices.service';
import { OwnerSessionService } from '../sessions/owner-session.service';

// RFC 5987's attr-char excludes ! ' ( ) *, which encodeURIComponent leaves unescaped.
export function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

@Controller('invoices')
@UseGuards(ThrottlerGuard)
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly ownerSessions: OwnerSessionService,
  ) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadAcceptedResult> {
    if (!file) {
      throw new BadRequestException('No file uploaded under field "file"');
    }
    const ownerId = this.ownerSessions.requireOwnerId(rawCookie);
    const accepted = await this.invoices.ingest({ ownerId, file });
    response.setHeader(
      'Set-Cookie',
      this.ownerSessions.refreshSetCookieHeader(ownerId),
    );
    return accepted;
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async getStatus(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvoiceStatusResult> {
    const ownerId = this.ownerSessions.requireOwnerId(rawCookie);
    const invoice = await this.invoices.findForOwner(id, ownerId);
    if (!invoice) {
      throw new NotFoundException();
    }
    response.setHeader('Cache-Control', 'no-store');
    return invoice;
  }

  @Get(':id/document')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async downloadDocument(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const ownerId = this.ownerSessions.requireOwnerId(rawCookie);
    const document = await this.invoices.getGeneratedDocument(id, ownerId);
    if (!document) {
      throw new NotFoundException();
    }
    response.setHeader('Content-Type', 'application/xml');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${document.filename}"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    return document.xml;
  }

  @Get(':id/source')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async downloadSource(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const source = await this.invoices.getSourceDocument(
      id,
      this.ownerSessions.requireOwnerId(rawCookie),
    );
    if (!source) {
      throw new NotFoundException();
    }
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeRfc5987ValueChars(source.filename)}`,
    );
    response.setHeader('Cache-Control', 'no-store');
    // Nest JSON-serializes a returned Buffer, so it is written to the raw response instead.
    response.send(source.pdf);
  }
}
