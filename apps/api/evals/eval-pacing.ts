export type EvalProviderMode = 'dataset' | 'gemini' | 'groq' | 'ollama';

export function interFixtureDelayMs(mode: EvalProviderMode): number {
  return mode === 'gemini' || mode === 'groq' ? 60_000 : 0;
}
