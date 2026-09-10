import { Module } from '@nestjs/common';
import { OwnerSessionService } from './owner-session.service';
import { SessionsController } from './sessions.controller';

@Module({
  controllers: [SessionsController],
  providers: [OwnerSessionService],
  exports: [OwnerSessionService],
})
export class SessionsModule {}
