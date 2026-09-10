import { createHealthRedisClient } from './health.module';

describe('createHealthRedisClient', () => {
  it('registers an error listener so a down Redis logs instead of writing to raw stderr', () => {
    const client = createHealthRedisClient(
      { get: () => 'redis://localhost:6379' },
      { error: jest.fn(), setContext: jest.fn() },
    );
    try {
      expect(client.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });
});
