import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { isLegalPostgresSchemaName, type Env } from '../config/env.schema';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService<Env, true>) {
    const databaseUrl = new URL(configService.get('DATABASE_URL'));
    const schema = databaseUrl.searchParams.get('schema') ?? 'public';
    if (!isLegalPostgresSchemaName(schema)) {
      throw new Error('Invalid PostgreSQL schema name');
    }
    databaseUrl.searchParams.delete('schema');
    super({
      adapter: new PrismaPg(
        { connectionString: databaseUrl.toString() },
        { schema },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
