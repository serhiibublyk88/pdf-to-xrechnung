import type { INestApplication } from '@nestjs/common';

export async function listenOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}
