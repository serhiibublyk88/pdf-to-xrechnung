import { interFixtureDelayMs } from './eval-pacing';

describe('interFixtureDelayMs', () => {
  it.each(['gemini', 'groq'] as const)(
    'paces remote provider %s',
    (provider) => {
      expect(interFixtureDelayMs(provider)).toBe(60_000);
    },
  );

  it.each(['dataset', 'ollama'] as const)(
    'does not delay local provider %s',
    (provider) => {
      expect(interFixtureDelayMs(provider)).toBe(0);
    },
  );
});
