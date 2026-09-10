import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { listenOnLoopback } from './support/listen-on-loopback';

describe('Extraction mode (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await listenOnLoopback(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('tells a session-less caller that the mock provider serves demo data', () => {
    return request(app.getHttpServer())
      .get('/extraction-mode')
      .expect(200)
      .expect({ demo: true });
  });
});
