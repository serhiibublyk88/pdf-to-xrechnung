import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import {
  lifecycleTokenPattern,
  type ReviewResult,
} from '@pdf-to-xrechnung/contracts';
import { OwnerSessionService } from '../sessions/owner-session.service';
import {
  InvoiceDetail,
  InvoiceListItem,
  ReviewService,
} from './review.service';

const ReviewRequestSchema = z
  .object({
    lifecycleToken: z.string().regex(lifecycleTokenPattern),
    correctedData: z.unknown(),
  })
  .strict();

@Controller('invoices')
@UseGuards(ThrottlerGuard)
export class ReviewController {
  constructor(
    private readonly ownerSessions: OwnerSessionService,
    private readonly review: ReviewService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async list(
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvoiceListItem[]> {
    const invoices = await this.review.list(
      this.ownerSessions.requireOwnerId(rawCookie),
    );
    response.setHeader('Cache-Control', 'no-store');
    return invoices;
  }

  @Get(':id/review')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async detail(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvoiceDetail> {
    const invoice = await this.review.detail(
      id,
      this.ownerSessions.requireOwnerId(rawCookie),
    );
    if (!invoice) {
      throw new NotFoundException();
    }
    response.setHeader('Cache-Control', 'no-store');
    return invoice;
  }

  @Post(':id/review')
  @HttpCode(202)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async reviewInvoice(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
    @Body() rawReviewRequest: unknown,
  ): Promise<ReviewResult> {
    const ownerId = this.ownerSessions.requireOwnerId(rawCookie);
    const reviewRequest = ReviewRequestSchema.safeParse(rawReviewRequest);
    if (!reviewRequest.success) {
      throw new BadRequestException('Review request has an invalid shape');
    }
    return this.review.review(
      id,
      ownerId,
      reviewRequest.data.lifecycleToken,
      reviewRequest.data.correctedData,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async deleteInvoice(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
  ): Promise<void> {
    await this.review.deleteInvoice(
      id,
      this.ownerSessions.requireOwnerId(rawCookie),
    );
  }

  @Post(':id/dead-letter/retry')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async retryDeadLetter(
    @Param('id') id: string,
    @Headers('cookie') rawCookie: string | undefined,
  ): Promise<void> {
    await this.review.retryDeadLetter(
      id,
      this.ownerSessions.requireOwnerId(rawCookie),
    );
  }
}
